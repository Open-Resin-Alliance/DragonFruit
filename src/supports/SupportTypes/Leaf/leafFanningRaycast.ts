import * as THREE from 'three';
import { calculateSmoothedNormal } from '../../PlacementLogic/PlacementUtils';
import { leafPlacementStore } from './leafPlacementState';
import type { Vec3 } from '../../types';

/** three-mesh-bvh reads `firstHitOnly` off the raycaster; Three's own type lacks it. */
type BvhRaycaster = THREE.Raycaster & { firstHitOnly?: boolean };

export type LeafPlacementSurface = 'interior' | 'exterior';

export interface LeafPlacementRaycastOptions {
    placementSurface?: LeafPlacementSurface;
    clipLower?: number | null;
    clipUpper?: number | null;
}

export interface SyncSproutTipResult {
    tipPosition: Vec3 | null;
    surfaceNormal: Vec3 | null;
}

const MAX_CLIP_STEP_ITERATIONS = 16;
const _clipFallbackRaycaster: BvhRaycaster = new THREE.Raycaster();
const _interiorCavityRaycaster: BvhRaycaster = new THREE.Raycaster();
const _interiorCavityRaycastMesh = new THREE.Mesh();

function isPointClipped(
    z: number,
    clipLower: number | null | undefined,
    clipUpper: number | null | undefined,
): boolean {
    return (clipUpper != null && z > clipUpper) || (clipLower != null && z < clipLower);
}

/**
 * Steps past clipped surfaces using `near = distance + 0.05` and `firstHitOnly`
 * to find the nearest visible inner wall.
 */
export function findClipAwareHit(
    ray: THREE.Ray,
    meshes: THREE.Object3D[],
    clipLower: number | null | undefined,
    clipUpper: number | null | undefined,
    primaryDistance: number,
): THREE.Intersection | null {
    const rc = _clipFallbackRaycaster;
    let near = primaryDistance + 0.05;

    try {
        for (let step = 0; step < MAX_CLIP_STEP_ITERATIONS; step++) {
            rc.ray.copy(ray);
            rc.near = near;
            rc.far = near + 500;
            rc.firstHitOnly = true;

            const hits = rc.intersectObjects(meshes, false);
            if (hits.length === 0) return null;

            const hit = hits[0];
            if (!isPointClipped(hit.point.z, clipLower, clipUpper)) {
                return hit;
            }
            if (hit.distance < near) return null;
            near = hit.distance + 0.05;
        }
        return null;
    } finally {
        rc.near = 0;
        rc.far = Infinity;
        rc.firstHitOnly = false;
    }
}

function findInteriorCavityHit(
    ray: THREE.Ray,
    modelMesh: THREE.Object3D,
    cavityGeometry: THREE.BufferGeometry,
    modelId: string | undefined,
): THREE.Intersection | null {
    const rc = _interiorCavityRaycaster;
    rc.ray.copy(ray);
    rc.near = 0;
    rc.far = Infinity;
    rc.firstHitOnly = true;

    const mesh = _interiorCavityRaycastMesh;
    mesh.geometry = cavityGeometry;
    mesh.matrixWorld.copy(modelMesh.matrixWorld);
    mesh.matrixAutoUpdate = false;
    mesh.userData = {
        ...(modelId !== undefined ? { modelId } : {}),
        supportPlacementSurface: 'interior',
        cavityGeometry,
    };

    try {
        const hits: THREE.Intersection[] = [];
        mesh.raycast(rc, hits);
        if (hits.length === 0) return null;
        const hit = hits[0];
        hit.object = mesh;
        return hit;
    } finally {
        rc.near = 0;
        rc.far = Infinity;
        rc.firstHitOnly = false;
    }
}

/**
 * Resolves the active model mesh hit, honoring interior `cavityGeometry`
 * raycasts and stepping past cross-section clipped surfaces.
 */
export function resolveLeafPlacementMeshHit(
    raycaster: THREE.Raycaster,
    modelMeshes: THREE.Object3D[],
    options: LeafPlacementRaycastOptions = {},
): THREE.Intersection | null {
    if (modelMeshes.length === 0) return null;

    const intersects = raycaster.intersectObjects(modelMeshes, false);
    if (intersects.length === 0) return null;

    let meshHit: THREE.Intersection | null = intersects[0];
    let hitIsInteriorCavity = false;

    if (options.placementSurface === 'interior') {
        const cavityGeometry = meshHit.object.userData?.cavityGeometry as THREE.BufferGeometry | undefined;
        if (cavityGeometry) {
            const rawModelId = meshHit.object.userData?.modelId;
            const hitModelId = typeof rawModelId === 'string' ? rawModelId : undefined;
            const interiorHit = findInteriorCavityHit(
                raycaster.ray,
                meshHit.object,
                cavityGeometry,
                hitModelId,
            );
            if (interiorHit) {
                meshHit = interiorHit;
                hitIsInteriorCavity = true;
            }
        }
    }

    const { clipLower, clipUpper } = options;
    if (isPointClipped(meshHit.point.z, clipLower, clipUpper)) {
        const fallbackTargets = hitIsInteriorCavity ? [meshHit.object] : modelMeshes;
        meshHit = findClipAwareHit(
            raycaster.ray,
            fallbackTargets,
            clipLower,
            clipUpper,
            meshHit.distance,
        );
    }

    return meshHit;
}

/**
 * Updates `leafPlacementStore`'s live fanning tip and normal from the current
 * raycast, clearing both and `previewData` on off-mesh or all-clipped misses.
 */
export function syncSproutTipFromRaycast(
    raycaster: THREE.Raycaster,
    modelMeshes: THREE.Object3D[],
    options: LeafPlacementRaycastOptions = {},
): SyncSproutTipResult {
    const hit = resolveLeafPlacementMeshHit(raycaster, modelMeshes, options);
    if (!hit) {
        leafPlacementStore.updateFanningTip(null, null);
        leafPlacementStore.setPreviewData(null);
        return { tipPosition: null, surfaceNormal: null };
    }

    const tipPosition: Vec3 = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
    const surfaceNormal = calculateSmoothedNormal(hit);
    const hitModelId = hit.object.userData?.modelId;
    leafPlacementStore.updateFanningTip(
        tipPosition,
        surfaceNormal,
        typeof hitModelId === 'string' ? hitModelId : undefined,
    );

    return { tipPosition, surfaceNormal };
}
