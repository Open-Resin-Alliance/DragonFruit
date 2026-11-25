import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { openPunchSource, punchFromGeometry, punchStoredSource, type PunchOptions } from '../meshPunching';
import { NativeMeshStoreError } from '../nativeMeshStore';
import { installFakeWindow } from './helpers/fakeWindow';

/**
 * A stand-in for the Rust store behind the IPC boundary, with `mesh_punch_staged`: it reads
 * its input without consuming it and stores the result under a new id.
 */
function fakePunchStore() {
  const entries = new Map<string, Uint8Array>();
  const calls: string[] = [];
  let nextId = 1;
  const put = (bytes: Uint8Array) => {
    const id = `m${nextId++}`;
    entries.set(id, bytes);
    return id;
  };
  const get = (id: unknown) => {
    const found = entries.get(String(id));
    if (!found) throw `mesh-store/unknown: no mesh '${String(id)}' (never stored, or already dropped)`;
    return found;
  };

  const invoke = async (cmd: string, args?: unknown) => {
    calls.push(cmd);
    const named = (args ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case 'mesh_store_open_client':
        return 0;
      case 'mesh_store_put':
        return put((args as Uint8Array).slice());
      case 'mesh_store_read': {
        const found = get(named.meshId);
        if (named.release) entries.delete(String(named.meshId));
        return found.slice().buffer;
      }
      case 'mesh_store_drop':
        return (named.meshIds as string[]).filter((id) => entries.delete(id)).length;
      case 'mesh_punch_staged': {
        const source = get(named.meshId);
        const triangles = source.byteLength / 36;
        return JSON.stringify({
          sourceTriangleCount: triangles,
          outputTriangleCount: 1,
          removedTriangleCount: triangles - 1,
          punchCount: 1,
          meshId: put(new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer)),
        });
      }
      default:
        throw new Error(`unexpected command: ${cmd}`);
    }
  };
  return { entries, calls, invoke };
}

function triangles(count: number): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Array(count * 9).fill(0).map((_, i) => i), 3));
  return geometry;
}

const onePunch: PunchOptions = { punches: [{ centerNorm: [0.5, 0.5, 0.5], radiusMm: 2 }] };

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test('a punch source is stored once for its key and dropped when the key changes', async () => {
  const store = fakePunchStore();
  const restore = installFakeWindow({ __TAURI_INTERNALS__: { invoke: store.invoke } });
  try {
    const first = await openPunchSource(triangles(2), 'reuse::a');
    assert.equal(await openPunchSource(triangles(2), 'reuse::a'), first);
    assert.equal(store.calls.filter((cmd) => cmd === 'mesh_store_put').length, 1);

    const second = await openPunchSource(triangles(3), 'reuse::b');
    assert.ok(second && second !== first);
    await settle();
    assert.deepEqual([...store.entries.keys()], [second], 'the previous source is dropped');
  } finally {
    restore();
  }
});

test('punching the stored source keeps it and leaves no result behind', async () => {
  const store = fakePunchStore();
  const restore = installFakeWindow({ __TAURI_INTERNALS__: { invoke: store.invoke } });
  try {
    const sourceId = await openPunchSource(triangles(4), 'punch::a');
    assert.ok(sourceId);
    for (let run = 0; run < 2; run += 1) {
      const result = await punchStoredSource(sourceId, onePunch);
      assert.ok(result);
      assert.equal(result.report.sourceTriangleCount, 4);
      assert.equal('meshId' in result.report, false, 'the result id is not part of the report');
      assert.deepEqual([...result.positions], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
    }
    assert.deepEqual([...store.entries.keys()], [sourceId], 'only the source is left');
  } finally {
    restore();
  }
});

test('a one-shot punch leaves nothing in the store', async () => {
  const store = fakePunchStore();
  const restore = installFakeWindow({ __TAURI_INTERNALS__: { invoke: store.invoke } });
  try {
    const result = await punchFromGeometry(triangles(5), onePunch);
    assert.equal(result?.report.sourceTriangleCount, 5);
    assert.equal(store.entries.size, 0);
  } finally {
    restore();
  }
});

test('a source the store no longer has is stored again on the next open', async () => {
  const store = fakePunchStore();
  const restore = installFakeWindow({ __TAURI_INTERNALS__: { invoke: store.invoke } });
  try {
    const geometry = triangles(1);
    const lost = await openPunchSource(geometry, 'lost::a');
    assert.ok(lost);
    store.entries.delete(lost);

    await assert.rejects(punchStoredSource(lost, onePunch), (error: unknown) => (
      error instanceof NativeMeshStoreError && error.code === 'unknown'
    ));
    const reopened = await openPunchSource(geometry, 'lost::a');
    assert.ok(reopened && reopened !== lost);
  } finally {
    restore();
  }
});
