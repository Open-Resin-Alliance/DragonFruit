import { Vec3 } from '../types';

export interface SearchNode {
    pos: Vec3;
    joints: Vec3[];
    totalLength: number;
    totalLateral: number;
    verticalDrop: number;
    bestSnapDistance: number;
}

export interface CandidateNode {
    pos: Vec3;
    score: number;
}

export interface QueuedNode extends SearchNode {
    score: number;
}

export interface RouteEvaluationMetrics {
    score: number;
    jointCount: number;
    snapDistance: number;
    totalLateral: number;
    totalLength: number;
    verticalDrop: number;
}

export interface BestCostEntry {
    score: number;
    totalLength: number;
    totalLateral: number;
    verticalDrop: number;
    bestSnapDistance: number;
    jointCount: number;
}

const POSITION_KEY_MM = 0.5;

export function distanceXY(a: Vec3, b: Vec3): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
}

export function distance3D(a: Vec3, b: Vec3): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function segmentAngleFromHorizontalDeg(start: Vec3, end: Vec3): number {
    const horizontal = distanceXY(start, end);
    const verticalDrop = start.z - end.z;
    if (verticalDrop <= 0) return -Infinity;
    return Math.atan2(verticalDrop, Math.max(horizontal, 0.0001)) * (180 / Math.PI);
}

export function segmentAngleFromVerticalDeg(start: Vec3, end: Vec3): number {
    const angleFromHorizontal = segmentAngleFromHorizontalDeg(start, end);
    if (!Number.isFinite(angleFromHorizontal)) {
        return Number.POSITIVE_INFINITY;
    }
    return 90 - angleFromHorizontal;
}

export function segmentSatisfiesMaxAngleFromVertical(start: Vec3, end: Vec3, maxAngleFromVerticalDeg: number): boolean {
    return segmentAngleFromVerticalDeg(start, end) <= maxAngleFromVerticalDeg;
}

const LENGTH_AWARE_UPPER_SPAN_TIGHTEN_START_MM = 5;
const LENGTH_AWARE_UPPER_SPAN_MIN_MAX_ANGLE_FROM_VERTICAL_DEG = 15;
const LENGTH_AWARE_UPPER_SPAN_TIGHTEN_DEGREES_PER_MM = 3;
// Short-span detour slack: segments this short may bend up to the routing
// detour angle (the old A* exploration budget) even when the trunk's base
// angle is tighter. Local detours around bumps/crowns are geometrically
// impossible within the base trunk angle (the clearance envelope around an
// obstacle is locally steeper than any fixed cap), and a short strut segment
// at 60° is mechanically sound. Long spans keep the existing tightening.
export const SHORT_SPAN_DETOUR_MAX_LENGTH_MM = 3;
export const SHORT_SPAN_DETOUR_MAX_ANGLE_FROM_VERTICAL_DEG = 60;

export function getLengthAwareMaxAngleFromVerticalDeg(
    segmentLengthMm: number,
    baseMaxAngleFromVerticalDeg: number
): number {
    const shortSpanMaxAngle = Math.max(
        baseMaxAngleFromVerticalDeg,
        SHORT_SPAN_DETOUR_MAX_ANGLE_FROM_VERTICAL_DEG,
    );

    if (segmentLengthMm <= SHORT_SPAN_DETOUR_MAX_LENGTH_MM) {
        return shortSpanMaxAngle;
    }

    if (segmentLengthMm <= LENGTH_AWARE_UPPER_SPAN_TIGHTEN_START_MM) {
        // Taper from the detour slack back to the base angle.
        const t = (segmentLengthMm - SHORT_SPAN_DETOUR_MAX_LENGTH_MM)
            / (LENGTH_AWARE_UPPER_SPAN_TIGHTEN_START_MM - SHORT_SPAN_DETOUR_MAX_LENGTH_MM);
        return shortSpanMaxAngle + (baseMaxAngleFromVerticalDeg - shortSpanMaxAngle) * t;
    }

    const excessLength = segmentLengthMm - LENGTH_AWARE_UPPER_SPAN_TIGHTEN_START_MM;
    const tightened = baseMaxAngleFromVerticalDeg - excessLength * LENGTH_AWARE_UPPER_SPAN_TIGHTEN_DEGREES_PER_MM;
    return Math.max(
        LENGTH_AWARE_UPPER_SPAN_MIN_MAX_ANGLE_FROM_VERTICAL_DEG,
        Math.min(baseMaxAngleFromVerticalDeg, tightened),
    );
}

