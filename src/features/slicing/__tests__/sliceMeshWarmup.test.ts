import assert from 'node:assert/strict';
import test from 'node:test';
import type { MaterialProfile, PrinterProfile } from '@/features/profiles/profileStore';
import { getSnapshot, setSnapshot } from '@/supports/state';
import { createEmptySupportCollections } from '@/supports/supportTypeRegistry';
import { getRaftSettings, setRaftSettings, updateRaftSettings } from '@/supports/Rafts/Crenelated/RaftState';
import { installFakeWindow } from '@/utils/__tests__/helpers/fakeWindow';
import { installFakeMeshChunkUpload } from '@/utils/__tests__/helpers/fakeMeshChunkUpload';
import { cubeModel } from './helpers/captureAppSliceJob';
import { SliceMeshWarmup, SLICE_MESH_CACHE_QUIET_MS } from '../sliceMeshWarmup';
import { prewarmSliceMesh, runWithSliceMesh } from '../sliceMeshSnapshot';
import type { SliceMeshPrewarmOptions } from '../sliceMeshSnapshot';

let nextFixture = 0;
function fixture(onBegin?: () => Promise<void>) {
  const model = cubeModel(`idle-warm-${++nextFixture}`, 2);
  const previousSupports = getSnapshot();
  const previousRaft = getRaftSettings();
  setSnapshot({ ...previousSupports, ...createEmptySupportCollections() });
  updateRaftSettings({ bottomMode: 'off' });
  const events = new EventTarget();
  const documentEvents = new EventTarget();
  const document = Object.assign(documentEvents, { hidden: false });
  const timers = new Map<number, () => void>();
  const delays = new Map<number, number>();
  const idle = new Map<number, () => void>();
  let nextId = 0;
  const storage = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  };
  const upload = installFakeMeshChunkUpload(async command => { throw new Error(`Unexpected operation during mesh prewarm: ${command}`); });
  const restoreWindow = installFakeWindow({
    document, localStorage, sessionStorage: localStorage,
    __TAURI_INTERNALS__: { invoke: async (...args: Parameters<typeof upload.invoke>) => {
      if (args[0] === 'mesh_chunk_upload_begin') await onBegin?.();
      return upload.invoke(...args);
    } },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    setTimeout: (callback: () => void, delay: number) => { const id = ++nextId; timers.set(id, callback); delays.set(id, delay); return id; },
    clearTimeout: (id: number) => { timers.delete(id); delays.delete(id); },
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
    model, options, upload, warmer, timers, delays, idle, document,
    quiet: () => flush(timers), idleTurn: () => flush(idle),
    pointer(type: string, pointerId = 1) { events.dispatchEvent(Object.assign(new Event(type), { pointerId })); },
    dispose() {
      warmer.dispose();
      restoreWindow(); upload.restore();
      setSnapshot(previousSupports); setRaftSettings(previousRaft);
      model.geometry.geometry.dispose();
    },
  };
}

test('scene cache waits fifteen seconds and idle, then keeps equivalent inputs worker-free', async () => {
  const f = fixture();
  try {
    f.warmer.update(f.options);
    const delay = [...f.delays.values()][0];
    assert.ok(delay > SLICE_MESH_CACHE_QUIET_MS - 100 && delay <= SLICE_MESH_CACHE_QUIET_MS,
      'initial import preparation uses the full independent quiet deadline');
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



test('busy import/transient windows retain only the latest dirty input', async () => {
  const f = fixture();
  try {
    f.warmer.update(f.options, 1, false);
    f.quiet(); f.idleTurn();
    f.model.transform.position.x += 1;
    f.warmer.update(f.options, 2, false);
    assert.equal(f.timers.size, 0);
    assert.equal(f.upload.readStats().workerStarts, 0);
    f.warmer.update(f.options, 2, true);
    assert.equal(f.timers.size, 1, 'settled import arms one quiet deadline');
    f.quiet();
    f.warmer.update(f.options, 2, true, true);
    f.idleTurn();
    assert.equal(f.upload.readStats().workerStarts, 0, 'Slice busy cancels only scheduled idle work');
    f.warmer.update(f.options, 2, true, false);
    f.quiet(); f.idleTurn();
    await prewarmSliceMesh(f.options);
    assert.equal(f.upload.readStats().uploadBegins, 1);
    const before = f.upload.readStats();
    f.warmer.update(f.options, 3);
    f.quiet(); f.idleTurn();
    assert.deepEqual(f.upload.readStats(), before, 'a content notification with an unchanged signature does no work');
    assert.equal(f.timers.size, 0, 'a clean cache has no periodic deadline');
  } finally { f.dispose(); }
});

test('Slice adopts matching in-flight preparation without the busy pause aborting it', async () => {
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const f = fixture(async () => { entered(); await blocked; });
  try {
    f.warmer.update(f.options, 1);
    f.quiet(); f.idleTurn();
    await started;
    const before = f.upload.readStats();
    f.warmer.update(f.options, 1, true, true);
    const foreground = runWithSliceMesh(f.options, undefined, () => {}, async (descriptor) => descriptor);
    f.warmer.cancel(); // Explicit Cancel releases only the background subscriber.
    release();
    const mesh = await foreground;
    assert.ok(mesh.modelTriangleCount > 0);
    assert.equal(f.upload.readStats().workerStarts, before.workerStarts, 'foreground joins the existing worker');
    assert.equal(f.upload.readStats().uploadBegins, 1);
    assert.equal(f.upload.readStats().restoreCalls, 1);
  } finally { release(); f.dispose(); }
});
