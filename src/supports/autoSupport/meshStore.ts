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

/**
 * The model's own geometry. A model node may draw a refined display mesh while
 * `userData.raycastGeometry` keeps the mesh the islands, blockers and every
 * `faceIndex` address; anything that reads triangles must read that one.
 */
export function modelGeometryOf(mesh: THREE.Mesh): THREE.BufferGeometry {
    const own = mesh.userData?.raycastGeometry as THREE.BufferGeometry | undefined;
    return own ?? (mesh.geometry as THREE.BufferGeometry);
}

/**
 * The model as the planner sees it: its own geometry at the pose the node is
 * drawn at. The node itself when it draws that geometry; otherwise a detached
 * mesh that shares the geometry, so reads, raycasts and serialization all land
 * on the real triangles instead of the display mesh.
 */
export function getModelSourceMesh(modelId: string): THREE.Mesh | null {
    const node = _meshes.get(modelId);
    if (!node) return null;
    const own = modelGeometryOf(node);
    if (own === node.geometry) return node;
    node.updateMatrixWorld();
    const mesh = new THREE.Mesh(own);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(node.matrixWorld);
    mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
    mesh.updateMatrixWorld(true);
    mesh.userData = { modelId: node.userData?.modelId ?? modelId };
    return mesh;
}
