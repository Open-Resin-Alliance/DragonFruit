import * as THREE from 'three';

/**
 * Module-level store for model mesh geometries used by auto-bracing clearance checks.
 * Keyed by modelId. Registered by the scene manager when models load/unload.
 *
 * Each entry caches a THREE.Mesh with DoubleSide material so that raycast-based
 * clearance checks can use the BVH-accelerated Raycaster.intersectObject() path,
 * which requires a Mesh (not raw BufferGeometry).
 */

const DOUBLE_SIDED_MATERIAL = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });

type MeshEntry = {
    geometry: THREE.BufferGeometry;
    transform: THREE.Matrix4;
    mesh: THREE.Mesh;
};

const meshEntries = new Map<string, MeshEntry>();

export function registerMeshForAutoBrace(modelId: string, geometry: THREE.BufferGeometry, transform: THREE.Matrix4): void {
    const mesh = new THREE.Mesh(geometry, DOUBLE_SIDED_MATERIAL);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(transform);
    mesh.matrixWorld.copy(transform);
    meshEntries.set(modelId, { geometry, transform, mesh });
}

export function unregisterMeshForAutoBrace(modelId: string): void {
    meshEntries.delete(modelId);
}

export function getMeshEntryForAutoBrace(modelId: string): MeshEntry | undefined {
    return meshEntries.get(modelId);
}

export function getAllMeshEntriesForAutoBrace(): Map<string, MeshEntry> {
    return meshEntries;
}
