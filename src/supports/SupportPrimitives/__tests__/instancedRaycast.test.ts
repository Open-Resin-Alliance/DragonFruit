import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as THREE from 'three';
import { INSTANCED_MESH_RAYCAST } from '../instancedRaycast';

/**
 * A batch of two unit boxes, one at x=0 and one at x=10, raycast from directly
 * above whichever instance the caller aims at.
 */
function raycastInstance(raycast: THREE.Object3D['raycast'], targetX: number) {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), 2);
  const placement = new THREE.Object3D();
  placement.position.set(0, 0, 0);
  placement.updateMatrix();
  mesh.setMatrixAt(0, placement.matrix);
  placement.position.set(10, 0, 0);
  placement.updateMatrix();
  mesh.setMatrixAt(1, placement.matrix);
  mesh.updateMatrixWorld();

  const raycaster = new THREE.Raycaster(new THREE.Vector3(targetX, 5, 0), new THREE.Vector3(0, -1, 0));
  const hits: THREE.Intersection[] = [];
  raycast.call(mesh, raycaster, hits);
  return hits;
}

describe('instanced raycast fallback', () => {
  it('names the instance a hit landed on', () => {
    // Every group handler resolves its primitive from `event.instanceId` and
    // returns early without one, so a fallback that cannot name the instance
    // silently disables hover and click on the whole batch.
    assert.strictEqual(raycastInstance(INSTANCED_MESH_RAYCAST, 10)[0]?.instanceId, 1);
    assert.strictEqual(raycastInstance(INSTANCED_MESH_RAYCAST, 0)[0]?.instanceId, 0);
  });

  it('is not the plain mesh raycast, which names nothing', () => {
    assert.notStrictEqual(INSTANCED_MESH_RAYCAST, THREE.Mesh.prototype.raycast);
    assert.strictEqual(raycastInstance(THREE.Mesh.prototype.raycast, 10)[0]?.instanceId, undefined);
  });
});
