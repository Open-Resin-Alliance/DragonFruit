import assert from 'node:assert/strict';
import test from 'node:test';
import type { MaterialProfile, PrinterProfile } from '@/features/profiles/profileStore';
import { storeModelMeshModifiers, deleteStoredMeshModifiers } from '@/features/mesh-modifiers/meshModifierStore';
import { clearPreparedGeometryCacheForModel } from '@/features/mesh-modifiers/prepareModelGeometry';
import { getSnapshot, setSnapshot } from '@/supports/state';
import { createEmptySupportCollections } from '@/supports/supportTypeRegistry';
import { getRaftSettings, setRaftSettings, updateRaftSettings } from '@/supports/Rafts/Crenelated/RaftState';
import { installFakeWindow } from '@/utils/__tests__/helpers/fakeWindow';
import { installFakeMeshChunkUpload } from '@/utils/__tests__/helpers/fakeMeshChunkUpload';
import { cubeModel } from './helpers/captureAppSliceJob';
import { SliceMeshWarmup } from '../sliceMeshWarmup';
import { prewarmSliceMesh, runWithSliceMesh } from '../sliceMeshSnapshot';
import type { SliceMeshPrewarmOptions } from '../sliceMeshSnapshot';

let nextFixture = 0;
function fixture(hollow = false) {
  const model = cubeModel(`idle-warm-${++nextFixture}`, 2);
  const position = model.geometry.geometry.getAttribute('position');
  if (hollow) storeModelMeshModifiers(model.id, { hollowing: {
    enabled: true, bakedIntoGeometry: false, mode: 'cavity',
    voxelSizeMm: 0.5, shellThicknessMm: 0.4, openFace: 'z_max',
    sourcePositionsBase64: Buffer.from(position.array.buffer).toString('base64'),
    sourcePositionCount: position.count,
  } });
  let hollowCalls = 0;
  let onHollow: (() => Promise<void>) | undefined;
  const previousSupports = getSnapshot();
  const previousRaft = getRaftSettings();
  setSnapshot({ ...previousSupports, ...createEmptySupportCollections() });
  updateRaftSettings({ bottomMode: 'off' });
  const events = new EventTarget();
  const documentEvents = new EventTarget();
  const document = Object.assign(documentEvents, { hidden: false });
  const timers = new Map<number, () => void>();
  const idle = new Map<number, () => void>();
  let nextId = 0;
  const storage = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  };
  const upload = installFakeMeshChunkUpload(async command => {
    switch (command) {
      case 'mesh_hollow_staged':
        hollowCalls += 1;
        await onHollow?.();
        upload.replaceStaged(new Uint8Array(position.array.buffer));
        return JSON.stringify({ removedVoxels: 1 });
      case 'mesh_repair_read_positions': return upload.readStaged();
      case 'mesh_hollow_staged_read_cavity_positions': return new Uint8Array(0);
      default: throw new Error('Unexpected operation during mesh prewarm: ' + command);
    }
  });
  const restoreWindow = installFakeWindow({
    document, localStorage, sessionStorage: localStorage,
    __TAURI_INTERNALS__: { invoke: upload.invoke },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    setTimeout: (callback: () => void) => { const id = ++nextId; timers.set(id, callback); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
    requestIdleCallback: (callback: () => void) => { const id = ++nextId; idle.set(id, callback); return id; },
    cancelIdleCallback: (id: number) => { idle.delete(id); },
  });
  const options: SliceMeshPrewarmOptions = {
    models: [model],
    printerProfile: {
      id: 'idle-warm-printer', name: 'Idle warm printer',
      buildVolumeMm: { width: 20, depth: 20, height: 20 },
      display: { resolutionX: 64, resolutionY: 64, outputFormat: '.ctb' },
    } as PrinterProfile,
    materialProfile: { id: 'idle-warm-resin', name: 'Idle warm resin', layerHeightMm: 0.05 } as MaterialProfile,
  };
  const warmer = new SliceMeshWarmup(window);
  const flush = (callbacks: Map<number, () => void>) => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    for (const callback of pending) callback();
  };
  return {
    model, options, upload, warmer, timers, idle, document,
    get hollowCalls() { return hollowCalls; },
    setOnHollow(callback: () => Promise<void>) { onHollow = callback; },
    quiet: () => flush(timers), idleTurn: () => flush(idle),
    pointer(type: string, pointerId = 1) { events.dispatchEvent(Object.assign(new Event(type), { pointerId })); },
    dispose() {
      warmer.dispose();
      restoreWindow(); upload.restore();
      setSnapshot(previousSupports); setRaftSettings(previousRaft);
      clearPreparedGeometryCacheForModel(model.id); deleteStoredMeshModifiers(model.id);
      model.geometry.geometry.dispose();
    },
  };
}

