import React from 'react';
import type { Knot, Leaf, Twig } from '../../types';
import { subscribeSupportInteractionReset } from '../../interaction/supportInteractionReset';
import { resolveTwigDiameterAtSegmentT, twigJointDiameterForLocalDiameter } from './twigTaper';
import { calculateDiskThickness } from '../../SupportPrimitives/ContactDisk/contactDiskUtils';
import { calculateKnotPositionOnSegmentFromT } from '../../SupportPrimitives/Knot/knotUtils';

const EVENT_NAME = 'dragonfruit-twig-drag-preview';

// Carries the live twig (during disk drag) plus the per-knot / per-leaf
// updates needed for attached leaves to follow the twig's new geometry.
export interface TwigDragPreviewSnapshot {
    twigId: string;
    twig: Twig;
    // Knots whose parentShaftId points at one of this twig's segments. Their
    // pos is re-projected onto the new segment endpoints (keeping the knot's
    // existing t) and diameter is resized to the new local twig taper.
    knotsById: Record<string, Knot>;
    // Leaves attached to those knots. Their contact cone's wide-end follows
    // the new local twig diameter, and the cone axis/length follow the new
    // knot pos.
    leavesById: Record<string, Leaf>;
}

export function emitTwigDragPreview(snapshot: TwigDragPreviewSnapshot) {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent<TwigDragPreviewSnapshot>(EVENT_NAME, { detail: snapshot }));
}

export function clearTwigDragPreview() {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent<TwigDragPreviewSnapshot | null>(EVENT_NAME, { detail: null }));
}

export function useActiveTwigDragPreview() {
    const [preview, setPreview] = React.useState<TwigDragPreviewSnapshot | null>(null);

    React.useEffect(() => {
        if (typeof window === 'undefined') return;

        const handlePreview = (event: Event) => {
            const detail = (event as CustomEvent<TwigDragPreviewSnapshot | null>).detail;
            setPreview(detail ?? null);
        };

        window.addEventListener(EVENT_NAME, handlePreview as EventListener);
        const unsubscribeReset = subscribeSupportInteractionReset(() => {
            setPreview(null);
        });

        return () => {
            unsubscribeReset();
            window.removeEventListener(EVENT_NAME, handlePreview as EventListener);
        };
    }, []);

    return preview;
}

/**
 * Given a live twig and the set of attached knots / leaves, produce the
 * updated knot + leaf records so they track the twig's new geometry.
 *
 * Knot pos is re-projected onto its segment using the knot's existing t.
 * Knot diameter scales to the new local twig taper × 1.10 (twig joint rule).
 * Leaf cone axis/length re-anchor to the new knot pos; cone bodyDiameterMm
 * follows the new local twig diameter.
 */
export function computeTwigDragAttachmentUpdates(
    nextTwig: Twig,
    attachedKnots: Knot[],
    leavesByParentKnotId: Map<string, Leaf[]>,
): { knotsById: Record<string, Knot>; leavesById: Record<string, Leaf> } {
    const segmentsById = new Map<string, Twig['segments'][number]>();
    for (const seg of nextTwig.segments) segmentsById.set(seg.id, seg);

    const knotsById: Record<string, Knot> = {};
    const leavesById: Record<string, Leaf> = {};

    for (const knot of attachedKnots) {
        const seg = segmentsById.get(knot.parentShaftId);
        if (!seg?.bottomJoint?.pos || !seg?.topJoint?.pos) continue;
        if (knot.t === undefined) continue;

        const t = Math.max(0, Math.min(1, knot.t));
        // Bezier-aware: when the segment is curved, evaluate the curve at t
        // instead of lerping along the straight chord. Without this, attached
        // leaf knots stay on the chord while the twig curves away.
        const newPos = calculateKnotPositionOnSegmentFromT(seg.bottomJoint.pos, seg.topJoint.pos, seg, t);

        const localTwigDia = resolveTwigDiameterAtSegmentT(nextTwig, seg.id, t);
        const newDiameter = localTwigDia !== null
            ? twigJointDiameterForLocalDiameter(localTwigDia)
            : knot.diameter;

        const nextKnot: Knot = {
            ...knot,
            pos: newPos,
            diameter: newDiameter,
        };
        knotsById[knot.id] = nextKnot;

        const attachedLeaves = leavesByParentKnotId.get(knot.id);
        if (!attachedLeaves || attachedLeaves.length === 0) continue;

        for (const leaf of attachedLeaves) {
            const cone = leaf.contactCone;
            if (!cone) continue;

            // Re-anchor the cone axis/length from the tip (model surface) to
            // the new knot pos. Tip stays put; the wide end follows the knot.
            const tipX = cone.pos.x;
            const tipY = cone.pos.y;
            const tipZ = cone.pos.z;
            const sn = cone.surfaceNormal ?? cone.normal;

            let ax = newPos.x - tipX;
            let ay = newPos.y - tipY;
            let az = newPos.z - tipZ;
            let len = Math.sqrt(ax * ax + ay * ay + az * az);
            if (len < 1e-6) {
                ax = sn.x; ay = sn.y; az = sn.z;
                len = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
            }
            ax /= len; ay /= len; az /= len;

            // Iterate disk-thickness compensation a couple of times so the
            // cone's true length (knot − offset surface) stabilizes.
            let finalLen = Math.max(0.1, len);
            for (let i = 0; i < 3; i++) {
                const thickness = cone.profile.type === 'disk' && cone.surfaceNormal
                    ? calculateDiskThickness(cone.surfaceNormal, { x: ax, y: ay, z: az }, cone.profile)
                    : 0;
                const startX = tipX + sn.x * thickness;
                const startY = tipY + sn.y * thickness;
                const startZ = tipZ + sn.z * thickness;
                const dx = newPos.x - startX;
                const dy = newPos.y - startY;
                const dz = newPos.z - startZ;
                const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (l > 1e-6) {
                    ax = dx / l; ay = dy / l; az = dz / l;
                    finalLen = Math.max(0.1, l);
                }
            }

            const nextBodyDiameterMm = localTwigDia ?? cone.profile.bodyDiameterMm;

            leavesById[leaf.id] = {
                ...leaf,
                contactCone: {
                    ...cone,
                    normal: { x: ax, y: ay, z: az },
                    profile: {
                        ...cone.profile,
                        lengthMm: finalLen,
                        bodyDiameterMm: nextBodyDiameterMm,
                    },
                },
            };
        }
    }

    return { knotsById, leavesById };
}
