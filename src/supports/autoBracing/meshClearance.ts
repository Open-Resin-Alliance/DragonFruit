import * as THREE from 'three';
import type { Vec3 } from '../types';
import { getAllMeshEntriesForAutoBrace } from './meshGeometryStore';

/**
 * Whisker offsets for perimeter rays, matching the pattern in
 * PlacementLogic/CollisionUtils.ts. 8 rays around the circumference
 * (4 cardinal + 4 diagonal) plus 1 center ray = 9 total.
 */
const WHISKER_DIAGONAL = 0.7071067811865476;
const WHISKER_OFFSETS: ReadonlyArray<{ u: number; v: number }> = [
    { u: 1, v: 0 },
    { u: -1, v: 0 },
    { u: 0, v: 1 },
    { u: 0, v: -1 },
    { u: WHISKER_DIAGONAL, v: WHISKER_DIAGONAL },
    { u: -WHISKER_DIAGONAL, v: WHISKER_DIAGONAL },
    { u: WHISKER_DIAGONAL, v: -WHISKER_DIAGONAL },
    { u: -WHISKER_DIAGONAL, v: -WHISKER_DIAGONAL },
];

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const WORLD_RIGHT = new THREE.Vector3(1, 0, 0);

/** Small forward offset to avoid false positives when a ray origin sits
 *  exactly on the mesh surface. */
const RAY_ORIGIN_EPS_MM = 0.02;

/**
 * Returns true if a cylindrical brace from posA to posB maintains model clearance.
 *
 * Casts a bundle of 9 parallel rays (center + 8 perimeter whiskers at the brace
 * radius) through the model mesh. If ANY ray hits, the brace would intersect the
 * model → returns false (blocked).
 *
 * Uses the BVH-accelerated raycaster path (three-mesh-bvh) via the cached Mesh
 * in meshGeometryStore.
 */
export function linePassesMeshClearance(posA: Vec3, posB: Vec3, modelId: string, diameterMm: number): boolean {
    const radius = diameterMm / 2;
    const meshEntries = getAllMeshEntriesForAutoBrace();

    const entry = meshEntries.get(modelId);
    if (!entry) return true; // no mesh registered → can't check → allow

    const mesh = entry.mesh;
    const bvh = (entry.geometry as any).boundsTree;
    if (!bvh) return true; // no BVH → can't check → allow

    // Build direction and length
    const startVec = new THREE.Vector3(posA.x, posA.y, posA.z);
    const direction = new THREE.Vector3(posB.x - posA.x, posB.y - posA.y, posB.z - posA.z);
    const length = direction.length();

    if (length < 0.1) return true; // degenerate segment → allow

    direction.multiplyScalar(1 / length);

    // Offset origin slightly forward to avoid self-intersections
    const eps = Math.min(RAY_ORIGIN_EPS_MM, Math.max(0, length * 0.1));
    const maxRayDistance = Math.max(0, length - eps);

    const raycaster = new THREE.Raycaster();
    raycaster.near = 0;
    raycaster.far = maxRayDistance;

    const rayOrigin = new THREE.Vector3();

    const castRay = (ox: number, oy: number, oz: number): boolean => {
        rayOrigin.set(
            startVec.x + ox + direction.x * eps,
            startVec.y + oy + direction.y * eps,
            startVec.z + oz + direction.z * eps,
        );
        raycaster.set(rayOrigin, direction);
        const intersections = raycaster.intersectObject(mesh, false);
        return intersections.length > 0;
    };

    // 1. Center ray
    if (castRay(0, 0, 0)) return false;

    // 2. Perimeter whisker rays
    // Build a perpendicular coordinate frame from the direction vector
    const arbitrary = Math.abs(direction.dot(WORLD_UP)) > 0.9 ? WORLD_RIGHT : WORLD_UP;
    const perp1 = new THREE.Vector3().crossVectors(direction, arbitrary).normalize();
    const perp2 = new THREE.Vector3().crossVectors(direction, perp1).normalize();

    for (const off of WHISKER_OFFSETS) {
        const ox = (perp1.x * off.u + perp2.x * off.v) * radius;
        const oy = (perp1.y * off.u + perp2.y * off.v) * radius;
        const oz = (perp1.z * off.u + perp2.z * off.v) * radius;

        if (castRay(ox, oy, oz)) return false;
    }

    return true;
}