test('active context warms exact input before a job, only after quiet/idle and pointer release', async () => {
  const f = fixture();
  try {
    f.warmer.update(f.options);
    assert.equal(f.upload.readStats().uploadBegins, 0);
    f.quiet();
    assert.equal(f.upload.readStats().uploadBegins, 0, 'quiet period alone does not force work on a busy UI');
    assert.equal(f.idle.size, 1);
    f.pointer('pointerdown');
    f.idleTurn();
    assert.equal(f.upload.readStats().uploadBegins, 0, 'dragging cancels scheduled preparation');
    f.pointer('pointerup');
    f.quiet(); f.idleTurn();
    await prewarmSliceMesh(f.options); // Joins work the actual idle callback already started.
    const position = f.model.geometry.geometry.getAttribute('position');
    assert.deepEqual(f.upload.readStaged(), new Uint8Array(position.array.buffer, position.array.byteOffset, position.array.byteLength));
    const before = f.upload.readStats();
    f.warmer.update({ ...f.options, models: [{ ...f.model, color: '#ffffff' }] });
    setSnapshot({ ...getSnapshot(), hoveredId: f.model.id, hoveredCategory: 'model', selectedId: f.model.id });
    f.pointer('pointerdown'); f.pointer('pointerup');
    f.quiet(); f.idleTurn();
    assert.deepEqual(f.upload.readStats(), before, 'interaction and equivalent option wrappers never restart preparation');
  } finally { f.dispose(); }
});

test('new geometry supersedes scheduled input and unmount removes all warmup work', async () => {
  const f = fixture();
  try {
    f.warmer.update(f.options);
    f.quiet();
    f.model.transform.position.x += 0.25;
    f.warmer.update(f.options);
    assert.equal(f.idle.size, 0, 'the obsolete input cannot run from its old idle callback');
    f.quiet(); f.idleTurn();
    await prewarmSliceMesh(f.options);
    const position = f.model.geometry.geometry.getAttribute('position');
    const expected = new Float32Array(position.array);
    for (let i = 0; i < expected.length; i += 3) expected[i] += 0.25;
    assert.deepEqual(f.upload.readStaged(), new Uint8Array(expected.buffer));
    assert.equal(f.upload.readStats().uploadBegins, 1);
    f.model.transform.position.y += 0.5;
    f.warmer.update(f.options);
    f.warmer.dispose();
    f.quiet(); f.idleTurn();
    setSnapshot({ ...getSnapshot(), roots: {} });
    assert.equal(f.timers.size, 0);
    assert.equal(f.idle.size, 0);
    assert.equal(f.upload.readStats().uploadBegins, 1, 'disposed context cannot stage another mesh');
  } finally { f.dispose(); }
});

test('hidden slicing context waits until visible rather than starting native work', async () => {
  const f = fixture();
  try {
    f.document.hidden = true;
    f.warmer.update(f.options);
    f.quiet(); f.idleTurn();
    assert.equal(f.upload.readStats().uploadBegins, 0);
    f.document.hidden = false;
    f.document.dispatchEvent(new Event('visibilitychange'));
    f.quiet(); f.idleTurn();
    await prewarmSliceMesh(f.options);
    assert.equal(f.upload.readStats().uploadBegins, 1);
  } finally { f.dispose(); }
});


test('cancel pauses unchanged background preparation until the next real edit', async () => {
  const f = fixture();
  try {
    f.warmer.update(f.options);
    f.quiet();
    f.warmer.cancel();
    f.idleTurn();
    f.warmer.update({ ...f.options });
    f.pointer('pointerdown'); f.pointer('pointerup');
    f.quiet(); f.idleTurn();
    assert.equal(f.upload.readStats().uploadBegins, 0, 'cancelling cannot immediately restart the same work');
    f.model.transform.position.z += 0.25;
    f.warmer.update(f.options);
    f.quiet(); f.idleTurn();
    await prewarmSliceMesh(f.options);
    assert.equal(f.upload.readStats().uploadBegins, 1);
    const source = f.model.geometry.geometry.getAttribute('position');
    const expected = new Float32Array(source.array);
    for (let i = 2; i < expected.length; i += 3) expected[i] += 0.25;
    assert.deepEqual(f.upload.readStaged(), new Uint8Array(expected.buffer));
  } finally { f.dispose(); }
});

