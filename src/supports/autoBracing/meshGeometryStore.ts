import * as THREE from 'three';

/**
 * Module-level store for model mesh geometries used by auto-bracing clearance checks.
 * Keyed by modelId. Registered by the scene manager when models load/unload.
 */

type MeshEntry = {
    geometry: THREE.BufferGeometry;
    transform: THREE.Matrix4;
};

const meshEntries = new Map<string, MeshEntry>();

export function registerMeshForAutoBrace(modelId: string, geometry: THREE.BufferGeometry, transform: THREE.Matrix4): void {
    meshEntries.set(modelId, { geometry, transform });
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
