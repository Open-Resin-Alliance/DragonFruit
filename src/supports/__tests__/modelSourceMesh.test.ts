import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { getModelSourceMesh, setModelMesh } from '../autoSupport/meshStore';
import { serializeModelMesh } from '../autoSupport/autoPlace.worker.shared';
import { calculateSmoothedNormal } from '../PlacementLogic/PlacementUtils';

/**
 * A model node draws a refined display mesh, but its islands, blockers and every
 * raycast `faceIndex` address the model's own mesh. Supports planned on the display
 * mesh lost every lattice point whose hit no longer belonged to the island: only
 * the region rims got contacts.
 */

const MODEL = 'model-display';

/** One triangle, facing down, the island's own. */
function realGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 5, 0, 1, 5, 1, 0, 5], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, -1, 0, 0, -1, 0, 0, -1], 3));
  return g;
}

/** The same triangle split in two, with normals that point anywhere but down. */
function displayGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 5, 0, 1, 5, 0.5, 0.5, 5,
    0, 0, 5, 0.5, 0.5, 5, 1, 0, 5,
  ], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(18).fill(0).map((_, i) => (i % 3 === 0 ? 1 : 0)), 3));
  return g;
}

function drawnNode(): { node: THREE.Mesh; real: THREE.BufferGeometry } {
  const real = realGeometry();
  const node = new THREE.Mesh(displayGeometry());
  node.userData = { modelId: MODEL, raycastGeometry: real };
  node.position.set(10, 20, 0);
  node.scale.set(2, 2, 2);
  node.updateMatrixWorld(true);
  return { node, real };
}

test('the planner gets the model mesh, not the display mesh, at the pose it is drawn at', (t) => {
  const { node, real } = drawnNode();
  setModelMesh(MODEL, node);
  t.after(() => setModelMesh(MODEL, null));

  const source = getModelSourceMesh(MODEL);
  assert.ok(source);
  assert.equal(source.geometry, real);
  assert.deepEqual(source.matrixWorld.elements, node.matrixWorld.elements);

  const serialized = serializeModelMesh(source);
  assert.equal(serialized.positions.length, 9, 'one triangle: the model mesh, not the two of the display mesh');
});

test('a node that draws its own mesh is handed over as it is', (t) => {
  const node = new THREE.Mesh(realGeometry());
  node.userData = { modelId: MODEL, raycastGeometry: node.geometry };
  setModelMesh(MODEL, node);
  t.after(() => setModelMesh(MODEL, null));
  assert.equal(getModelSourceMesh(MODEL), node);
});

test('a placement normal is read from the triangle the hit addresses', () => {
  const { node } = drawnNode();
  const point = new THREE.Vector3(0.25, 0.25, 5).applyMatrix4(node.matrixWorld);
  const hit = {
    object: node,
    point,
    distance: 1,
    faceIndex: 0,
    face: { a: 0, b: 1, c: 2, normal: new THREE.Vector3(0, 0, -1), materialIndex: 0 },
  } as unknown as THREE.Intersection;
  const n = calculateSmoothedNormal(hit);
  assert.ok(n.z < -0.99, `expected the model's downward normal, got ${JSON.stringify(n)}`);
});
