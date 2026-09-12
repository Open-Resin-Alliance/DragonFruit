import * as THREE from 'three';

import type { BezierSegment, Knot, Leaf, Twig } from './types';
import type { SupportData } from './rendering';
import type { BracePreviewData } from './SupportTypes/Brace/bracePlacementState';
import type { ContactDiskProfile } from './SupportPrimitives/ContactCone/types';
import type { InstancedShaft } from './SupportPrimitives/Shaft/InstancedShaftGroup';
import type { InstancedJoint } from './SupportPrimitives/Joint/InstancedJointGroup';
import type { InstancedRoot } from './SupportPrimitives/Roots/InstancedRootsGroup';
import type { InstancedContactCone } from './SupportPrimitives/ContactCone/InstancedContactConeGroup';
import { resolveTwigDiameterAtSegmentT } from './SupportTypes/Twig/twigTaper';
import { bezierSegmentToBatchedShaft } from './Curves/batchedBezierShaft';
import { getFinalSocketPosition } from './SupportPrimitives/ContactCone/contactConeUtils';
import { calculateDiskThickness } from './SupportPrimitives/ContactDisk/contactDiskUtils';
import { getAutoBracingSettings } from './Settings/state';

/**
 * Geometry for the translucent preview shown while placing a support.
 *
 * Extracted from SupportRenderer so it can be tested without a React harness:
 * none of it touches hooks, refs or JSX -- it turns support data into instanced
 * primitives, which is arithmetic.
 */

export interface Vec3Like { x: number; y: number; z: number; }

export type PlacementSurface = 'interior' | 'exterior';

export type InteriorContactPoint = {
    pos: Vec3Like;
    placementSurface?: PlacementSurface;
};

export type InteriorContactFilter = (
    contact: InteriorContactPoint | null | undefined,
    modelId?: string,
) => boolean;

export interface PlacementPreviewTaperedShaft {
    id: string;
    start: Vec3Like;
    end: Vec3Like;
    diameterStart: number;
    diameterEnd: number;
}

export interface PlacementPreviewDisk {
    id: string;
    pos: Vec3Like;
    surfaceNormal: Vec3Like;
    coneAxis: Vec3Like;
    profile: ContactDiskProfile;
    contactDiameterMm: number;
    diskLengthOverride?: number;
}

export interface PlacementPreviewBatch {
    id: string;
    color: string;
    opacity: number;
    shafts: InstancedShaft[];
    taperedShafts: PlacementPreviewTaperedShaft[];
    disks: PlacementPreviewDisk[];
    joints: InstancedJoint[];
    roots: InstancedRoot[];
    cones: InstancedContactCone[];
}

export const PLACEMENT_PREVIEW_COLOR = '#00ff00';
export const PLACEMENT_PREVIEW_ERROR_COLOR = '#ff0000';
export const PLACEMENT_PREVIEW_WARNING_COLOR = '#ffcc00';
export const PLACEMENT_PREVIEW_ORANGE_COLOR = '#c7722f';
export const PLACEMENT_PREVIEW_OPACITY = 0.5;
export const PLACEMENT_PREVIEW_ERROR_OPACITY = 0.15;

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

    // If the parent knot sits on a tapered twig, the leaf's wide-end diameter
    // (bodyDiameterMm) must live-track the twig's local diameter at the knot's
    // current slide T. Otherwise the cone "neck" stays frozen at the placement
    // diameter while the knot visibly grows/shrinks.
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

