import assert from 'node:assert/strict';
import test, { describe, beforeEach } from 'node:test';
import * as THREE from 'three';

import { ExportManager } from '../ExportManager';
import { meshChunkStore } from '@/features/scene/voxl/meshChunkStore';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';

/**
 * ExportManager ↔ chunk-store wiring (Ph0.1 sub-phase C).
 *
 * The store only pays for itself if the export path actually consults it and the
 * scene actually releases into it. These are the two seams:
 *
 *  - `bakeModelGeometryChunk` is called at finalization (`replaceModelGeometry`,
 *    import completion, both split paths) and by the tick itself as a lazy
 *    fallback. Because the geometry SIGNATURE is the authority and the bake is
 *    merely *when*, a missed hook costs a lazy re-bake on the next tick — never
 *    a stale write. That is what makes the hooks an optimization rather than a
 *    correctness dependency.
 *  - `releaseModelChunks` is called from `deleteModels`. Without it the cache
 *    retained ~191 MiB per deleted 4M-tri model for the life of the session.
 */

function makeModel(id: string, triangles: number, seed = 1): LoadedModel {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(triangles * 9);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < positions.length; i += 1) {
    x = (x * 1664525 + 1013904223) >>> 0;
    positions[i] = ((x >>> 16) & 0xff) / 8;
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeBoundingBox();

  return {
    id,
    name: id,
    geometry: {
      geometry,
      bbox: geometry.boundingBox!,
      center: new THREE.Vector3(0, 0, 0),
      size: new THREE.Vector3(1, 1, 1),
    },
  } as unknown as LoadedModel;
}

describe('ExportManager chunk-store wiring', () => {
  beforeEach(() => {
    meshChunkStore.clear();
  });

  test('a second tick over unchanged geometry performs no compression', async () => {
    const model = makeModel('m0', 64);

    await ExportManager.bakeModelGeometryChunk(model);
    const afterFirst = meshChunkStore.stats().compressions;
    await ExportManager.bakeModelGeometryChunk(model);

    assert.equal(afterFirst, 1);
    assert.equal(
      meshChunkStore.stats().compressions,
      1,
      'zlib-6 re-ran over geometry that had not changed (the per-tick 3 589 ms defect)',
    );
    assert.equal(meshChunkStore.stats().hits, 1);
  });

  test('replacing the geometry object invalidates the entry by signature', async () => {
    const model = makeModel('m0', 64);
    await ExportManager.bakeModelGeometryChunk(model);

    // What `replaceModelGeometry` does: a brand-new BufferGeometry replaces the
    // old one, so the uuid — and therefore the signature — changes.
    const mutated = makeModel('m0', 48, 9);
    (model as { geometry: LoadedModel['geometry'] }).geometry = mutated.geometry;

    await ExportManager.bakeModelGeometryChunk(model);

    assert.equal(meshChunkStore.stats().compressions, 2, 'a mutated model must re-bake');
    assert.equal(meshChunkStore.stats().blobs, 1, 'the superseded blob must not be retained');
  });

  test('a bumped attribute version alone is enough to read as dirty', async () => {
    const model = makeModel('m0', 64);
    await ExportManager.bakeModelGeometryChunk(model);

    const position = model.geometry.geometry.getAttribute('position');
    position.needsUpdate = true; // bumps `version`

    assert.equal(
      meshChunkStore.lookup('m0', ExportManager.computeModelGeometrySignature(model)),
      null,
      'an in-place vertex edit must read as dirty — this is why the signature, not a '
      + 'boolean flag, is the dirty primitive: no mutation path has to remember to set it',
    );

    // …and because the store is content-addressed, an edit that did not actually
    // change the emitted bytes re-encodes but does NOT re-compress. Dirty
    // tracking is deliberately conservative; the SHA is what makes it cheap.
    await ExportManager.bakeModelGeometryChunk(model);
    assert.equal(meshChunkStore.stats().compressions, 1);
    assert.equal(meshChunkStore.stats().blobs, 1);
  });

  test('deleting a model releases its bytes', async () => {
    const a = makeModel('m0', 64);
    const b = makeModel('m1', 64, 5);
    await ExportManager.bakeModelGeometryChunk(a);
    await ExportManager.bakeModelGeometryChunk(b);
    assert.ok(meshChunkStore.stats().retainedBytes > 0);

    ExportManager.releaseModelChunks(['m0', 'm1']);

    assert.equal(meshChunkStore.stats().retainedBytes, 0, 'deleted models kept their compressed bytes');
    assert.equal(meshChunkStore.stats().owners, 0);
  });

  test('two instances of one geometry hold a single blob', async () => {
    const geometry = makeModel('m0', 64).geometry;
    const a = makeModel('m0', 1);
    const b = makeModel('m1', 1);
    (a as { geometry: LoadedModel['geometry'] }).geometry = geometry;
    (b as { geometry: LoadedModel['geometry'] }).geometry = geometry;

    await ExportManager.bakeModelGeometryChunk(a);
    await ExportManager.bakeModelGeometryChunk(b);

    assert.equal(meshChunkStore.stats().blobs, 1, 'identical instances must share one compressed blob');
    assert.equal(meshChunkStore.stats().owners, 2);
  });
});