export function segmentSatisfiesLengthAwareMaxAngleFromVertical(
    start: Vec3,
    end: Vec3,
    baseMaxAngleFromVerticalDeg: number
): boolean {
    const segmentLengthMm = distance3D(start, end);
    const allowedMaxAngle = getLengthAwareMaxAngleFromVerticalDeg(segmentLengthMm, baseMaxAngleFromVerticalDeg);
    return segmentSatisfiesMaxAngleFromVertical(start, end, allowedMaxAngle);
}

// Socket elbow: the FIRST chain segment below the contact-cone socket may form
// a short, steep "elbow" to dodge small obstacles directly under the tip —
// the standard shape mainstream mSLA slicers emit. Longer first segments fall
// back to the regular length-aware rule.
export const SOCKET_ELBOW_MAX_LENGTH_MM = 2.5;
export const SOCKET_ELBOW_MAX_ANGLE_FROM_VERTICAL_DEG = 75;

export function firstSegmentSatisfiesSocketElbowMaxAngle(
    start: Vec3,
    end: Vec3,
    baseMaxAngleFromVerticalDeg: number
): boolean {
    const segmentLengthMm = distance3D(start, end);
    if (segmentLengthMm <= SOCKET_ELBOW_MAX_LENGTH_MM) {
        const allowedMaxAngle = Math.max(
            getLengthAwareMaxAngleFromVerticalDeg(segmentLengthMm, baseMaxAngleFromVerticalDeg),
            SOCKET_ELBOW_MAX_ANGLE_FROM_VERTICAL_DEG,
        );
        return segmentSatisfiesMaxAngleFromVertical(start, end, allowedMaxAngle);
    }
    return segmentSatisfiesLengthAwareMaxAngleFromVertical(start, end, baseMaxAngleFromVerticalDeg);
}

export function chainSatisfiesLengthAwareUpperSpanRule(
    points: Vec3[],
    baseMaxAngleFromVerticalDeg: number
): boolean {
    if (points.length < 3) {
        return true;
    }

    for (let i = 0; i < points.length - 1; i++) {
        if (!segmentSatisfiesLengthAwareMaxAngleFromVertical(points[i], points[i + 1], baseMaxAngleFromVerticalDeg)) {
            return false;
        }
    }

    return true;
}

export function positionKey(pos: Vec3): string {
    const qx = Math.round(pos.x / POSITION_KEY_MM);
    const qy = Math.round(pos.y / POSITION_KEY_MM);
    const qz = Math.round(pos.z / POSITION_KEY_MM);
    return `${qx},${qy},${qz}`;
}

export function queueSortValue(node: QueuedNode): number {
    return node.score + node.joints.length * 12 + node.bestSnapDistance * 8 - node.verticalDrop * 2;
}

export function isBetterSearchState(candidate: BestCostEntry, current: BestCostEntry | undefined): boolean {
    if (!current) {
        return true;
    }
    if (candidate.score < current.score - 0.000001) {
        return true;
    }
    if (Math.abs(candidate.score - current.score) > 0.000001) {
        return false;
    }
    if (candidate.bestSnapDistance < current.bestSnapDistance - 0.000001) {
        return true;
    }
    if (Math.abs(candidate.bestSnapDistance - current.bestSnapDistance) > 0.000001) {
        return false;
    }
    if (candidate.verticalDrop > current.verticalDrop + 0.000001) {
        return true;
    }
    if (Math.abs(candidate.verticalDrop - current.verticalDrop) > 0.000001) {
        return false;
    }
    if (candidate.totalLateral < current.totalLateral - 0.000001) {
        return true;
    }
    if (Math.abs(candidate.totalLateral - current.totalLateral) > 0.000001) {
        return false;
    }
    if (candidate.jointCount < current.jointCount) {
        return true;
    }
    if (candidate.jointCount > current.jointCount) {
        return false;
    }
    return candidate.totalLength < current.totalLength - 0.000001;
}
