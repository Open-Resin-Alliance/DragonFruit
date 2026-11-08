import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { installFakeWindow } from './helpers/fakeWindow';
import {
  rememberImportedSliceMesh, inheritImportedSliceMesh, centerImportedSliceMesh,
  retainImportedSliceMesh, loadedSliceMeshReference, loadedSliceMeshPartitions,
  inheritLoadedSliceMeshRange,
} from '../loadedSliceMesh';
import { prepareLoadedModelsForOutput } from '@/features/mesh-modifiers/prepareModelGeometry';
import { cubeModel } from '@/features/slicing/__tests__/helpers/captureAppSliceJob';

let nextSource = 0;
function fixture(onRetain?: () => Promise<void>) {
  const model = cubeModel(`import-source-${++nextSource}`, 2);
  const geometry = model.geometry.geometry;
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const restore = installFakeWindow({ localStorage: storage, sessionStorage: storage, __TAURI_INTERNALS__: { invoke: async (command: string) => {
    assert.equal(command, 'retain_loaded_slice_mesh');
    await onRetain?.();
    return { sourceId: `source-${nextSource}`, partitions: {
      modelTriangleCount: 6,
      modelBounds: { minX: -1, minY: -1, minZ: 0, maxX: 1, maxY: 1, maxZ: 2 },
      supportBounds: { minX: -1, minY: -1, minZ: 0, maxX: 1, maxY: 1, maxZ: 2 },
    } };
  } } });
  rememberImportedSliceMesh(geometry, nextSource);
  return { model, geometry, dispose() { restore(); geometry.dispose(); } };
}

test('finalized import can use its retained source; changed same-sized position or index revisions cannot', async () => {
  const mutations: Array<(geometry: THREE.BufferGeometry) => void> = [
    geometry => { const position = geometry.getAttribute('position'); position.setX(0, position.getX(0) + 1); position.needsUpdate = true; },
    geometry => { geometry.setAttribute('position', geometry.getAttribute('position').clone()); },
    geometry => { const index = geometry.getIndex()!; index.setX(0, 3); index.needsUpdate = true; },
    geometry => { geometry.setIndex(geometry.getIndex()!.clone()); },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    try {
      f.geometry.setIndex(Array.from({ length: 36 }, (_, index) => index));
      await retainImportedSliceMesh(f.geometry);
      assert.ok(loadedSliceMeshReference(f.geometry));
      mutate(f.geometry);
      assert.equal(loadedSliceMeshReference(f.geometry), null);
      assert.equal(loadedSliceMeshPartitions(f.geometry), null);
    } finally { f.dispose(); }
  }
});

test('an edit while native retention is pending never publishes a stale source handle', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const f = fixture(async () => { entered.resolve(); await release.promise; });
  try {
    const retaining = retainImportedSliceMesh(f.geometry);
    await entered.promise;
    const position = f.geometry.getAttribute('position');
    position.setX(0, position.getX(0) + 0.25);
    position.needsUpdate = true;
    release.resolve();
    await retaining;
    assert.equal(loadedSliceMeshReference(f.geometry), null);
  } finally { release.resolve(); f.dispose(); }
});

test('only the authorized import clone and centering survive before finalized BVH order is retained', async () => {
  const f = fixture();
  const clone = f.geometry.clone();
  try {
    inheritImportedSliceMesh(f.geometry, clone);
    centerImportedSliceMesh(clone, [0.25, -0.5, 0.75], () => { clone.translate(0.25, -0.5, 0.75); });
    const order = Array.from({ length: 36 }, (_, index) => 35 - index);
    clone.setIndex(order);
    await retainImportedSliceMesh(clone);
    assert.ok(loadedSliceMeshReference(clone));
    const position = clone.getAttribute('position');
    position.needsUpdate = true;
    assert.equal(loadedSliceMeshReference(clone), null);
  } finally { clone.dispose(); f.dispose(); }
});

test('classified output borrows retained partitions without duplicating buffers and invalidates with its source', async () => {
  const f = fixture();
  f.model.geometry.meshDefects = { nativeRepairReport: { model_triangle_count: 6 } } as typeof f.model.geometry.meshDefects;
  let prepared: Awaited<ReturnType<typeof prepareLoadedModelsForOutput>> | undefined;
  try {
    await retainImportedSliceMesh(f.geometry, 6);
    prepared = await prepareLoadedModelsForOutput([f.model]);
    const original = f.geometry.getAttribute('position').array;
    assert.equal(prepared.models.length, 2);
    for (const part of prepared.models) {
      const position = part.geometry.geometry.getAttribute('position');
      assert.equal(position.array.buffer, original.buffer);
      const source = loadedSliceMeshReference(part.geometry.geometry);
      assert.ok(source);
      assert.equal(source.order, 'soup');
      assert.equal(source.triangleEnd - source.triangleStart, 6);
    }
    const position = f.geometry.getAttribute('position');
    position.setX(0, position.getX(0) + 0.25);
    position.needsUpdate = true;
    for (const part of prepared.models) assert.equal(loadedSliceMeshReference(part.geometry.geometry), null);
    prepared.dispose(); prepared = undefined;
    assert.equal(f.geometry.getAttribute('position').array, original, 'releasing borrowed parts never detaches live source data');
  } finally { prepared?.dispose(); f.dispose(); }
});

test('derived cached sections cannot reuse the source after an index revision changes', async () => {
  const f = fixture();
  const part = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(18), 3));
  try {
    f.geometry.setIndex(Array.from({ length: 36 }, (_, index) => index));
    await retainImportedSliceMesh(f.geometry);
    inheritLoadedSliceMeshRange(f.geometry, part, 0, 2);
    assert.ok(loadedSliceMeshReference(part));
    f.geometry.getIndex()!.needsUpdate = true;
    assert.equal(loadedSliceMeshReference(part), null);
  } finally { part.dispose(); f.dispose(); }
});
