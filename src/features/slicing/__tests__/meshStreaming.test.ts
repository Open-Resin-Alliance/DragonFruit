import assert from 'node:assert/strict';
import test, { after, afterEach, beforeEach } from 'node:test';
import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import type { MaterialProfile, PrinterProfile } from '@/features/profiles/profileStore';
import type { ContactDisk, SupportState } from '@/supports/types';
import { getSnapshot, setSnapshot } from '@/supports/state';
import { createEmptySupportCollections } from '@/supports/supportTypeRegistry';
import { disposeEventLoopChannel } from '@/utils/yieldToEventLoop';
import { buildSolidSliceMeshForWasm, type SolidSliceMeshForWasm } from '../rasterLayerZipExport';

const TARGET_BYTES = 16 * 1024 * 1024;
const TRIANGLE_BYTES = 9 * Float32Array.BYTES_PER_ELEMENT;
const CHUNK_TRIANGLES = Math.floor(TARGET_BYTES / TRIANGLE_BYTES);
const ALIGNED_CHUNK_BYTES = CHUNK_TRIANGLES * TRIANGLE_BYTES;
const MODEL_PATTERN = [
  new Float32Array([-3, -2, 1, 4, -1, 2, 1, 5, 3]),
  new Float32Array([6, -4, 4, 8, 2, 5, -2, 7, 6]),
];
const SUPPORT_PATTERN = MODEL_PATTERN.map((triangle) => triangle.map((value, i) => value + (i % 3 === 0 ? 20 : 0)));
const printerProfile: PrinterProfile = {
  id: 'streaming-printer', name: 'Streaming printer',
  buildVolumeMm: { width: 200, depth: 200, height: 200 },
  display: { resolutionX: 64, resolutionY: 64, outputFormat: '.ctb' },
};
const materialProfile = {
  id: 'streaming-material', name: 'Streaming material', layerHeightMm: 0.05,
} as MaterialProfile;

let savedSupportState: SupportState;
beforeEach(() => {
  savedSupportState = getSnapshot();
  setSnapshot({
    ...createEmptySupportCollections(),
    selectedId: null, hoveredId: null, selectedCategory: null,
    hoveredCategory: 'none', interactionWarning: null,
  });
});
afterEach(() => setSnapshot(savedSupportState));
// Node isolates test files; release this file's channel only after its builds drain.
after(disposeEventLoopChannel);

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function eventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function repeatedModel(id: string, triangleCount: number, support = false): LoadedModel {
  // Six source vertices and byte-sized repeated indices emit arbitrarily many
  // triangles without allocating a huge input-position fixture.
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(MODEL_PATTERN.flatMap((triangle) => Array.from(triangle))), 3));
  const indices = new Uint8Array(triangleCount * 3);
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const vertex = (triangle % MODEL_PATTERN.length) * 3;
    indices[triangle * 3] = vertex;
    indices[triangle * 3 + 1] = vertex + 1;
    indices[triangle * 3 + 2] = vertex + 2;
  }
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox!;
  return {
    id, name: id, fileUrl: '', color: '#a3a3a3', visible: true,
    polygonCount: triangleCount, isSupportGeometry: support,
    geometry: { geometry, bbox, center: new THREE.Vector3(), size: bbox.getSize(new THREE.Vector3()), flatteningPlanes: [] },
    transform: { position: new THREE.Vector3(support ? 20 : 0, 0, 0), rotation: new THREE.Euler(), scale: new THREE.Vector3(1, 1, 1) },
  };
}

function build(models: LoadedModel[], flushBinaryMeshChunk: (chunk: Uint8Array) => Promise<void>, abortSignal?: AbortSignal): Promise<SolidSliceMeshForWasm> {
  return buildSolidSliceMeshForWasm({
    models, printerProfile, materialProfile, filenameBase: 'streaming-regression',
    meshChunkTargetBytes: TARGET_BYTES, flushBinaryMeshChunk, abortSignal,
  });
}

async function waitForUpload(started: Promise<void>, preparation: Promise<SolidSliceMeshForWasm>): Promise<void> {
  await Promise.race([
    started,
    preparation.then(() => assert.fail('preparation completed without the expected upload')),
  ]);
}

function assertChunkStorage(chunk: Uint8Array): void {
  assert.ok(chunk.byteLength > 0, 'no empty upload at a boundary');
  assert.equal(chunk.byteLength % TRIANGLE_BYTES, 0, 'every upload ends on a complete triangle');
  assert.ok(chunk.byteLength <= ALIGNED_CHUNK_BYTES, 'payload fits the triangle-aligned target');
  assert.ok(chunk.buffer.byteLength <= TARGET_BYTES, 'a small view must not retain a whole-mesh allocation');
}

