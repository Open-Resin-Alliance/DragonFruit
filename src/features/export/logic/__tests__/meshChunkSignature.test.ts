import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import { ExportManager } from '../ExportManager';
import { MeshChunkStore } from '@/features/scene/voxl/meshChunkStore';
import { applyRepairedPositions } from '@/utils/meshRepair';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';

/**
 * The chunk store keys each model's mesh bytes on `computeModelGeometrySignature`,
 * and the VOXL writer stamps the model's classification beside those bytes. The two
 * have to describe the same triangle order, and the signature is the only thing that
 * can notice when they do not: a classify pass replaces the position attribute with a
 * reordered soup of exactly the same length, on the same `BufferGeometry`.
 */

function modelWith(geometry: THREE.BufferGeometry): LoadedModel {
  // The signature reads nothing but the geometry, so the rest of the model is not
  // part of this test.
  return { geometry: { geometry } } as unknown as LoadedModel;
}

const quadSoup = (): Float32Array => new Float32Array([
  0, 0, 0, 1, 0, 0, 0, 1, 0,
  0, 0, 1, 1, 0, 1, 0, 1, 1,
]);

test('a replaced position array is a different signature, at the same corner count', () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(quadSoup(), 3));
  const before = ExportManager.computeModelGeometrySignature(modelWith(geometry));
  assert.equal(ExportManager.computeModelGeometrySignature(modelWith(geometry)), before);

  // What `applyRepairedPositions` does when the classifier reorders the soup: a new
  // attribute, the same number of corners, version 0.
  const reordered = quadSoup();
  reordered.set(reordered.subarray(0, 9), 9);
  reordered.set(reordered.subarray(9, 18), 0);
  geometry.setAttribute('position', new THREE.BufferAttribute(reordered, 3));

  assert.notEqual(
    ExportManager.computeModelGeometrySignature(modelWith(geometry)),
    before,
    'bytes baked before the classifier ran must not be offered as this geometry\'s',
  );
});

test('an in-place edit keeps its own signature change', () => {
  const geometry = new THREE.BufferGeometry();
  const position = new THREE.BufferAttribute(quadSoup(), 3);
  geometry.setAttribute('position', position);
  const before = ExportManager.computeModelGeometrySignature(modelWith(geometry));

  position.needsUpdate = true;
  assert.notEqual(ExportManager.computeModelGeometrySignature(modelWith(geometry)), before);
});

test('the chunk store refuses the bytes it baked before a reorder', async () => {
  // The save-time sequence behind a mis-sliced VOXL: a chunk is baked, the
  // classifier then installs its reordered soup, and the writer asks the store for
  // the model's chunk again. A signature that cannot see the reorder serves the
  // pre-classification bytes, which the writer then stamps with the
  // post-classification boundary — a file whose boundary cuts the model in half.
  const store = new MeshChunkStore();
  const soup = new Float32Array(54);
  for (let triangle = 0; triangle < 6; triangle += 1) {
    soup.set([0, 0, triangle + 1, 1, 0, triangle + 1, 0, 1, triangle + 1], triangle * 9);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(soup, 3));
  geometry.computeBoundingBox();
  const model = {
    id: 'm1',
    geometry: {
      geometry,
      center: new THREE.Vector3(),
      bbox: geometry.boundingBox,
      size: new THREE.Vector3(1, 1, 6),
      flatteningPlanes: [],
    },
  } as unknown as LoadedModel;

  const chunk = new Uint8Array([1, 2, 3]);
  const before = ExportManager.computeModelGeometrySignature(model);
  await store.bake({ modelId: 'm1', signature: before, encode: () => chunk });
  assert.notEqual(store.lookup('m1', before), null, 'the bake is served while nothing moved');

  // What a classify pass does: same corners, model-first order, same counts.
  const reordered = new Float32Array(soup);
  reordered.set(soup.subarray(9), 0);
  reordered.set(soup.subarray(0, 9), 9);
  applyRepairedPositions(geometry, reordered);

  const after = ExportManager.computeModelGeometrySignature(model);
  assert.equal(store.lookup('m1', after), null, 'the reorder must force a fresh bake');
});

test('a duplicate adopts the source chunk instead of encoding the same geometry again', async () => {
  const store = new MeshChunkStore();
  const signature = 'geometry:1:2:3:4';
  let encodes = 0;
  await store.bake({
    modelId: 'source',
    signature,
    encode: () => {
      encodes += 1;
      return new Uint8Array([1, 2, 3, 4]);
    },
  });

  const adopted = store.adoptForModel('copy', signature);

  assert.notEqual(adopted, null, 'the shared signature has a chunk to adopt');
  assert.equal(adopted?.sha256, store.lookup('source', signature)?.sha256);
  assert.notEqual(store.lookup('copy', signature), null, 'the copy is now served without an encode');
  assert.equal(encodes, 1, 'only the source encoded');
  assert.equal(store.adoptForModel('other', 'geometry:9:9:9:9'), null, 'a different signature is not adopted');
});
