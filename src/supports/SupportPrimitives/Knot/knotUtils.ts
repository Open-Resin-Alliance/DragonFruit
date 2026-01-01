import * as THREE from 'three';
import { Branch, Knot, Roots, Segment, Trunk, Vec3 } from '../../types';
import { getFinalSocketPosition } from '../ContactCone';
import { getSettingsSnapshot } from '../../Settings';
import { getBezierPointAtT } from '../../Curves/BezierUtils';

export function projectOntoSegment(
    ray: THREE.Ray,
    start: THREE.Vector3,
    end: THREE.Vector3
): { point: Vec3; t: number } {
    const pointOnSegment = new THREE.Vector3();
    const pointOnRay = new THREE.Vector3();
    ray.distanceSqToSegment(start, end, pointOnRay, pointOnSegment);

    const segLength = start.distanceTo(end);
    const t = segLength > 0 ? start.distanceTo(pointOnSegment) / segLength : 0;

    return {
        point: { x: pointOnSegment.x, y: pointOnSegment.y, z: pointOnSegment.z },
        t: Math.min(1, Math.max(0, t)),
    };
}

export function getTrunkSegmentEndpoints(
    trunk: Trunk,
    segment: Segment,
    segmentIndex: number,
    root: Roots | undefined
): { start: Vec3; end: Vec3 } | null {
    if (!root) return null;

    const settings = getSettingsSnapshot();
    const baseFlare = settings.baseFlare;
    const rootsSettings = settings.roots;

    const basePos = new THREE.Vector3(
        root.transform.pos.x,
        root.transform.pos.y,
        root.transform.pos.z
    );

    const diskHeight = rootsSettings.diskHeightMm;
    const coneHeight = baseFlare.enabled ? baseFlare.heightMm : (root.height || 1.5);
    const effectiveConeHeight = baseFlare.enabled ? coneHeight : 0;

    let startVec: THREE.Vector3;
    if (segmentIndex === 0) {
        startVec = basePos.clone().add(new THREE.Vector3(0, 0, diskHeight + effectiveConeHeight));
    } else {
        const prev = trunk.segments[segmentIndex - 1];
        if (prev.topJoint) {
            startVec = new THREE.Vector3(prev.topJoint.pos.x, prev.topJoint.pos.y, prev.topJoint.pos.z);
        } else {
            // fallback to base if missing joint
            startVec = basePos.clone().add(new THREE.Vector3(0, 0, diskHeight + effectiveConeHeight));
        }
    }

    let endVec: THREE.Vector3;
    if (segment.topJoint) {
        endVec = new THREE.Vector3(segment.topJoint.pos.x, segment.topJoint.pos.y, segment.topJoint.pos.z);
    } else if (trunk.contactCone) {
        const socketPos = getFinalSocketPosition(trunk.contactCone);
        endVec = new THREE.Vector3(socketPos.x, socketPos.y, socketPos.z);
    } else {
        endVec = startVec.clone().add(new THREE.Vector3(0, 0, 10));
    }

    return {
        start: { x: startVec.x, y: startVec.y, z: startVec.z },
        end: { x: endVec.x, y: endVec.y, z: endVec.z },
    };
}

export function getBranchSegmentEndpoints(
    branch: Branch,
    segment: Segment,
    segmentIndex: number,
    parentKnot: Knot | undefined
): { start: Vec3; end: Vec3 } | null {
    if (!parentKnot) return null;

    let startVec: THREE.Vector3;
    if (segmentIndex === 0) {
        startVec = new THREE.Vector3(parentKnot.pos.x, parentKnot.pos.y, parentKnot.pos.z);
    } else {
        const prev = branch.segments[segmentIndex - 1];
        if (prev.topJoint) {
            startVec = new THREE.Vector3(prev.topJoint.pos.x, prev.topJoint.pos.y, prev.topJoint.pos.z);
        } else {
            startVec = new THREE.Vector3(parentKnot.pos.x, parentKnot.pos.y, parentKnot.pos.z);
        }
    }

    let endVec: THREE.Vector3;
    if (segment.topJoint) {
        endVec = new THREE.Vector3(segment.topJoint.pos.x, segment.topJoint.pos.y, segment.topJoint.pos.z);
    } else if (branch.contactCone) {
        const socketPos = getFinalSocketPosition(branch.contactCone);
        endVec = new THREE.Vector3(socketPos.x, socketPos.y, socketPos.z);
    } else {
        endVec = startVec.clone().add(new THREE.Vector3(0, 0, 10));
    }

    return {
        start: { x: startVec.x, y: startVec.y, z: startVec.z },
        end: { x: endVec.x, y: endVec.y, z: endVec.z },
    };
}

/**
 * Calculate the position of a knot along a segment using its t parameter (0-1).
 * This is used to update knot positions when the parent segment moves.
 */
export function calculateKnotPositionFromT(
    start: Vec3,
    end: Vec3,
    t: number
): Vec3 {
    const clampedT = Math.min(1, Math.max(0, t));
    return {
        x: start.x + (end.x - start.x) * clampedT,
        y: start.y + (end.y - start.y) * clampedT,
        z: start.z + (end.z - start.z) * clampedT,
    };
}

/**
 * Calculate the position of a knot along a specific segment.
 * For straight segments we interpolate between endpoints.
 * For bezier segments we evaluate the cubic curve using the segment control points.
 */
export function calculateKnotPositionOnSegmentFromT(
    start: Vec3,
    end: Vec3,
    segment: Segment,
    t: number
): Vec3 {
    const clampedT = Math.min(1, Math.max(0, t));

    if (segment.type === 'bezier') {
        return getBezierPointAtT(
            start,
            segment.controlPoint1,
            segment.controlPoint2,
            end,
            clampedT
        );
    }

    return calculateKnotPositionFromT(start, end, clampedT);
}
