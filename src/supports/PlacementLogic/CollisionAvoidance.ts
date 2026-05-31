import * as THREE from 'three';
import { Vec3 } from '../types';
import { checkShaftCollision } from './CollisionUtils';
import { SDFCache } from './Pathfinding/SDFCache';

const sdfCacheByMeshUuid = new Map<string, SDFCache>();
const DEFAULT_FRUSTUM_SEGMENT_COUNT = 5;

export interface CollisionFrustumProfile {
    startRadius: number;
    endRadius: number;
    segmentCount?: number;
}

function getOrCreateCollisionSdf(mesh: THREE.Mesh): SDFCache | null {
    const geometry = mesh.geometry as any;
    if (!geometry?.boundsTree) {
        return null;
    }

    const existing = sdfCacheByMeshUuid.get(mesh.uuid);
    if (existing) {
        existing.refreshMatrix();
        return existing;
    }

    const sdf = new SDFCache(mesh, { cellSize: 0.25 });
    sdf.refreshMatrix();
    sdfCacheByMeshUuid.set(mesh.uuid, sdf);
    return sdf;
}

function segmentBlockedWithBestAvailableMethod(
    start: Vec3,
    end: Vec3,
    collisionRadius: number,
    mesh: THREE.Mesh,
): boolean {
    const sdf = getOrCreateCollisionSdf(mesh);
    if (sdf) {
        return sdf.segmentBlocked(start.x, start.y, start.z, end.x, end.y, end.z, collisionRadius);
    }

    return checkShaftCollision(start, end, collisionRadius, mesh).hit;
}

export function isCollisionSegmentBlocked(
    start: Vec3,
    end: Vec3,
    collisionRadius: number,
    mesh: THREE.Mesh,
): boolean {
    return segmentBlockedWithBestAvailableMethod(start, end, collisionRadius, mesh);
}

export function isCollisionFrustumBlocked(
    start: Vec3,
    end: Vec3,
    startRadius: number,
    endRadius: number,
    mesh: THREE.Mesh,
    segmentCount: number = DEFAULT_FRUSTUM_SEGMENT_COUNT,
): boolean {
    const normalizedStartRadius = Math.max(0.001, startRadius);
    const normalizedEndRadius = Math.max(0.001, endRadius);

    if (Math.abs(normalizedStartRadius - normalizedEndRadius) <= 0.000001) {
        return segmentBlockedWithBestAvailableMethod(start, end, normalizedEndRadius, mesh);
    }

    const startVec = new THREE.Vector3(start.x, start.y, start.z);
    const endVec = new THREE.Vector3(end.x, end.y, end.z);
    const segmentTotal = Math.max(1, Math.round(segmentCount));

    for (let i = 0; i < segmentTotal; i++) {
        const t0 = i / segmentTotal;
        const t1 = (i + 1) / segmentTotal;
        const segStart = startVec.clone().lerp(endVec, t0);
        const segEnd = startVec.clone().lerp(endVec, t1);
        const radius0 = THREE.MathUtils.lerp(normalizedStartRadius, normalizedEndRadius, t0);
        const radius1 = THREE.MathUtils.lerp(normalizedStartRadius, normalizedEndRadius, t1);
        const sliceRadius = Math.max(radius0, radius1);

        if (segmentBlockedWithBestAvailableMethod(
            { x: segStart.x, y: segStart.y, z: segStart.z },
            { x: segEnd.x, y: segEnd.y, z: segEnd.z },
            sliceRadius,
            mesh,
        )) {
            return true;
        }
    }

    return false;
}

/**
 * Calculates the required standoff distance (offset) from a surface to ensure
 * a connecting element (like a cone) does not collide with the mesh.
 * 
 * @param surfacePos - The starting point on the model surface.
 * @param surfaceNormal - The normal vector at the surface point (direction to extend).
 * @param targetPos - The target position the element connects to (e.g., Socket).
 * @param collisionRadius - The radius of the element for collision checking (include safety margin).
 * @param mesh - The model mesh to check against.
 * @param minOffset - The minimum/starting offset to test.
 * @param maxOffset - The maximum allowable offset.
 * @param step - The increment for iterative testing (default: 0.2mm).
 * @returns The calculated safe offset distance.
 */
export function calculateSafeOffset(
    surfacePos: Vec3,
    surfaceNormal: Vec3,
    targetPos: Vec3,
    collisionRadius: number,
    mesh: THREE.Mesh,
    minOffset: number,
    maxOffset: number,
    step: number = 0.2,
    collisionFrustum?: CollisionFrustumProfile,
): number {
    const start = new THREE.Vector3(surfacePos.x, surfacePos.y, surfacePos.z);
    const normal = new THREE.Vector3(surfaceNormal.x, surfaceNormal.y, surfaceNormal.z).normalize();
    const normalizedStep = Math.max(0.025, step);
    let previousBlockedOffset = minOffset;

    const testOffset = (offset: number): boolean => {
        // Calculate proposed start position: Surface + (Normal * t)
        const testStartVec = start.clone().add(normal.clone().multiplyScalar(offset));
        const testStart: Vec3 = { x: testStartVec.x, y: testStartVec.y, z: testStartVec.z };

        if (collisionFrustum) {
            return isCollisionFrustumBlocked(
                testStart,
                targetPos,
                collisionFrustum.startRadius,
                collisionFrustum.endRadius,
                mesh,
                collisionFrustum.segmentCount,
            );
        }

        return segmentBlockedWithBestAvailableMethod(testStart, targetPos, collisionRadius, mesh);
    };

    if (!testOffset(minOffset)) {
        return minOffset;
    }

    for (let t = minOffset + normalizedStep; t <= maxOffset + 0.000001; t += normalizedStep) {
        const clampedOffset = Math.min(t, maxOffset);
        if (!testOffset(clampedOffset)) {
            let low = previousBlockedOffset;
            let high = clampedOffset;

            for (let i = 0; i < 6; i++) {
                const mid = (low + high) / 2;
                if (testOffset(mid)) {
                    low = mid;
                } else {
                    high = mid;
                }
            }

            return high;
        }

        previousBlockedOffset = clampedOffset;
    }

    return maxOffset;
}
