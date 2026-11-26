import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { analyzeFromGeometry, classifyFromGeometry } from '../meshRepair';
import { asNativeMeshStoreError, NativeMeshStoreError } from '../nativeMeshStore';
import { installFakeWindow } from './helpers/fakeWindow';

/**
 * A stand-in for the Rust store behind the IPC boundary: entries by id, owned by a client,
 * and a classify command that answers after a delay so two passes overlap.
 */
function fakeNativeStore() {
  const entries = new Map<string, { bytes: Uint8Array; owner: string }>();
  const calls: string[] = [];
  let nextId = 1;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  const entry = (id: unknown) => {
    const found = entries.get(String(id));
    if (!found) throw `mesh-store/unknown: no mesh '${String(id)}' (never stored, or already dropped)`;
    return found;
  };

  const invoke = async (cmd: string, args?: unknown, options?: { headers?: Record<string, string> }) => {
    calls.push(cmd);
    const named = (args ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case 'mesh_store_open_client':
        return 0;
      case 'mesh_store_put': {
        const id = `m${nextId++}`;
        const bytes = args as Uint8Array;
        entries.set(id, { bytes: bytes.slice(), owner: options?.headers?.['x-mesh-client-id'] ?? '' });
        return id;
      }
      case 'mesh_store_read': {
        const found = entry(named.meshId);
        if (named.release) entries.delete(String(named.meshId));
        return found.bytes.buffer;
      }
      case 'mesh_store_drop':
        return (named.meshIds as string[]).filter((id) => entries.delete(id)).length;
      case 'mesh_analyze_staged': {
        const found = entry(named.meshId);
        await settle();
        return JSON.stringify({ triangle_count: found.bytes.byteLength / 36 });
      }
      case 'mesh_classify_staged': {
        const input = entry(named.meshId);
        await settle();
        const triangles = input.bytes.byteLength / 36;
        const resultId = `m${nextId++}`;
        entries.set(resultId, { bytes: input.bytes.slice(), owner: input.owner });
        return JSON.stringify({
          version: 1,
          pre: { triangle_count: triangles },
          post: { triangle_count: triangles },
          steps: [],
          residual_issues: [],
          fully_repaired: true,
          total_ms: 1,
          meshId: resultId,
        });
      }
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  };
  return { entries, calls, invoke };
}

function geometryWithTriangles(triangles: number, fill: number): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(triangles * 9).fill(fill), 3));
  return geometry;
}

// One store for the file: the client id is opened once per page load, and a test process
// is one page load.
const store = fakeNativeStore();
const restoreWindow = installFakeWindow({ __TAURI_INTERNALS__: { invoke: store.invoke } });
test.after(() => restoreWindow());

test('two classify passes in flight at once each get their own mesh back, and leave nothing stored', async () => {
  const [one, three] = await Promise.all([
    classifyFromGeometry(geometryWithTriangles(1, 1)),
    classifyFromGeometry(geometryWithTriangles(3, 3)),
  ]);

  assert.ok(one && three);
  assert.equal(one.report.pre.triangle_count, 1);
  assert.equal(three.report.pre.triangle_count, 3);
  assert.equal(one.positions.length, 9);
  assert.ok(one.positions.every((value) => value === 1), 'the first pass got the second mesh');
  assert.equal(three.positions.length, 27);
  assert.ok(three.positions.every((value) => value === 3), 'the second pass got the first mesh');
  assert.equal(store.entries.size, 0, 'inputs are dropped and results are released as read');
  assert.equal(store.calls.filter((cmd) => cmd === 'mesh_store_open_client').length, 1);
  assert.ok(!store.calls.includes('stage_mesh_binary_set'), 'nothing went through the staging register');
});

test('the input is dropped when the pass fails', async () => {
  const before = store.calls.length;
  const restore = installFakeWindow({
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string, args?: unknown, options?: { headers?: Record<string, string> }) => {
        if (cmd === 'mesh_analyze_staged') throw 'analysis failed';
        return store.invoke(cmd, args, options);
      },
    },
  });
  try {
    await assert.rejects(analyzeFromGeometry(geometryWithTriangles(2, 2)), /analysis failed/);
  } finally {
    restore();
  }
  assert.equal(store.entries.size, 0);
  assert.ok(store.calls.slice(before).includes('mesh_store_drop'));
});

test('a store error keeps its code on the frontend', async () => {
  const restore = installFakeWindow({
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string, args?: unknown, options?: { headers?: Record<string, string> }) => {
        if (cmd === 'mesh_analyze_staged') {
          throw `mesh-store/expired: mesh '${String((args as { meshId: string }).meshId)}' was released`;
        }
        return store.invoke(cmd, args, options);
      },
    },
  });
  try {
    await assert.rejects(
      analyzeFromGeometry(geometryWithTriangles(1, 1)),
      (error: unknown) => error instanceof NativeMeshStoreError && error.code === 'expired',
    );
  } finally {
    restore();
  }
  assert.equal(asNativeMeshStoreError('some other failure'), null);
  assert.equal(asNativeMeshStoreError(new Error('mesh-store/unknown: no mesh'))?.code, 'unknown');
});
