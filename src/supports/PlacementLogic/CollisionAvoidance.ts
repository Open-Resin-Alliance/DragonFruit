import * as THREE from 'three';
import { Vec3 } from '../types';
import { checkShaftCollision } from './CollisionUtils';
import { SDFCache } from './Pathfinding/SDFCache';
import { getOrCreateSDFCache } from './Pathfinding/SDFCachePool';
const DEFAULT_FRUSTUM_SEGMENT_COUNT = 5;
/** Safety margin used only for contact-cone body sampling. */
const CONTACT_CONE_COLLISION_SAFETY_MM = 0.05;
/** Ignore the first tip-adjacent region so contact attachment is still allowed. */
const CONTACT_CONE_TIP_IGNORE_MM = 0.25;
/**
 * Extra margin for the first cone sample. The cone is tangent to the surface at
 * the tip, so the near-tip region is clear by construction — but the sphere
 * approximation only clears if the sample depth exceeds its radius. With a
 * fixed 0.25mm ignore the first sample's radius (~0.24mm) leaves 0.015mm of
 * clearance: pure SDF quantization noise, which flips to a false collision on
 * sloped geometry. Scale the ignore with the tip radius so the margin is robust.
 */
const CONE_TIP_SDF_MARGIN_MM = 0.15;
/** Target sampling stride for contact-cone checks (adaptive with SDF cell size). */
const CONTACT_CONE_COLLISION_SAMPLE_STEP_MM = 0.2;

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
    // Use the shared pool so every subsystem queries the same distance field.
    const sdf = getOrCreateSDFCache(mesh);
    sdf.refreshMatrix();
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

/**
 * SDF-based shaft collision check — replaces BVH whisker-ray `checkShaftCollision`.
 *
 * Uses `sdf.segmentBlocked()` with adaptive sphere tracing, which is more
 * accurate than the 9-ray bundle and shares its cell cache with the router.
 * Falls back to BVH raycasting if no BVH/SDF is available.
 *
 * @param start  - Start of the shaft segment (world-space mm)
 * @param end    - End of the shaft segment (world-space mm)
 * @param shaftRadius - Shaft radius in mm (used as clearance margin)
 * @param mesh   - The model mesh
 */
export function isShaftBlocked(
    start: Vec3,
    end: Vec3,
    shaftRadius: number,
    mesh: THREE.Mesh,
): boolean {
    const sdf = getOrCreateCollisionSdf(mesh);
    if (sdf) {
        return sdf.segmentBlocked(
            start.x, start.y, start.z,
            end.x, end.y, end.z,
            shaftRadius,
        );
    }
    return checkShaftCollision(start, end, shaftRadius, mesh).hit;
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

/** The contact cone as a collision subject: disk surface in, socket out. */
export interface ContactConeSweep {
    /** Where the cone leaves the contact disk (tip side, small radius). */
    start: Vec3;
    /** The socket, where the cone meets the shaft (body side, large radius). */
    end: Vec3;
    startRadius: number;
    endRadius: number;
}

/**
 * The contact cone's own collision gate: does the cone body intersect the model?
 *
 * `isCollisionFrustumBlocked` slices the frustum and asks the quantized grid,
 * which is right for a shaft but wrong for a cone: the cone's safety margin
 * (0.05mm) is far below the grid's cell-centre substitution error
 * (~cellSize·√3/2), so geometry the cone actually clears reads as intersecting.
 * Sample the axis and ask for the exact signed distance instead, and skip the
 * tangent tip region — the cone is tangent to its own attachment surface, so
 * those samples are clear by construction.
 *
 * @param sdf  - Distance field for the mesh the cone attaches to (matrix refreshed by the caller).
 * @param cone - Cone start, socket, and the two radii, in world space.
 * @returns true when the cone body intersects the model.
 */
export function isContactConeBlocked(sdf: SDFCache, cone: ContactConeSweep): boolean {
    const dx = cone.end.x - cone.start.x;
    const dy = cone.end.y - cone.start.y;
    const dz = cone.end.z - cone.start.z;
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (length <= 0.000001) {
        return false;
    }

    const minStep = Math.max(
        Math.min(CONTACT_CONE_COLLISION_SAMPLE_STEP_MM, sdf.cellSize * 0.8),
        0.1,
    );
    const tipIgnore = Math.max(
        CONTACT_CONE_TIP_IGNORE_MM,
        cone.startRadius + CONTACT_CONE_COLLISION_SAFETY_MM + CONE_TIP_SDF_MARGIN_MM,
    );
    const startT = Math.min(1, tipIgnore / length);
    const sampleCount = Math.max(1, Math.ceil(((1 - startT) * length) / minStep));

    for (let i = 0; i <= sampleCount; i++) {
        const t = startT + ((1 - startT) * i) / sampleCount;
        const radius = cone.startRadius
            + (cone.endRadius - cone.startRadius) * t
            + CONTACT_CONE_COLLISION_SAFETY_MM;
        // Unbounded query, so interior samples still sign negative: a cone
        // through solid material must stay detected.
        if (sdf.exactSignedDistanceAt(
            cone.start.x + dx * t,
            cone.start.y + dy * t,
            cone.start.z + dz * t,
        ) < radius) {
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
