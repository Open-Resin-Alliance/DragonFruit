import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { MaterialProfile, PrinterProfile } from '@/features/profiles/profileStore';
import { storeModelMeshModifiers, deleteStoredMeshModifiers } from '@/features/mesh-modifiers/meshModifierStore';
import { clearPreparedGeometryCacheForModel } from '@/features/mesh-modifiers/prepareModelGeometry';
import { getSnapshot, setSnapshot, setSelectedId } from '@/supports/state';
import { createEmptySupportCollections } from '@/supports/supportTypeRegistry';
import { getRaftSettings, setRaftSettings, updateRaftSettings } from '@/supports/Rafts/Crenelated/RaftState';
import { runExclusiveNativeMesh } from '@/utils/tauriMeshBridge';
import { installFakeWindow } from '@/utils/__tests__/helpers/fakeWindow';
import { installFakeMeshChunkUpload } from '@/utils/__tests__/helpers/fakeMeshChunkUpload';
import { cubeModel } from './helpers/captureAppSliceJob';
import {
  prewarmSliceMesh, runSliceExportOrchestrator, getSliceMeshInputSignature,
  equalSliceMeshInputSignatures, subscribeSliceMeshInputChanges,
  type SliceExportOrchestratorOptions,
} from '../sliceExportOrchestrator';

