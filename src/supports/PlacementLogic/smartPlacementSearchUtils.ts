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

export function getLengthAwareMaxAngleFromVerticalDeg(
    segmentLengthMm: number,
    baseMaxAngleFromVerticalDeg: number
): number {
    if (segmentLengthMm <= LENGTH_AWARE_UPPER_SPAN_TIGHTEN_START_MM) {
        return baseMaxAngleFromVerticalDeg;
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
