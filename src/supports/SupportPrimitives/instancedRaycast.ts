import * as THREE from 'three';

/**
 * The raycast an instanced batch falls back to when its caller supplies no
 * override of its own.
 *
 * `InstancedMesh` overrides `raycast` for exactly one reason: it walks the
 * instances and stamps `intersection.instanceId` on each hit. Every group
 * handler resolves the primitive it was hit on from that id and returns early
 * when it is missing, so falling back to `THREE.Mesh.prototype.raycast` - which
 * raycasts the base geometry once, at the object's own matrix, and stamps
 * nothing - leaves every hover and click with no instance to name. It reads as
 * "the supports stopped responding", which is what the proxy layer never saw
 * because it supplies its own grid raycast.
 */
export const INSTANCED_MESH_RAYCAST = THREE.InstancedMesh.prototype.raycast;