function expectedChunk(startTriangle: number, triangleCount: number, modelTriangleCount: number): Uint8Array {
  const coordinates = new Float32Array(triangleCount * 9);
  for (let local = 0; local < triangleCount; local++) {
    const absolute = startTriangle + local;
    const support = absolute >= modelTriangleCount;
    const pattern = support ? SUPPORT_PATTERN : MODEL_PATTERN;
    const relative = support ? absolute - modelTriangleCount : absolute;
    coordinates.set(pattern[relative % pattern.length], local * 9);
  }
  return new Uint8Array(coordinates.buffer);
}

test('streaming uploads ordered raw f32 triangles with bounded storage and one immutable pending callback', { timeout: 30_000 }, async () => {
  const modelTriangleCount = CHUNK_TRIANGLES * 3 + 7;
  const model = repeatedModel('streaming-body', modelTriangleCount);
  const support = repeatedModel('streaming-support', 5, true);
  const firstStarted = deferred();
  const releaseFirst = deferred();
  let callbackCount = 0;
  let pendingCallbacks = 0;
  let uploadedTriangles = 0;
  let firstChunk: Uint8Array | undefined;
  let firstSnapshot: Uint8Array | undefined;
  let settled = false;
  const chunkLengths: number[] = [];
  const preparation = build([support, model], async (chunk) => {
    callbackCount++;
    if (callbackCount === 1) firstStarted.resolve();
    pendingCallbacks++;
    try {
      assert.equal(pendingCallbacks, 1, 'a second upload must wait for the pending callback');
      assertChunkStorage(chunk);
      chunkLengths.push(chunk.byteLength);
      assert.deepEqual(chunk, expectedChunk(uploadedTriangles, chunk.byteLength / TRIANGLE_BYTES, modelTriangleCount));
      uploadedTriangles += chunk.byteLength / TRIANGLE_BYTES;
      if (callbackCount === 1) {
        firstChunk = chunk;
        firstSnapshot = chunk.slice();
        await releaseFirst.promise;
        assert.deepEqual(chunk, firstSnapshot, 'upload bytes stay unchanged until its Promise settles');
      }
      await eventLoopTurn();
    } finally {
      pendingCallbacks--;
    }
  });
  void preparation.then(() => { settled = true; }, () => { settled = true; });
  try {
    await waitForUpload(firstStarted.promise, preparation);
    for (let turn = 0; turn < 3; turn++) await eventLoopTurn();
    assert.equal(callbackCount, 1, 'generation cannot queue a concurrent upload');
    assert.equal(settled, false, 'preparation waits for outstanding staging');
    assert.ok(firstChunk && firstSnapshot);
    assert.deepEqual(firstChunk, firstSnapshot, 'filling the next buffer does not overwrite the pending one');
    releaseFirst.resolve();
    const mesh = await preparation;
    assert.equal(mesh.modelTriangleCount, modelTriangleCount);
    assert.equal(uploadedTriangles, modelTriangleCount + 5, 'model body precedes support despite reverse input order');
    assert.deepEqual(chunkLengths, [ALIGNED_CHUNK_BYTES, ALIGNED_CHUNK_BYTES, ALIGNED_CHUNK_BYTES, 12 * TRIANGLE_BYTES]);
  } finally {
    releaseFirst.resolve();
    await preparation.catch(() => {});
    model.geometry.geometry.dispose();
    support.geometry.geometry.dispose();
  }
});

test('a rejected streamed upload propagates its error and stops subsequent callbacks', { timeout: 30_000 }, async () => {
  const model = repeatedModel('upload-rejection', CHUNK_TRIANGLES * 2 + 5);
  const started = deferred();
  const upload = deferred();
  const uploadError = new Error('native mesh stage rejected');
  let callbackCount = 0;
  const preparation = build([model], async (chunk) => {
    callbackCount++;
    started.resolve();
    assertChunkStorage(chunk);
    await upload.promise;
  });
  const rejected = assert.rejects(preparation, (error: unknown) => error === uploadError);
  void rejected.catch(() => {});
  try {
    await waitForUpload(started.promise, preparation);
    await eventLoopTurn();
    upload.reject(uploadError);
    await rejected;
    for (let turn = 0; turn < 3; turn++) await eventLoopTurn();
    assert.equal(callbackCount, 1, 'no queued chunk may upload after the native error');
  } finally {
    upload.resolve();
    await preparation.catch(() => {});
    model.geometry.geometry.dispose();
  }
});