test('partial import and transient geometry revisions wait for the settled scene', async () => {
  const f = fixture();
  try {
    f.warmer.update(f.options, false, false);
    f.quiet(); f.idleTurn();
    f.model.transform.position.x += 0.25;
    f.warmer.update(f.options, false, false);
    setSnapshot({ ...getSnapshot(), roots: {} });
    f.quiet(); f.idleTurn();
    assert.equal(f.upload.readStats().uploadBegins, 0, 'producer notifications cannot warm a partial batch');
    f.warmer.update(f.options, false, true);
    f.quiet(); f.idleTurn();
    await prewarmSliceMesh(f.options);
    assert.equal(f.upload.readStats().uploadBegins, 1);
    const completed = f.upload.readStats();
    f.warmer.update(f.options, false, false);
    f.warmer.update(f.options, false, true);
    f.quiet(); f.idleTurn();
    assert.deepEqual(f.upload.readStats(), completed, 'suspending the UI does not repeat completed cache work');
  } finally { f.dispose(); }
});

test('scene suspension preserves explicit cancellation until an actual source attribute revision', async () => {
  const f = fixture();
  try {
    f.warmer.update(f.options);
    f.warmer.cancel();
    f.warmer.update(f.options, false, false);
    f.warmer.update(f.options, true, true);
    f.quiet(); f.idleTurn();
    assert.equal(f.upload.readStats().uploadBegins, 0, 'readiness and imminent intent are not real edits');
    const position = f.model.geometry.geometry.getAttribute('position');
    position.setX(0, position.getX(0) + 0.01);
    position.needsUpdate = true;
    f.warmer.update(f.options);
    f.quiet(); f.idleTurn();
    await prewarmSliceMesh(f.options);
    assert.equal(f.upload.readStats().uploadBegins, 1, 'source attribute version invalidates the cancelled context');
    f.warmer.update({ ...f.options, models: [] });
    f.pointer('pointerdown'); f.pointer('pointerup');
    setSnapshot({ ...getSnapshot(), roots: {} });
    f.quiet(); f.idleTurn();
    assert.equal(f.timers.size, 0);
    assert.equal(f.idle.size, 0);
  } finally { f.dispose(); }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('Slice startup pauses new work without dropping preparation before foreground adoption', { timeout: 10_000 }, async () => {
  const f = fixture(true);
  const entered = deferred();
  const release = deferred();
  f.setOnHollow(async () => { entered.resolve(); await release.promise; });
  try {
    f.warmer.update(f.options);
    f.quiet(); f.idleTurn();
    await entered.promise;
    // Busy is published before thumbnail/save awaits, before export subscribes.
    f.warmer.update(f.options, true, true, true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const exporting = runWithSliceMesh(f.options, undefined, () => {}, async () => 'consumed');
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.warmer.cancel(); // Releases only background ownership after foreground joins.
    release.resolve();
    assert.equal(await exporting, 'consumed');
    assert.equal(f.hollowCalls, 1, 'busy startup must not discard the only in-flight producer');
    assert.equal(f.upload.readStats().uploadBegins, 2, 'one modifier input and one final assembled mesh');
    const completed = f.upload.readStats();
    f.warmer.update(f.options, false, true, false);
    f.quiet(); f.idleTurn();
    assert.deepEqual(f.upload.readStats(), completed, 'unbusy does not restart completed or explicitly cancelled input');
  } finally { release.resolve(); f.dispose(); }
});

test('busy scene defers a new revision until foreground work finishes', async () => {
  const f = fixture();
  try {
    f.warmer.update(f.options, false, true, true);
    f.pointer('pointerdown'); f.pointer('pointerup');
    setSnapshot({ ...getSnapshot(), roots: {} });
    f.quiet(); f.idleTurn();
    assert.equal(f.upload.readStats().uploadBegins, 0, 'busy context cannot start a background producer');
    f.model.transform.position.x += 0.25;
    f.warmer.update(f.options, false, true, true);
    f.quiet(); f.idleTurn();
    assert.equal(f.upload.readStats().uploadBegins, 0);
    f.warmer.update(f.options, false, true, false);
    f.quiet(); f.idleTurn();
    await prewarmSliceMesh(f.options);
    assert.equal(f.upload.readStats().uploadBegins, 1, 'unbusy schedules only the latest settled revision');
  } finally { f.dispose(); }
});
