import assert from 'node:assert/strict';
import test from 'node:test';
import type { MaterialProfile, PrinterProfile } from '@/features/profiles/profileStore';
import { getSnapshot, setSnapshot } from '@/supports/state';
import { createEmptySupportCollections } from '@/supports/supportTypeRegistry';
import { getRaftSettings, setRaftSettings, updateRaftSettings } from '@/supports/Rafts/Crenelated/RaftState';
import { installFakeWindow } from '@/utils/__tests__/helpers/fakeWindow';
import { installFakeMeshChunkUpload } from '@/utils/__tests__/helpers/fakeMeshChunkUpload';
import { cubeModel } from './helpers/captureAppSliceJob';
import { SliceMeshWarmup } from '../sliceMeshWarmup';
import { prewarmSliceMesh } from '../sliceMeshSnapshot';
import type { SliceMeshPrewarmOptions } from '../sliceMeshSnapshot';

let nextFixture = 0;
function fixture() {
  const model = cubeModel(`idle-warm-${++nextFixture}`, 2);
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
  const upload = installFakeMeshChunkUpload(async command => { throw new Error(`Unexpected operation during mesh prewarm: ${command}`); });
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
