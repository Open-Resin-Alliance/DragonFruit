import * as THREE from 'three';

import { calculateDiskThickness } from '../../SupportPrimitives/ContactDisk/contactDiskUtils';
import { resolveTwigDiameterAtSegmentT } from '../Twig/twigTaper';
import type { Knot, Leaf, Twig } from '../../types';

/**
 * A leaf's contact cone, re-derived against a knot that has moved: the cone
 * re-aims at the knot, its length becomes the knot-to-tip distance, and its
 * wide end tracks the host's diameter there. Returns the same leaf when nothing
 * moved, so a still frame does not churn the render list.
 */
export function recomputeLeafPreviewContactCone(
    leaf: Leaf,
    previewKnot: Knot,
    twigBySegmentId: Map<string, Twig>,
) {
    const cone = leaf.contactCone;
    if (!cone?.surfaceNormal) return leaf;

    const previewKnotPos = previewKnot.pos;
    const tip = new THREE.Vector3(cone.pos.x, cone.pos.y, cone.pos.z);
    const sn = new THREE.Vector3(cone.surfaceNormal.x, cone.surfaceNormal.y, cone.surfaceNormal.z);
    const knot = new THREE.Vector3(previewKnotPos.x, previewKnotPos.y, previewKnotPos.z);

    let axis = knot.clone().sub(tip);
    if (axis.lengthSq() < 0.000001) {
        axis.set(sn.x, sn.y, sn.z);
    }
    axis.normalize();

    let finalLength = Math.max(0.1, knot.distanceTo(tip));

    for (let i = 0; i < 3; i++) {
        const axisVec3 = { x: axis.x, y: axis.y, z: axis.z };
        const thickness = cone.profile.type === 'disk'
            ? calculateDiskThickness(cone.surfaceNormal, axisVec3, cone.profile)
            : 0;

        const start = tip.clone().add(sn.clone().multiplyScalar(thickness));
        const coneVec = knot.clone().sub(start);
        const len = coneVec.length();
        if (len > 0.000001) {
            axis = coneVec.normalize();
            finalLength = Math.max(0.1, len);
        }
    }

    // On a tapered host, the wide end tracks the host's local diameter at the
    // knot's slide T, or the neck stays frozen while the knot visibly changes size.
    let nextBodyDiameterMm = cone.profile.bodyDiameterMm;
    const hostTwig = previewKnot.parentShaftId ? twigBySegmentId.get(previewKnot.parentShaftId) : undefined;
    if (hostTwig && previewKnot.t !== undefined) {
        const localTwigDia = resolveTwigDiameterAtSegmentT(hostTwig, previewKnot.parentShaftId, previewKnot.t);
        if (localTwigDia !== null) {
            nextBodyDiameterMm = localTwigDia;
        }
    }

    const oldNormal = cone.normal;
    const oldLen = cone.profile.lengthMm;
    const oldBodyDia = cone.profile.bodyDiameterMm;
    if (
        oldLen === finalLength
        && oldBodyDia === nextBodyDiameterMm
        && oldNormal.x === axis.x
        && oldNormal.y === axis.y
        && oldNormal.z === axis.z
    ) {
        return leaf;
    }

    return {
        ...leaf,
        contactCone: {
            ...cone,
            normal: { x: axis.x, y: axis.y, z: axis.z },
            profile: {
                ...cone.profile,
                lengthMm: finalLength,
                bodyDiameterMm: nextBodyDiameterMm,
            },
        },
    };
}