let nextFixture = 0;
function fixture(hollow = false) {
  const model = cubeModel(`warm-snapshot-${++nextFixture}`, 2);
  const previousSupports = getSnapshot();
  const previousRaft = getRaftSettings();
  setSnapshot({ ...previousSupports, ...createEmptySupportCollections() });
  updateRaftSettings({ bottomMode: 'off' });
  const position = model.geometry.geometry.getAttribute('position');
  const originalGetX = position.getX.bind(position);
  let vertexReads = 0;
  position.getX = (index: number) => { vertexReads += 1; return originalGetX(index); };
  const hollowing = {
    enabled: true, bakedIntoGeometry: false, mode: 'cavity' as const,
    voxelSizeMm: 0.5, shellThicknessMm: 0.4, openFace: 'z_max' as const,
    sourcePositionsBase64: Buffer.from(position.array.buffer).toString('base64'),
    sourcePositionCount: position.count,
  };
  if (hollow) storeModelMeshModifiers(model.id, { hollowing });
  let hollowCalls = 0;
  let slices = 0;
  let onHollow: (() => Promise<void>) | undefined;
  const jobs: Array<Record<string, unknown>> = [];
  const slicedBytes: Uint8Array[] = [];
  const reachedSlicer = new Error('captured warm snapshot slice');
  const upload = installFakeMeshChunkUpload(async (command, args) => {
    switch (command) {
      case 'mesh_hollow_staged':
        hollowCalls += 1;
        await onHollow?.();
        upload.replaceStaged(new Uint8Array(position.array.buffer));
        return JSON.stringify({ removedVoxels: 1 });
      case 'mesh_repair_read_positions': return upload.readStaged();
      case 'mesh_hollow_staged_read_cavity_positions': return new Uint8Array(0);
      case 'plugin:event|listen': return 1;
      case 'plugin:event|unlisten': return;
      case 'cancel_slicing': return;
      case 'slice_solid_native_to_temp_path':
        slices += 1;
        assert.ok(args && typeof args === 'object' && 'jobJson' in args && typeof args.jobJson === 'string');
        jobs.push(JSON.parse(args.jobJson));
        slicedBytes.push(upload.readStaged());
        throw reachedSlicer;
      default: throw new Error(`Unexpected native command: ${command}`);
    }
  });
  const restoreWindow = installFakeWindow({
    dispatchEvent: () => true,
    addEventListener: () => {}, removeEventListener: () => {},
    __TAURI_INTERNALS__: { invoke: upload.invoke, transformCallback: () => 1 },
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
  });
  const options: SliceExportOrchestratorOptions = {
    models: [model], filenameBase: 'warm-snapshot', outputMode: 'return',
    printerProfile: {
      id: 'warm-printer', name: 'Warm printer',
      buildVolumeMm: { width: 20, depth: 20, height: 20 },
      display: { resolutionX: 64, resolutionY: 64, outputFormat: '.ctb' },
    } as PrinterProfile,
    materialProfile: { id: 'warm-material', name: 'Warm material', layerHeightMm: 0.05 } as MaterialProfile,
  };
  return {
    model, position, options, upload, hollowing, jobs, slicedBytes,
    get hollowCalls() { return hollowCalls; }, get slices() { return slices; },
    get vertexReads() { return vertexReads; },
    setOnHollow(callback: () => Promise<void>) { onHollow = callback; },
    slice(extra: Partial<SliceExportOrchestratorOptions> = {}) {
      return assert.rejects(runSliceExportOrchestrator({ ...options, ...extra }), reachedSlicer);
    },
    dispose() {
      restoreWindow(); upload.restore();
      setSnapshot(previousSupports); setRaftSettings(previousRaft);
      clearPreparedGeometryCacheForModel(model.id); deleteStoredMeshModifiers(model.id);
      model.geometry.geometry.dispose();
    },
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('idle prewarm bakes and uploads before the first slice; repeated exports only restore and still slice', async () => {
  const f = fixture(true);
  try {
    await prewarmSliceMesh(f.options);
    assert.equal(f.hollowCalls, 1);
    assert.equal(f.slices, 0, 'prewarm never starts the slicer');
    const warmed = f.upload.readStats();
    const reads = f.vertexReads;
    await f.slice();
    await f.slice({ exportThumbnailPng: new Uint8Array([9, 8, 7]), outputPath: '/different/output.ctb',
      materialProfile: { ...f.options.materialProfile, name: 'Fresh job metadata' } });
    assert.equal(f.hollowCalls, 1, 'warm start bypasses modifier preparation');
    assert.equal(f.vertexReads, reads, 'warm start bypasses world-mesh assembly');
    assert.equal(f.upload.readStats().workerStarts, warmed.workerStarts, 'warm start does not create a hashing worker');
    assert.equal(f.upload.readStats().uploadBegins, warmed.uploadBegins, 'warm start does not begin an upload');
    assert.equal(f.slices, 2, 'rendered layers are recomputed on every export');
    assert.deepEqual(f.slicedBytes[0], f.slicedBytes[1]);
    assert.equal(f.jobs[1].export_thumbnail_png_base64, Buffer.from([9, 8, 7]).toString('base64'));
    assert.equal(f.jobs[1].output_path, '/different/output.ctb');
    assert.notEqual(f.jobs[0].metadata_json, f.jobs[1].metadata_json, 'job metadata is assembled fresh');
  } finally { f.dispose(); }
});

test('geometry, exact transforms, partition, tanks, raft, supports and plate settings invalidate; interaction does not', async () => {
  const f = fixture();
  try {
    await prewarmSliceMesh(f.options);
    const first = f.upload.readStats().uploadBegins;
    const beforeInteraction = getSliceMeshInputSignature(f.options);
    const warmedVertexReads = f.vertexReads;
    setSnapshot({ ...getSnapshot(), hoveredId: f.model.id, hoveredCategory: 'model', selectedId: f.model.id, selectedCategory: null });
    f.options.models = [{ ...f.model, color: '#ffffff' }];
    assert.equal(equalSliceMeshInputSignatures(beforeInteraction, getSliceMeshInputSignature(f.options)), true);
    await f.slice();
    assert.equal(f.upload.readStats().uploadBegins, first);
    assert.equal(f.vertexReads, warmedVertexReads, 'warm unmodified geometry does not reassemble world triangles');
    const invalidate = async (change: () => void, label: string) => {
      const starts = f.upload.readStats().uploadBegins;
      change(); await f.slice();
      assert.ok(f.upload.readStats().uploadBegins > starts, label);
    };
    // Use the live object after the UI-only clone above.
    f.options.models = [f.model];
    await invalidate(() => { f.position.setX(0, f.position.getX(0) + 0.01); f.position.needsUpdate = true; }, 'position revision');
    await invalidate(() => { f.model.geometry.geometry.setAttribute('position', f.position.clone()); }, 'same-sized attribute replacement');
    await invalidate(() => { f.model.geometry.geometry.setIndex(Array.from({ length: f.position.count }, (_, index) => index)); }, 'index identity');
    await invalidate(() => { const index = f.model.geometry.geometry.getIndex()!; index.needsUpdate = true; }, 'index revision');
    await invalidate(() => { f.model.transform.position.x += 0.00000001; }, 'unrounded transform');
    await invalidate(() => { f.model.isSupportGeometry = true; }, 'classification boundary');
    await invalidate(() => { f.model.isSupportGeometry = false; }, 'classification restore');
    await invalidate(() => {
      f.options.printerProfile = { ...f.options.printerProfile, materialMode: 'multiTank', tankMaterials: ['a', 'b'] };
      f.model.materialProfileId = 'b';
    }, 'tank mapping');
    await invalidate(() => { f.model.splitBodies = [f.model.geometry, f.model.geometry]; f.model.bodyMaterialProfileIds = ['a', 'b']; }, 'body geometry and tank references');
    await invalidate(() => { f.model.bodyMaterialProfileIds = ['b', 'a']; }, 'per-body assignments');
    await invalidate(() => { updateRaftSettings({ bottomMode: 'solid', thickness: 0.7 }); }, 'raft settings');
    await invalidate(() => {
      setSnapshot({ ...getSnapshot(), roots: { r: { id: 'r', modelId: f.model.id,
        diameter: 2, diskHeight: 0.2, coneHeight: 0.3,
        transform: { pos: { x: 4, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } } } } });
    }, 'support geometry collection');
    await invalidate(() => { f.options.plateOffsetMm = { dxMm: 0.25, dyMm: 0 }; }, 'plate origin');
    await invalidate(() => { f.options.plateVolumeBoundsMm = { minX: -9, minY: -10, maxX: 10, maxY: 10 }; }, 'plate volume');
    await invalidate(() => { f.options.printerProfile = { ...f.options.printerProfile, buildVolumeMm: { ...f.options.printerProfile.buildVolumeMm, width: 21 } }; }, 'printer build dimensions');
    await invalidate(() => { f.options.printerProfile = { ...f.options.printerProfile, display: { ...f.options.printerProfile.display, resolutionX: 128 } }; }, 'raster descriptor');
    await invalidate(() => { f.options.antiAliasing = { preset: 'balanced', override: { antiAliasingSettings: {
      enableOverride: true, mode: '3DAA', level: '8x', supportTipShrinkPercent: 25,
    } } }; }, 'AA support-tip shrink');
    await invalidate(() => { storeModelMeshModifiers(f.model.id, { hollowing: { ...f.hollowing, shellThicknessMm: 0.6 } }); }, 'modifier revision');
  } finally { f.dispose(); }
});

test('a retained native miss releases the stage queue before cold modifier baking', { timeout: 10_000 }, async () => {
  const f = fixture(true);
  try {
    await prewarmSliceMesh(f.options);
    f.upload.discardSliceSnapshot();
    clearPreparedGeometryCacheForModel(f.model.id);
    await f.slice();
    assert.equal(f.hollowCalls, 2, 'a real cold native pass can acquire the queue after the restore miss');
    assert.equal(f.slices, 1);
  } finally { f.dispose(); }
});

test('export joins identical in-flight prewarm and keeps it alive after the background subscriber cancels', { timeout: 10_000 }, async () => {
  const f = fixture(true);
  const entered = deferred();
  const release = deferred();
  const controller = new AbortController();
  f.setOnHollow(async () => { entered.resolve(); await release.promise; });
  try {
    const warming = prewarmSliceMesh(f.options, controller.signal);
    const warmingRejected = assert.rejects(warming, { name: 'AbortError' });
    await entered.promise;
    const exporting = f.slice();
    // Export's availability check yields before it joins the in-flight work.
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    release.resolve();
    await Promise.all([warmingRejected, exporting]);
    assert.equal(f.hollowCalls, 1);
    assert.equal(f.slices, 1);
    assert.equal(f.upload.readStats().uploadBegins, 2, 'one modifier input upload and one final mesh upload');
  } finally { release.resolve(); f.dispose(); }
});

test('an input revision during asynchronous baking never publishes a stale descriptor', async () => {
  const f = fixture(true);
  const entered = deferred();
  const release = deferred();
  let blocked = true;
  f.setOnHollow(async () => { if (blocked) { entered.resolve(); await release.promise; } });
  try {
    const warming = prewarmSliceMesh(f.options);
    await entered.promise;
    f.model.transform.position.z += 1;
    blocked = false;
    release.resolve();
    await warming;
    const before = f.upload.readStats().uploadBegins;
    await f.slice();
    assert.ok(f.upload.readStats().uploadBegins > before, 'stale signature must not be a warm hit');
    assert.equal(f.jobs[0].total_layers, 60, 'the descriptor belongs to the current translated mesh');
  } finally { release.resolve(); f.dispose(); }
});

test('cancelled queued preparation releases ownership and subscriptions ignore selection and dispose cleanly', async () => {
  const f = fixture();
  const controller = new AbortController();
  const entered = deferred();
  const release = deferred();
  let notifications = 0;
  const unsubscribe = subscribeSliceMeshInputChanges(() => { notifications += 1; });
  try {
    setSelectedId(f.model.id);
    assert.equal(notifications, 0);
    updateRaftSettings({ thickness: 0.8 });
    assert.equal(notifications, 1);
    unsubscribe();
    updateRaftSettings({ thickness: 0.9 });
    assert.equal(notifications, 1);
    const blocking = runExclusiveNativeMesh(async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const warming = prewarmSliceMesh(f.options, controller.signal);
    controller.abort();
    await assert.rejects(warming, { name: 'AbortError' });
    release.resolve(); await blocking;
    await f.slice();
    assert.equal(f.slices, 1, 'cancelled queue work cannot strand future slice ownership');
  } finally { unsubscribe(); release.resolve(); f.dispose(); }
});


test('warm crossing-boundary exports avoid the precise visibility vertex walk', async () => {
  const f = fixture();
  try {
    f.model.transform.position.x = 10;
    await prewarmSliceMesh(f.options);
    const reads = f.vertexReads;
    assert.ok(reads > 0, 'the cold boundary filter and world producer read vertices');
    await f.slice();
    assert.equal(f.vertexReads, reads, 'cached source membership bypasses both vertex walks');
  } finally { f.dispose(); }
});

test('cancelling an active bake cannot publish a final snapshot or strand the next slice', { timeout: 10_000 }, async () => {
  const f = fixture(true);
  const entered = deferred();
  const release = deferred();
  const controller = new AbortController();
  f.setOnHollow(async () => { entered.resolve(); await release.promise; });
  try {
    const warming = prewarmSliceMesh(f.options, controller.signal);
    const rejected = assert.rejects(warming, { name: 'AbortError' });
    await entered.promise;
    controller.abort();
    await rejected;
    release.resolve();
    await f.slice();
    assert.equal(f.hollowCalls, 1, 'already-computed unchanged native output remains reusable');
    assert.equal(f.upload.readStats().uploadBegins, 2, 'only the active modifier input and next live final input are uploaded');
    assert.equal(f.slices, 1);
  } finally { release.resolve(); f.dispose(); }
});


test('equivalent output modifiers and unapplied hole drafts keep the prepared slice snapshot', async () => {
  const f = fixture(true);
  try {
    const original = {
      hollowing: { ...f.hollowing, blockedVoxelIndices: [1, 2] },
      holePunchSourcePositionsBase64: f.hollowing.sourcePositionsBase64,
      holePunchSourcePositionCount: f.hollowing.sourcePositionCount,
      holePunchesBakedIntoGeometry: false,
      holePunches: [{ id: 'draft', centerNorm: [0.1, 0.2, 0.3] as [number, number, number], radiusMm: 0.2,
        depthMm: 1, direction: [0, 0, 1] as [number, number, number] }],
    };
    storeModelMeshModifiers(f.model.id, original);
    await prewarmSliceMesh(f.options);
    const signature = getSliceMeshInputSignature(f.options);
    const before = f.upload.readStats();
    const replacement = { ...original, hollowing: { ...original.hollowing, blockedVoxelIndices: [1, 2] },
      holePunches: original.holePunches.map(hole => ({ ...hole, radiusMm: 0.3 })) };
    storeModelMeshModifiers(f.model.id, replacement);
    assert.equal(equalSliceMeshInputSignatures(signature, getSliceMeshInputSignature(f.options)), true,
      'fresh wrappers, equal blockers and unapplied hole changes cannot alter printed mesh inputs');
    await f.slice();
    assert.equal(f.hollowCalls, 1);
    assert.equal(f.upload.readStats().workerStarts, before.workerStarts);
    replacement.hollowing.blockedVoxelIndices.push(3);
    storeModelMeshModifiers(f.model.id, replacement);
    await f.slice();
    assert.equal(f.hollowCalls, 2, 'a notified real blocker edit still invalidates the effective input');
  } finally { f.dispose(); }
});


test('restoring blocker-valid rotation never aliases an explicitly cleared keep mask', () => {
  const f = fixture(true);
  try {
    const hollowing = { ...f.hollowing, blockedVoxelIndices: [1, 2],
      blockedVoxelRotationQuat: [0, 0, 0, 1] as [number, number, number, number] };
    storeModelMeshModifiers(f.model.id, { hollowing });
    f.model.transform.rotation.z = Math.PI / 2;
    getSliceMeshInputSignature(f.options); // Pose makes the stored indices stale.
    f.model.transform.rotation.z = 0;
    const restored = getSliceMeshInputSignature(f.options);
    storeModelMeshModifiers(f.model.id, { hollowing: { ...hollowing, blockedVoxelIndices: [] } });
    assert.equal(equalSliceMeshInputSignatures(restored, getSliceMeshInputSignature(f.options)), false,
      'valid blocked voxels and an empty mask must not reuse the same native mesh snapshot');
  } finally { f.dispose(); }
});


test('cold export consumes fresh input once when native retention is unavailable', async () => {
  const f = fixture(true);
  try {
    f.upload.setSliceRetention(false);
    await f.slice();
    assert.equal(f.hollowCalls, 1);
    assert.equal(f.upload.readStats().uploadBegins, 2, 'one modifier input and one final input, never a repeated fallback upload');
    assert.equal(f.upload.readStats().restoreCalls, 0, 'fresh staged input does not require a snapshot restore');
    assert.equal(f.slices, 1);
    assert.deepEqual(f.slicedBytes[0], new Uint8Array(f.position.array.buffer, f.position.array.byteOffset, f.position.array.byteLength));
  } finally { f.dispose(); }
});

test('background preparation joins a cold export already in flight without another final upload', { timeout: 10_000 }, async () => {
  const f = fixture(true);
  const entered = deferred();
  const release = deferred();
  f.setOnHollow(async () => { entered.resolve(); await release.promise; });
  try {
    const exporting = f.slice();
    await entered.promise;
    const background = prewarmSliceMesh(f.options);
    release.resolve();
    await Promise.all([exporting, background]);
    assert.equal(f.hollowCalls, 1);
    assert.equal(f.upload.readStats().uploadBegins, 2);
    assert.equal(f.slices, 1);
    assert.deepEqual(f.slicedBytes[0], new Uint8Array(f.position.array.buffer, f.position.array.byteOffset, f.position.array.byteLength));
  } finally { release.resolve(); f.dispose(); }
});