export function resolvePlacementPreviewMaterial(preview: SupportData): { color: string; opacity: number } {
    if (preview.error) {
        return {
            color: PLACEMENT_PREVIEW_ERROR_COLOR,
            opacity: PLACEMENT_PREVIEW_ERROR_OPACITY,
        };
    }

    // Leaf previews have a knot + contactCone but no shaft segments. The
    // surface-steepness gradient is calibrated for trunk-style placements;
    // for leaves the angle has the opposite semantic and always resolves to
    // orange. Treat leaves like trunks/branches and fall through to the
    const isLeafPreview = preview.segments.length === 0 && !!preview.knot && !!preview.contactCone;

    let angle = isLeafPreview ? undefined : preview.angle;
    if (!isLeafPreview && angle === undefined && preview.contactCone) {
        const normal = new THREE.Vector3(
            preview.contactCone.normal.x,
            preview.contactCone.normal.y,
            preview.contactCone.normal.z,
        );
        const up = new THREE.Vector3(0, 0, 1);
        angle = normal.angleTo(up) * (180 / Math.PI);
    }

    if (angle !== undefined) {
        const startAngle = 91;
        const midAngle = 120;
        const endAngle = 180;

        let finalColor: THREE.Color;
        if (angle <= midAngle) {
            const t = Math.max(0, (angle - startAngle) / (midAngle - startAngle));
            const c1 = new THREE.Color(PLACEMENT_PREVIEW_ORANGE_COLOR);
            const c2 = new THREE.Color(PLACEMENT_PREVIEW_WARNING_COLOR);
            finalColor = c1.lerp(c2, t);
        } else {
            const t = Math.min(1, (angle - midAngle) / (endAngle - midAngle));
            const c1 = new THREE.Color(PLACEMENT_PREVIEW_WARNING_COLOR);
            const c2 = new THREE.Color(PLACEMENT_PREVIEW_COLOR);
            finalColor = c1.lerp(c2, t);
        }

        return {
            color: `#${finalColor.getHexString()}`,
            opacity: PLACEMENT_PREVIEW_OPACITY,
        };
    }

    if (preview.warning) {
        return {
            color: PLACEMENT_PREVIEW_WARNING_COLOR,
            opacity: PLACEMENT_PREVIEW_OPACITY,
        };
    }

    return {
        color: PLACEMENT_PREVIEW_COLOR,
        opacity: PLACEMENT_PREVIEW_OPACITY,
    };
}

