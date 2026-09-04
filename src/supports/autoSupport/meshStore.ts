import * as THREE from 'three';

/**
 * Module-level store for model meshes, keyed by model id.
 *
 * Updated by SceneCanvas whenever any model mesh mounts/unmounts.
 * Consumed by {@link runAutoPlace} so that pathfinding and SDF
 * collision checks have access to the model geometry without
 * requiring the caller to thread a THREE.Mesh through the
 * component tree.
 */

const _meshes = new Map<string, THREE.Mesh>();

/** Called by SceneCanvas when any model mesh mounts or unmounts. */
export function setModelMesh(modelId: string, mesh: THREE.Mesh | null): void {
    if (mesh) {
        _meshes.set(modelId, mesh);
    } else {
        _meshes.delete(modelId);
    }
}

/** Returns the mesh for the given model, or null if none. */
export function getModelMesh(modelId: string): THREE.Mesh | null {
    return _meshes.get(modelId) ?? null;
}
