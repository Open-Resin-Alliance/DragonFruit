import type { BezierSegment, Vec3 } from '../types';
import type { InstancedShaft } from '../SupportPrimitives/Shaft/InstancedShaftGroup';

type Vec3Like = { x: number; y: number; z: number };

const toPlainVec3 = (v: Vec3Like): Vec3 => ({ x: v.x, y: v.y, z: v.z });

/**
 * Represent a bezier segment as a single curved batched-shaft entry.
 * InstancedShaftGroup renders curved entries as smooth merged tubes (visual
 * parity with the detailed BezierRenderer); straight entries stay instanced
 * cylinders.
 */
export function bezierSegmentToBatchedShaft(
    segment: BezierSegment,
    startPos: Vec3Like,
    endPos: Vec3Like,
    supportId: string,
    modelId?: string,
): InstancedShaft {
    return {
        id: segment.id,
        start: toPlainVec3(startPos),
        end: toPlainVec3(endPos),
        diameter: segment.diameter,
        supportId,
        modelId,
        controlPoint1: toPlainVec3(segment.controlPoint1),
        controlPoint2: toPlainVec3(segment.controlPoint2),
        resolution: segment.resolution,
    };
}

export function braceBezierToBatchedShaft(
    segmentId: string,
    startPos: Vec3Like,
    endPos: Vec3Like,
    controlPoint1: Vec3Like,
    controlPoint2: Vec3Like,
    diameter: number,
    resolution: number | undefined,
    supportId: string,
    modelId?: string,
): InstancedShaft {
    return {
        id: segmentId,
        start: toPlainVec3(startPos),
        end: toPlainVec3(endPos),
        diameter,
        supportId,
        modelId,
        controlPoint1: toPlainVec3(controlPoint1),
        controlPoint2: toPlainVec3(controlPoint2),
        resolution,
    };
}