export function buildSupportPlacementPreviewBatch(
    id: string,
    preview: SupportData,
    hasSolidBottom: boolean,
    raftThickness: number,
): PlacementPreviewBatch | null {
    const shafts: InstancedShaft[] = [];
    const taperedShafts: PlacementPreviewTaperedShaft[] = [];
    const disks: PlacementPreviewDisk[] = [];
    const jointsMap = new Map<string, InstancedJoint>();
    const roots: InstancedRoot[] = [];
    const cones: InstancedContactCone[] = [];

    // Twig placements carry two ContactDisks (one per end). The disks define
    // the rod's true per-end diameters; segment.diameter is a placeholder.
    // Use the disk contact diameters to draw a tapered shaft so the preview
    // matches what the finished twig will look like.
    const twigDiskA = preview.contactDisks && preview.contactDisks.length === 2 ? preview.contactDisks[0] : null;
    const twigDiskB = preview.contactDisks && preview.contactDisks.length === 2 ? preview.contactDisks[1] : null;
    const isTwigPreview = !!(twigDiskA && twigDiskB);

    if (preview.contactDisks) {
        for (const disk of preview.contactDisks) {
            disks.push({
                id: disk.id,
                pos: disk.pos,
                surfaceNormal: disk.surfaceNormal,
                coneAxis: disk.coneAxis,
                profile: disk.profile,
                contactDiameterMm: disk.contactDiameterMm,
                diskLengthOverride: disk.diskLengthOverride,
            });
        }
    }

    let currentStart: THREE.Vector3;

    if (preview.roots) {
        const root = preview.roots;
        const basePos = new THREE.Vector3(root.transform.pos.x, root.transform.pos.y, root.transform.pos.z);
        const effectiveDiskHeight = Math.max(0.001, root.diskHeight);
        const verticalOffset = 0;
        const shaftDiameter = Math.max(0.001, preview.segments[0]?.diameter ?? root.diameter);

        roots.push({
            id: root.id,
            supportId: id,
            modelId: root.modelId,
            basePos: {
                x: basePos.x,
                y: basePos.y,
                z: basePos.z + verticalOffset,
            },
            bottomRadius: Math.max(0.001, root.diameter / 2),
            topRadius: shaftDiameter / 2,
            effectiveDiskHeight,
            coneHeight: Math.max(0, root.coneHeight),
        });

        currentStart = basePos.clone().add(new THREE.Vector3(0, 0, verticalOffset + effectiveDiskHeight + Math.max(0, root.coneHeight)));
    } else if (preview.startPos) {
        currentStart = new THREE.Vector3(preview.startPos.x, preview.startPos.y, preview.startPos.z);
    } else if (preview.contactCones && preview.contactCones.length > 0) {
        const socketPos = getFinalSocketPosition(preview.contactCones[0]);
        currentStart = new THREE.Vector3(socketPos.x, socketPos.y, socketPos.z);
    } else if (preview.contactCone) {
        const socketPos = getFinalSocketPosition(preview.contactCone);
        currentStart = new THREE.Vector3(socketPos.x, socketPos.y, socketPos.z);
    } else if (preview.segments[0]?.bottomJoint) {
        const p = preview.segments[0].bottomJoint.pos;
        currentStart = new THREE.Vector3(p.x, p.y, p.z);
    } else {
        currentStart = new THREE.Vector3(0, 0, 0);
    }

    if (preview.knot) {
        // Leaves carry preview.knot but have no shaft segments â€” without
        // including the knot here the preview's parent ball is invisible
        // when snapping a leaf onto another support (trunk, twig, etc.).
        jointsMap.set(preview.knot.id, {
            id: preview.knot.id,
            pos: preview.knot.pos,
            diameter: Math.max(0.001, preview.knot.diameter ?? ((preview.segments[0]?.diameter ?? 1) + 0.1)),
            supportId: id,
        });
    }

    for (const segment of preview.segments) {
        if (segment.bottomJoint) {
            jointsMap.set(segment.bottomJoint.id, {
                id: segment.bottomJoint.id,
                pos: segment.bottomJoint.pos,
                diameter: segment.bottomJoint.diameter,
                supportId: id,
            });
        }
        if (segment.topJoint) {
            jointsMap.set(segment.topJoint.id, {
                id: segment.topJoint.id,
                pos: segment.topJoint.pos,
                diameter: segment.topJoint.diameter,
                supportId: id,
            });
        }
    }

    // Twig taper: precompute per-segment start/end diameters lerped along the
    // cumulative-length parameter so a multi-segment twig still presents one
    // continuous Aâ†’B taper.
    let twigSegmentDiameters: Array<{ start: number; end: number }> | null = null;
    if (isTwigPreview) {
        const segLengths: number[] = [];
        let total = 0;
        for (const seg of preview.segments) {
            const a = seg.bottomJoint?.pos;
            const b = seg.topJoint?.pos;
            if (!a || !b) { segLengths.push(0); continue; }
            const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
            segLengths.push(len);
            total += len;
        }
        twigSegmentDiameters = [];
        const dA = twigDiskA!.contactDiameterMm;
        const dB = twigDiskB!.contactDiameterMm;
        let cursor = 0;
        for (let i = 0; i < preview.segments.length; i++) {
            const sStart = total > 1e-8 ? cursor / total : 0;
            cursor += segLengths[i];
            const sEnd = total > 1e-8 ? cursor / total : 1;
            twigSegmentDiameters.push({
                start: dA + (dB - dA) * sStart,
                end: dA + (dB - dA) * sEnd,
            });
        }
    }

    const lastSegmentIndex = preview.segments.length - 1;
    preview.segments.forEach((segment, index) => {
        if (segment.bottomJoint) {
            currentStart = new THREE.Vector3(segment.bottomJoint.pos.x, segment.bottomJoint.pos.y, segment.bottomJoint.pos.z);
        }

        let endPoint: THREE.Vector3;
        if (segment.topJoint) {
            endPoint = new THREE.Vector3(segment.topJoint.pos.x, segment.topJoint.pos.y, segment.topJoint.pos.z);
        } else if (preview.contactCone && index === lastSegmentIndex) {
            const socketPos = getFinalSocketPosition(preview.contactCone);
            endPoint = new THREE.Vector3(socketPos.x, socketPos.y, socketPos.z);
        } else if (preview.contactCones && preview.contactCones.length > 0 && index === lastSegmentIndex) {
            const socketPos = getFinalSocketPosition(preview.contactCones[preview.contactCones.length - 1]);
            endPoint = new THREE.Vector3(socketPos.x, socketPos.y, socketPos.z);
        } else {
            endPoint = currentStart.clone().add(new THREE.Vector3(0, 0, 10));
        }

        if (segment.type === 'bezier') {
            shafts.push(
                bezierSegmentToBatchedShaft(
                    segment as BezierSegment,
                    { x: currentStart.x, y: currentStart.y, z: currentStart.z },
                    { x: endPoint.x, y: endPoint.y, z: endPoint.z },
                    id,
                ),
            );
        } else if (twigSegmentDiameters) {
            const dia = twigSegmentDiameters[index];
            taperedShafts.push({
                id: segment.id,
                start: { x: currentStart.x, y: currentStart.y, z: currentStart.z },
                end: { x: endPoint.x, y: endPoint.y, z: endPoint.z },
                diameterStart: dia.start,
                diameterEnd: dia.end,
            });
        } else {
            shafts.push({
                id: segment.id,
                start: { x: currentStart.x, y: currentStart.y, z: currentStart.z },
                end: { x: endPoint.x, y: endPoint.y, z: endPoint.z },
                diameter: segment.diameter,
                supportId: id,
            });
        }

        currentStart = endPoint;
    });

    const allCones = preview.contactCones?.length
        ? preview.contactCones
        : preview.contactCone
            ? [preview.contactCone]
            : [];

    allCones.forEach((cone, index) => {
        cones.push({
            id: cone.id ?? `${id}:cone:${index}`,
            supportId: id,
            pos: cone.pos,
            normal: cone.normal,
            surfaceNormal: cone.surfaceNormal,
            diskLengthOverride: cone.diskLengthOverride,
            profile: cone.profile,
        });
    });

    if (shafts.length === 0 && taperedShafts.length === 0 && disks.length === 0 && jointsMap.size === 0 && roots.length === 0 && cones.length === 0) {
        return null;
    }

    const { color, opacity } = resolvePlacementPreviewMaterial(preview);
    return {
        id,
        color,
        opacity,
        shafts,
        taperedShafts,
        disks,
        joints: Array.from(jointsMap.values()),
        roots,
        cones,
    };
}