test('abort stops further uploads but drains and preserves the pending callback before rejecting', { timeout: 30_000 }, async () => {
  const model = repeatedModel('upload-cancellation', CHUNK_TRIANGLES * 2 + 5);
  const controller = new AbortController();
  const started = deferred();
  const upload = deferred();
  let callbackCount = 0;
  let settled = false;
  let pendingChunk: Uint8Array | undefined;
  let pendingSnapshot: Uint8Array | undefined;
  const preparation = build([model], async (chunk) => {
    callbackCount++;
    pendingChunk = chunk;
    pendingSnapshot = chunk.slice();
    started.resolve();
    assertChunkStorage(chunk);
    await upload.promise;
    assert.deepEqual(chunk, pendingSnapshot, 'canceling cannot invalidate an in-flight IPC buffer');
  }, controller.signal);
  void preparation.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(preparation, (error: unknown) => error instanceof Error && error.name === 'AbortError');
  void rejected.catch(() => {});
  try {
    await waitForUpload(started.promise, preparation);
    controller.abort();
    for (let turn = 0; turn < 3; turn++) await eventLoopTurn();
    assert.equal(settled, false, 'cancel must wait for the callback that already owns the bytes');
    assert.equal(callbackCount, 1);
    assert.ok(pendingChunk && pendingSnapshot);
    assert.deepEqual(pendingChunk, pendingSnapshot);
    upload.resolve();
    await rejected;
    for (let turn = 0; turn < 3; turn++) await eventLoopTurn();
    assert.equal(callbackCount, 1, 'abort prevents uploading the filled successor buffer');
  } finally {
    upload.resolve();
    await preparation.catch(() => {});
    model.geometry.geometry.dispose();
  }
});

function contactDisk(id: string, x: number, z: number): ContactDisk {
  return {
    id, pos: { x, y: 0, z }, surfaceNormal: { x: 0, y: 0, z: 1 },
    coneAxis: { x: 0, y: 0, z: 1 }, contactDiameterMm: 0.5,
    profile: { type: 'disk', diskThicknessMm: 0.2, maxStandoffMm: 0.35, standoffAngleThreshold: Math.PI / 4 },
  };
}

test('generated support-only geometry streams every disk and terminal across chunk boundaries', { timeout: 30_000 }, async () => {
  const model = repeatedModel('generated-support-host', 1, true);
  const state = getSnapshot();
  const twigs: SupportState['twigs'] = {};
  // Two disks and their round terminals per row exceed the real minimum target
  // with only 1,200 compact authored support records, not a baked triangle soup.
  for (let i = 0; i < 1_200; i++) {
    const id = `streamed-twig-${i}`;
    const x = (i % 31) - 15;
    twigs[id] = {
      id, modelId: model.id, typeId: 'twig', segments: [],
      contactDiskA: contactDisk(`${id}-a`, x, 2 + (i % 5)),
      contactDiskB: contactDisk(`${id}-b`, x + 0.75, 8 + (i % 7)),
    };
  }
  setSnapshot({ ...state, twigs });
  const authoredTwigs = structuredClone(getSnapshot().twigs);
  try {
    const baseline = await buildSolidSliceMeshForWasm({
      models: [model], printerProfile, materialProfile, filenameBase: 'support-streaming-baseline',
    });
    const expected = new Uint8Array(baseline.trianglesXYZ.buffer, baseline.trianglesXYZ.byteOffset, baseline.trianglesXYZ.byteLength);
    assert.ok(expected.byteLength > TARGET_BYTES, 'generated primitives, not the host mesh, cross a full chunk');
    let uploadedBytes = 0;
    let callbackCount = 0;
    const streamed = await build([model], async (chunk) => {
      callbackCount++;
      assertChunkStorage(chunk);
      const snapshot = chunk.slice();
      assert.deepEqual(chunk, expected.subarray(uploadedBytes, uploadedBytes + chunk.byteLength));
      await eventLoopTurn();
      assert.deepEqual(chunk, snapshot, 'support generation retains pending primitive bytes');
      uploadedBytes += chunk.byteLength;
    });
    assert.ok(callbackCount >= 2, 'exercise support-generator suspension and continuation');
    assert.equal(uploadedBytes, expected.byteLength, 'all primitive geometry is drained, including the final terminal');
    assert.equal(streamed.modelTriangleCount, 0);
    assert.deepEqual(streamed.meshBounds, baseline.meshBounds);
    assert.equal(streamed.totalLayers, baseline.totalLayers);
    assert.deepEqual(getSnapshot().twigs, authoredTwigs, 'streaming leaves authored support data untouched');
  } finally {
    model.geometry.geometry.dispose();
  }
});

test('an exact full-chunk mesh completes without an empty or duplicated tail upload', { timeout: 30_000 }, async () => {
  const model = repeatedModel('exact-chunk-boundary', CHUNK_TRIANGLES);
  let callbackCount = 0;
  try {
    const mesh = await build([model], async (chunk) => {
      callbackCount++;
      assertChunkStorage(chunk);
      assert.equal(chunk.byteLength, ALIGNED_CHUNK_BYTES);
      assert.deepEqual(chunk, expectedChunk(0, CHUNK_TRIANGLES, CHUNK_TRIANGLES));
      await eventLoopTurn();
    });
    assert.equal(callbackCount, 1, 'finalization must not re-upload the full buffer');
    assert.equal(mesh.modelTriangleCount, CHUNK_TRIANGLES);
  } finally {
    model.geometry.geometry.dispose();
  }
});
