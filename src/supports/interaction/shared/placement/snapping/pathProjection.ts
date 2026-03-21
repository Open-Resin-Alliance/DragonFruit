import * as THREE from 'three';
import type { SnapTarget } from '../../../SnappingManager';
import type { Vec3 } from '../../../../types';

export type SnapPath = NonNullable<SnapTarget['pathSegment']>;

export interface SnapPathProjection {
    t: number;
    pos: Vec3;
    distSq: number;
}

function toVector3(v: Vec3): THREE.Vector3 {
    return new THREE.Vector3(v.x, v.y, v.z);
}

export function getSnapPathPointAtT(path: SnapPath, t: number): Vec3 {
    const clampedT = THREE.MathUtils.clamp(t, 0, 1);

    if (path.bezier) {
        const start = toVector3(path.start);
        const control1 = toVector3(path.bezier.control1);
        const control2 = toVector3(path.bezier.control2);
        const end = toVector3(path.end);
        const curve = new THREE.CubicBezierCurve3(start, control1, control2, end);
        const point = curve.getPoint(clampedT);
        return { x: point.x, y: point.y, z: point.z };
    }

    const start = toVector3(path.start);
    const end = toVector3(path.end);
    const point = start.lerp(end, clampedT);
    return { x: point.x, y: point.y, z: point.z };
}

export function projectPointToSnapPath(point: Vec3, path: SnapPath): SnapPathProjection {
    const pointVec = toVector3(point);

    if (path.bezier) {
        const start = toVector3(path.start);
        const control1 = toVector3(path.bezier.control1);
        const control2 = toVector3(path.bezier.control2);
        const end = toVector3(path.end);

        const curve = new THREE.CubicBezierCurve3(start, control1, control2, end);
        const steps = 60;

        let bestT = 0;
        let bestPos = curve.getPoint(0);
        let bestDistSq = bestPos.distanceToSquared(pointVec);

        for (let i = 1; i <= steps; i += 1) {
            const t = i / steps;
            const sample = curve.getPoint(t);
            const distSq = sample.distanceToSquared(pointVec);
            if (distSq < bestDistSq) {
                bestT = t;
                bestPos = sample;
                bestDistSq = distSq;
            }
        }

        return {
            t: bestT,
            pos: { x: bestPos.x, y: bestPos.y, z: bestPos.z },
            distSq: bestDistSq,
        };
    }

    const start = toVector3(path.start);
    const end = toVector3(path.end);
    const segment = end.clone().sub(start);
    const segmentLenSq = segment.lengthSq();

    if (segmentLenSq < 1e-8) {
        return {
            t: 0,
            pos: path.start,
            distSq: start.distanceToSquared(pointVec),
        };
    }

    const projectedT = THREE.MathUtils.clamp(pointVec.clone().sub(start).dot(segment) / segmentLenSq, 0, 1);
    const projectedPoint = start.clone().add(segment.multiplyScalar(projectedT));

    return {
        t: projectedT,
        pos: { x: projectedPoint.x, y: projectedPoint.y, z: projectedPoint.z },
        distSq: projectedPoint.distanceToSquared(pointVec),
    };
}

export function projectRayToSnapPath(ray: THREE.Ray, path: SnapPath): SnapPathProjection {
    if (path.bezier) {
        const start = toVector3(path.start);
        const control1 = toVector3(path.bezier.control1);
        const control2 = toVector3(path.bezier.control2);
        const end = toVector3(path.end);

        const curve = new THREE.CubicBezierCurve3(start, control1, control2, end);
        const steps = 60;

        let bestT = 0;
        let bestPos = curve.getPoint(0);
        let bestDistSq = ray.distanceSqToPoint(bestPos);

        for (let i = 1; i <= steps; i += 1) {
            const t = i / steps;
            const sample = curve.getPoint(t);
            const distSq = ray.distanceSqToPoint(sample);
            if (distSq < bestDistSq) {
                bestT = t;
                bestPos = sample;
                bestDistSq = distSq;
            }
        }

        return {
            t: bestT,
            pos: { x: bestPos.x, y: bestPos.y, z: bestPos.z },
            distSq: bestDistSq,
        };
    }

    const start = toVector3(path.start);
    const end = toVector3(path.end);
    const segment = end.clone().sub(start);
    const segmentLenSq = segment.lengthSq();

    if (segmentLenSq < 1e-8) {
        return {
            t: 0,
            pos: path.start,
            distSq: ray.distanceSqToPoint(start),
        };
    }

    const pointOnSegment = new THREE.Vector3();
    const distSq = ray.distanceSqToSegment(start, end, undefined, pointOnSegment);
    const projectedT = THREE.MathUtils.clamp(pointOnSegment.clone().sub(start).dot(segment) / segmentLenSq, 0, 1);

    return {
        t: projectedT,
        pos: { x: pointOnSegment.x, y: pointOnSegment.y, z: pointOnSegment.z },
        distSq,
    };
}

export function projectPointToSnapTargetPath(target: SnapTarget, point: Vec3): SnapPathProjection | null {
    if (!target.pathSegment) return null;
    return projectPointToSnapPath(point, target.pathSegment);
}

export function projectRayToSnapTargetPath(ray: THREE.Ray, target: SnapTarget): SnapPathProjection | null {
    if (!target.pathSegment) return null;
    return projectRayToSnapPath(ray, target.pathSegment);
}

export function selectNearestPathTarget(point: Vec3, candidates: readonly SnapTarget[]): SnapTarget | null {
    let bestTarget: SnapTarget | null = null;
    let bestDistSq = Number.POSITIVE_INFINITY;

    for (const candidate of candidates) {
        const projected = projectPointToSnapTargetPath(candidate, point);
        if (!projected) continue;
        if (projected.distSq < bestDistSq) {
            bestDistSq = projected.distSq;
            bestTarget = candidate;
        }
    }

    return bestTarget;
}
