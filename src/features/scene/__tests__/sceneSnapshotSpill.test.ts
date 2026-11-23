import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
  disposeSpilledSceneSnapshot,
  hasSpilledSceneSnapshot,
  nativeSpillStore,
  rehydrateSceneSnapshotPair,
  setSpillStoreForTests,
  spillSceneSnapshotPair,
  type SpillStore,
} from '@/features/scene/sceneSnapshotSpill';
import type { LoadedModel, SceneSnapshotPair } from '@/features/scene/useSceneCollectionManager';
import type { SupportState } from '@/supports/types';
import type { TauriInvoke } from '@/utils/tauriMeshBridge';

/** A store that keeps each key's file as one byte array. */
function memoryStore() {
  const files = new Map<string, Uint8Array>();
  const store: SpillStore = {
    async write(key, chunks) {
      const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const file = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        file.set(chunk, offset);
        offset += chunk.byteLength;
      }
      files.set(key, file);
    },
    async read(key, offset, length) {
      const file = files.get(key);
      if (!file) throw new Error(`no file for ${key}`);
      return file.slice(offset, offset + length).buffer;
    },
    async remove(key) {
      files.delete(key);
    },
    async prune(activeKeys) {
      for (const key of [...files.keys()]) if (!activeKeys.has(key)) files.delete(key);
    },
  };
  return { store, files };
}

function snapshotPair() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array([0, 1, 2]), 1));
  const model = { id: 'model-a', geometry: { geometry } } as unknown as LoadedModel;
  const supportState = { supports: { s1: { id: 's1' } } } as unknown as SupportState;
  const pair: SceneSnapshotPair = {
    before: { models: [model], activeModelId: null, selectedModelIds: [], supportState },
    after: { models: [model], activeModelId: null, selectedModelIds: [] },
  };
  return { pair, geometry, supportState };
}

/** Outside a window the release runs on a 50 ms timer. */
const releaseTimer = () => new Promise<void>((resolve) => { setTimeout(resolve, 80); });

test('a spilled snapshot leaves RAM and comes back whole from the store', async (t) => {
  const { store, files } = memoryStore();
  setSpillStoreForTests(store);
  t.after(() => setSpillStoreForTests(null));
  const { pair, geometry, supportState } = snapshotPair();

  assert.equal(await spillSceneSnapshotPair('k1', pair, () => true), true);
  await releaseTimer();
  assert.ok(files.has('k1'));
  assert.ok(hasSpilledSceneSnapshot('k1'));
  assert.deepEqual(Object.keys(geometry.attributes), []);
  assert.equal(geometry.index, null);
  assert.equal(pair.before.supportState, undefined);

  assert.equal(await rehydrateSceneSnapshotPair('k1', pair), true);
  assert.deepEqual([...(geometry.getAttribute('position').array as Float32Array)], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  assert.deepEqual([...(geometry.index!.array as Uint32Array)], [0, 1, 2]);
  assert.deepEqual(pair.before.supportState, supportState);
  assert.equal(hasSpilledSceneSnapshot('k1'), false);
  await Promise.resolve();
  assert.equal(files.has('k1'), false, 'the file goes once the arrays are back');
});

test('a write that fails keeps the snapshot in memory', async (t) => {
  const { store } = memoryStore();
  setSpillStoreForTests({ ...store, write: async () => { throw new TypeError('createWritable is not a function'); } });
  t.after(() => setSpillStoreForTests(null));
  const { pair, geometry, supportState } = snapshotPair();
  const warn = t.mock.method(console, 'warn', () => undefined);

  assert.equal(await spillSceneSnapshotPair('k2', pair, () => true), false);
  await releaseTimer();
  assert.equal(warn.mock.callCount(), 1);
  assert.ok(geometry.getAttribute('position'));
  assert.equal(pair.before.supportState, supportState);
  assert.equal(hasSpilledSceneSnapshot('k2'), false);
});

test('disposing a spilled snapshot removes its file', async (t) => {
  const { store, files } = memoryStore();
  setSpillStoreForTests(store);
  t.after(() => setSpillStoreForTests(null));
  const { pair } = snapshotPair();
  assert.equal(await spillSceneSnapshotPair('k3', pair, () => false), true, 'the support state spills on its own');
  disposeSpilledSceneSnapshot('k3');
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  assert.equal(files.has('k3'), false);
});

test('the native store sends each chunk in order with the offset the last call returned', async () => {
  const calls: Array<{ cmd: string; bytes?: number[]; headers?: Record<string, string>; args?: unknown }> = [];
  let length = 0;
  const invoke = (async (cmd: string, args?: unknown, opts?: { headers?: Record<string, string> }) => {
    if (cmd === 'undo_spill_append') {
      const part = args as Uint8Array;
      calls.push({ cmd, bytes: [...part], headers: opts?.headers });
      length += part.byteLength;
      return length;
    }
    calls.push({ cmd, args });
    if (cmd === 'undo_spill_read') return new Uint8Array([7, 8]);
    return undefined;
  }) as TauriInvoke;
  const store = nativeSpillStore(invoke);

  await store.write('key', [new Uint8Array([1, 2]), new Uint8Array([]), new Uint8Array([3])]);
  assert.deepEqual(calls.map((call) => [call.bytes, call.headers?.['x-undo-spill-offset']]), [
    [[1, 2], '0'],
    [[3], '2'],
  ]);
  assert.equal(calls[0].headers?.['x-undo-spill-key'], 'key');

  const buffer = await store.read('key', 4, 2);
  assert.ok(buffer instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(buffer)], [7, 8]);
  assert.deepEqual(calls.at(-1), { cmd: 'undo_spill_read', args: { key: 'key', offset: 4, length: 2 } });
});

test('the native store removes a file whose write broke partway', async () => {
  const commands: string[] = [];
  const invoke = (async (cmd: string) => {
    commands.push(cmd);
    if (cmd === 'undo_spill_append' && commands.length > 1) throw new Error('disk full');
    return 2;
  }) as TauriInvoke;
  await assert.rejects(nativeSpillStore(invoke).write('key', [new Uint8Array(2), new Uint8Array(2)]), /disk full/);
  assert.deepEqual(commands, ['undo_spill_append', 'undo_spill_append', 'undo_spill_remove']);
});
