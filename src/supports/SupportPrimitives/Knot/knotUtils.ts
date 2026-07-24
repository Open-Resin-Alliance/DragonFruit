import * as THREE from 'three';
import { Branch, Knot, Roots, Segment, Trunk, Vec3 } from '../../types';
import { getFinalSocketPosition } from '../ContactCone';
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

    const basePos = new THREE.Vector3(
        root.transform.pos.x,
        root.transform.pos.y,
        root.transform.pos.z
    );

    const diskHeight = Number.isFinite(root.diskHeight as number) ? (root.diskHeight as number) : 0;
    const coneHeight = Number.isFinite(root.coneHeight as number)
        ? (root.coneHeight as number)
        : Number.isFinite((root as any).height as number)
            ? ((root as any).height as number)
            : 0;
    const rootTopZ = diskHeight + coneHeight;

    let startVec: THREE.Vector3;
    if (segment.bottomJoint) {
        startVec = new THREE.Vector3(segment.bottomJoint.pos.x, segment.bottomJoint.pos.y, segment.bottomJoint.pos.z);
    } else if (segmentIndex === 0) {
        startVec = basePos.clone().add(new THREE.Vector3(0, 0, rootTopZ));
    } else {
        const prev = trunk.segments[segmentIndex - 1];
        if (prev.topJoint) {
            startVec = new THREE.Vector3(prev.topJoint.pos.x, prev.topJoint.pos.y, prev.topJoint.pos.z);
        } else {
            // fallback to base if missing joint
            startVec = basePos.clone().add(new THREE.Vector3(0, 0, rootTopZ));
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
 * Decide whether a dragged knot should stay on its current segment or hand off
 * to the closest neighbouring segment.
 *
 * While dragging a knot along a multi-segment shaft, each frame picks the
 * segment whose curve is closest to the pointer ray. A small stickiness bias
 * keeps the knot on its current segment when distances are near-equal, which
 * stops flicker mid-segment. That bias must NOT apply when the current
 * segment's closest point has saturated at one of its endpoints (i.e. right at
 * a joint): there the neighbour's closest point also starts at the same joint,
 * so a blanket bias would pin the knot to the joint and refuse to cross until
 * the neighbour won by more than the bias margin. That is the "knot hangs on
 * the joint" bug (only intermittent because whether the neighbour ever wins by
 * the margin depends on the camera angle).
 *
 * @param currentT projected t of the pointer on the CURRENT segment (0..1)
 * @param currentDistSq squared ray distance to the current segment
 * @param bestDistSq squared ray distance to the closest segment found so far
 * @param stickiness multiplicative bias (>= 1); current wins if currentDistSq <= bestDistSq * stickiness
 * @param interiorEps t within this of 0 or 1 counts as "at a joint end"
 * @returns true to keep the knot on the current segment, false to allow handoff
 */
export function shouldStayOnCurrentSegment(
    currentT: number,
    currentDistSq: number,
    bestDistSq: number,
    stickiness: number,
    interiorEps: number
): boolean {
    const interior = currentT > interiorEps && currentT < 1 - interiorEps;
    if (!interior) return false;
    return currentDistSq <= bestDistSq * stickiness;
}

/**
 * A minimal patch describing how a knot re-anchors when its host segment is
 * split in two by an inserted joint. `parentShaftId` moves to the top segment
 * only when the knot sat above the split; `t` is always rescaled onto whichever
 * half the knot now lives on so its absolute world position is preserved.
 */
export interface KnotSplitRemap {
    knotId: string;
    parentShaftId: string;
    t: number;
}

/**
 * Re-anchor a knot across a segment split so it stays at the same world point.
 *
 * When a joint is inserted at parametric position `splitT` on the original
 * segment, that segment becomes a bottom half (keeps the original id) and a top
 * half (new id). A knot's stored `t` is expressed against the WHOLE original
 * segment, so after the split it must be converted to the sub-segment it now
 * belongs to. De Casteljau subdivision guarantees the original curve at `t`
 * equals the left sub-curve at `t / splitT` (for t <= splitT) and the right
 * sub-curve at `(t - splitT) / (1 - splitT)` (for t >= splitT). The same
 * reparametrization holds for straight segments (the degenerate cubic case), so
 * one formula covers both.
 *
 * Returns null when the knot is not attached to the split segment, has no `t`,
 * or the split is too degenerate to remap safely (the caller leaves it as-is).
 */
export function remapKnotAcrossSplit(
    knot: Knot,
    originalSegmentId: string,
    bottomSegmentId: string,
    topSegmentId: string,
    splitT: number
): KnotSplitRemap | null {
    if (knot.parentShaftId !== originalSegmentId) return null;
    if (knot.t === undefined) return null;
    // Guard degenerate splits: a split at t≈0 or t≈1 leaves one half with zero
    // span, making the rescale divide by ~0. Leaving the knot on the bottom
    // segment (which keeps the original id) is the stable no-op.
    const EPS = 1e-6;
    if (!(splitT > EPS) || !(splitT < 1 - EPS)) return null;

    const t = Math.min(1, Math.max(0, knot.t));

    if (t <= splitT) {
        return { knotId: knot.id, parentShaftId: bottomSegmentId, t: t / splitT };
    }
    return {
        knotId: knot.id,
        parentShaftId: topSegmentId,
        t: (t - splitT) / (1 - splitT),
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
