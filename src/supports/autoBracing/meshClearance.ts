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
 * in meshGeometryStore; meshes without a BVH fall back to the standard raycast.
 */

const warnedNoMeshModelIds = new Set<string>();

type CachedWorldBox = {
    geometry: THREE.BufferGeometry;
    posAttr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
    matrixElements: Float64Array;
    positionVersion: number;
    box: THREE.Box3;
};

const worldBoxCache = new WeakMap<THREE.Mesh, CachedWorldBox>();

function matrixMatches(a: Float64Array, b: ArrayLike<number>): boolean {
    for (let i = 0; i < 16; i += 1) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function getMeshWorldBox(mesh: THREE.Mesh): THREE.Box3 | null {
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const posAttr = geometry.getAttribute('position') as
        | THREE.BufferAttribute
        | THREE.InterleavedBufferAttribute
        | undefined;
    const posVersion = posAttr && 'version' in posAttr ? posAttr.version : -1;
    const mw = mesh.matrixWorld.elements;

    const cached = worldBoxCache.get(mesh);
    if (
        cached &&
        cached.geometry === geometry &&
        cached.posAttr === posAttr &&
        cached.positionVersion === posVersion &&
        matrixMatches(cached.matrixElements, mw)
    ) {
        return cached.box;
    }

    if (
        !geometry.boundingBox ||
        (cached !== undefined &&
            cached.geometry === geometry &&
            (cached.posAttr !== posAttr || cached.positionVersion !== posVersion))
    ) {
        geometry.computeBoundingBox();
    }
    if (!geometry.boundingBox || geometry.boundingBox.isEmpty()) {
        return null;
    }

    const box = geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
    const matrixElements = new Float64Array(16);
    for (let i = 0; i < 16; i += 1) matrixElements[i] = mw[i];
    worldBoxCache.set(mesh, { geometry, posAttr, matrixElements, positionVersion: posVersion, box });
    return box;
}

let scopedAllowedModelIds: ReadonlySet<string> | undefined;

export function withScopedAutoBraceModels<T>(
    allowedModelIds: ReadonlySet<string>,
    fn: () => T,
): T {
    const prev = scopedAllowedModelIds;
    scopedAllowedModelIds = allowedModelIds;
    try {
        return fn();
    } finally {
        scopedAllowedModelIds = prev;
    }
}

const scratchStart = new THREE.Vector3();
const scratchDir = new THREE.Vector3();
const scratchOrigin = new THREE.Vector3();
const scratchPerp1 = new THREE.Vector3();
const scratchPerp2 = new THREE.Vector3();
const scratchRaycaster = new THREE.Raycaster();

export function linePassesMeshClearance(
    posA: Vec3,
    posB: Vec3,
    modelId: string,
    diameterMm: number,
    allowedModelIds?: ReadonlySet<string>,
): boolean {
    const dx = posB.x - posA.x;
    const dy = posB.y - posA.y;
    const dz = posB.z - posA.z;
    const lengthSq = dx * dx + dy * dy + dz * dz;
    if (lengthSq < 0.01) return true; // degenerate segment (< 0.1mm) → allow

    const meshEntries = getAllMeshEntriesForAutoBrace();
    const effectiveAllowed = allowedModelIds ?? scopedAllowedModelIds;

    const primaryAllowed = !effectiveAllowed || effectiveAllowed.has(modelId);
    const primaryEntry = primaryAllowed ? meshEntries.get(modelId) : undefined;
    if (primaryAllowed && !primaryEntry) {
        if (!warnedNoMeshModelIds.has(modelId)) {
            warnedNoMeshModelIds.add(modelId);
            console.warn(
                `[AutoBrace] No mesh registered for model '${modelId}'; skipping mesh clearance check for its braces.`,
            );
        }
        if (!effectiveAllowed) return true;
    }

    const radius = diameterMm / 2;
    const segMinX = Math.min(posA.x, posB.x) - radius;
    const segMaxX = Math.max(posA.x, posB.x) + radius;
    const segMinY = Math.min(posA.y, posB.y) - radius;
    const segMaxY = Math.max(posA.y, posB.y) + radius;
    const segMinZ = Math.min(posA.z, posB.z) - radius;
    const segMaxZ = Math.max(posA.z, posB.z) + radius;

    let frameInitialized = false;
    let eps = 0;

    const ensureRayFrame = (): void => {
        if (frameInitialized) return;
        frameInitialized = true;
        const length = Math.sqrt(lengthSq);
        scratchStart.set(posA.x, posA.y, posA.z);
        scratchDir.set(dx / length, dy / length, dz / length);
        eps = Math.min(RAY_ORIGIN_EPS_MM, Math.max(0, length * 0.1));
        scratchRaycaster.near = 0;
        scratchRaycaster.far = Math.max(0, length - eps);
        const arbitrary = Math.abs(scratchDir.dot(WORLD_UP)) > 0.9 ? WORLD_RIGHT : WORLD_UP;
        scratchPerp1.crossVectors(scratchDir, arbitrary).normalize();
        scratchPerp2.crossVectors(scratchDir, scratchPerp1).normalize();
    };

    const passesSingleMesh = (mesh: THREE.Mesh): boolean => {
        const worldBox = getMeshWorldBox(mesh);
        if (
            worldBox &&
            (segMaxX < worldBox.min.x ||
                segMinX > worldBox.max.x ||
                segMaxY < worldBox.min.y ||
                segMinY > worldBox.max.y ||
                segMaxZ < worldBox.min.z ||
                segMinZ > worldBox.max.z)
        ) {
            return true;
        }

        ensureRayFrame();

        const castRay = (ox: number, oy: number, oz: number): boolean => {
            scratchOrigin.set(
                scratchStart.x + ox + scratchDir.x * eps,
                scratchStart.y + oy + scratchDir.y * eps,
                scratchStart.z + oz + scratchDir.z * eps,
            );
            scratchRaycaster.set(scratchOrigin, scratchDir);
            return scratchRaycaster.intersectObject(mesh, false).length > 0;
        };

        if (castRay(0, 0, 0)) return false;

        for (const off of WHISKER_OFFSETS) {
            const ox = (scratchPerp1.x * off.u + scratchPerp2.x * off.v) * radius;
            const oy = (scratchPerp1.y * off.u + scratchPerp2.y * off.v) * radius;
            const oz = (scratchPerp1.z * off.u + scratchPerp2.z * off.v) * radius;
            if (castRay(ox, oy, oz)) return false;
        }

        return true;
    };

    if (primaryEntry && !passesSingleMesh(primaryEntry.mesh)) {
        return false;
    }

    if (effectiveAllowed) {
        for (const candidateModelId of effectiveAllowed) {
            if (candidateModelId === modelId) continue;
            const siblingEntry = meshEntries.get(candidateModelId);
            if (siblingEntry && !passesSingleMesh(siblingEntry.mesh)) {
                return false;
            }
        }
    }

    return true;
}