export function buildBracePlacementPreviewBatch(id: string, preview: BracePreviewData): PlacementPreviewBatch | null {
    const start = preview.start;
    const end = preview.end;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const dz = end.z - start.z;
    const lenSq = dx * dx + dy * dy + dz * dz;
    const braceDia = getAutoBracingSettings().braceDiameterMm;
    const startDiameter = Math.min(braceDia, Math.max(0.001, preview.startDiameterMm));
    const endDiameter = Math.min(braceDia, Math.max(0.001, preview.endDiameterMm));
    const knotStartDiameter = Math.max(0.001, preview.startDiameterMm + 0.1);
    const knotEndDiameter = Math.max(0.001, preview.endDiameterMm + 0.1);

    const joints: InstancedJoint[] = [
        {
            id: `${id}:start-joint`,
            pos: start,
            diameter: knotStartDiameter,
            supportId: id,
        },
    ];

    const shafts: InstancedShaft[] = [];
    const taperedShafts: PlacementPreviewTaperedShaft[] = [];
    if (lenSq >= 1e-6) {
        if (Math.abs(startDiameter - endDiameter) > 1e-4) {
            taperedShafts.push({
                id: `${id}:shaft`,
                start,
                end,
                diameterStart: startDiameter,
                diameterEnd: endDiameter,
            });
        } else {
            shafts.push({
                id: `${id}:shaft`,
                start,
                end,
                diameter: (startDiameter + endDiameter) / 2,
                supportId: id,
            });
        }

        joints.push({
            id: `${id}:end-joint`,
            pos: end,
            diameter: knotEndDiameter,
            supportId: id,
        });
    }

    return {
        id,
        color: PLACEMENT_PREVIEW_COLOR,
        opacity: PLACEMENT_PREVIEW_OPACITY,
        shafts,
        taperedShafts,
        disks: [],
        joints,
        roots: [],
        cones: [],
    };
}
