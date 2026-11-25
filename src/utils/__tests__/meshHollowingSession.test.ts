import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { openHollowSession, previewHollowSession, type HollowOptions } from '../meshHollowing';
import { NativeMeshStoreError } from '../nativeMeshStore';
import { installFakeWindow } from './helpers/fakeWindow';

type FakeEntry =
  | { kind: 'soup' | 'buffer'; bytes: Uint8Array }
  | { kind: 'session'; sourceTriangles: number };

/**
 * A stand-in for the Rust store behind the IPC boundary, with the hollow session commands: a
 * session is an entry of its own, and a preview stores each of its outputs under a new id.
 */
function fakeHollowStore() {
  const entries = new Map<string, FakeEntry>();
  const calls: string[] = [];
  let nextId = 1;
  const put = (entry: FakeEntry) => {
    const id = `m${nextId++}`;
    entries.set(id, entry);
    return id;
  };
  const get = (id: unknown) => {
    const found = entries.get(String(id));
    if (!found) throw `mesh-store/unknown: no mesh '${String(id)}' (never stored, or already dropped)`;
    return found;
  };
  const floats = (...values: number[]) => ({ kind: 'soup' as const, bytes: new Uint8Array(new Float32Array(values).buffer) });
  const buffer = (array: Float32Array | Uint32Array) => ({ kind: 'buffer' as const, bytes: new Uint8Array(array.buffer) });

  const invoke = async (cmd: string, args?: unknown) => {
    calls.push(cmd);
    const named = (args ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case 'mesh_store_open_client':
        return 0;
      case 'mesh_store_put':
        return put({ kind: 'soup', bytes: (args as Uint8Array).slice() });
      case 'mesh_store_read': {
        const found = get(named.meshId);
        if (found.kind === 'session') throw `mesh-store/wrong_kind: '${String(named.meshId)}' holds a hollow session`;
        if (named.release) entries.delete(String(named.meshId));
        return found.bytes.slice().buffer;
      }
      case 'mesh_store_drop':
        return (named.meshIds as string[]).filter((id) => entries.delete(id)).length;
      case 'mesh_hollow_session_open': {
        const source = get(named.meshId);
        if (source.kind !== 'soup') throw 'mesh-store/wrong_kind: not a soup';
        return put({ kind: 'session', sourceTriangles: source.bytes.byteLength / 36 });
      }
      case 'mesh_hollow_session_preview': {
        const session = get(named.sessionId);
        if (session.kind !== 'session') throw 'mesh-store/wrong_kind: not a session';
        return JSON.stringify({
          sourceTriangleCount: session.sourceTriangles,
          removedVoxels: 2,
          meshId: put(floats(0, 0, 0, 1, 0, 0, 0, 1, 0)),
          cavityId: put(floats(0, 0, 1, 1, 0, 1, 0, 1, 1)),
          infillId: put(floats(5, 5, 5, 6, 5, 5, 5, 6, 5)),
          removedVoxelCentersId: put(buffer(new Float32Array([1, 2, 3, 4, 5, 6]))),
          removedVoxelIndicesId: put(buffer(new Uint32Array([7, 9]))),
          blockedVoxelCentersId: put(buffer(new Float32Array(0))),
          blockedVoxelIndicesId: put(buffer(new Uint32Array(0))),
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

const cavityOptions: HollowOptions = {
  mode: 'cavity',
  voxelResolution: 32,
  shellThicknessMm: 2,
  infillMode: 'lattice',
  infillCellMm: 4,
  infillBeamRadiusMm: 0.5,
  openFace: 'z_min',
  drainHoles: [],
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test('a hollow session is reused for its source and dropped when the source changes', async () => {
  const store = fakeHollowStore();
  const restore = installFakeWindow({ __TAURI_INTERNALS__: { invoke: store.invoke } });
  try {
    const first = await openHollowSession(triangles(2), 'reuse::a');
    assert.equal(await openHollowSession(triangles(2), 'reuse::a'), first);
    assert.equal(store.calls.filter((cmd) => cmd === 'mesh_hollow_session_open').length, 1);

    const second = await openHollowSession(triangles(3), 'reuse::b');
    assert.ok(second && second !== first);
    await settle();
    assert.deepEqual([...store.entries.keys()], [second], 'only the open session is left: inputs and the old session are dropped');
  } finally {
    restore();
  }
});

test('a hollow preview reads the outputs it needs and leaves nothing behind', async () => {
  const store = fakeHollowStore();
  const restore = installFakeWindow({ __TAURI_INTERNALS__: { invoke: store.invoke } });
  try {
    const sessionId = await openHollowSession(triangles(4), 'outputs::a');
    assert.ok(sessionId);
    await settle();
    const result = await previewHollowSession(sessionId, cavityOptions);
    assert.ok(result);
    assert.equal(result.report.sourceTriangleCount, 4);
    assert.equal('meshId' in result.report, false, 'output ids are not part of the report');
    assert.deepEqual([...result.positions], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
    assert.deepEqual([...(result.cavityPositions ?? [])], [0, 0, 1, 1, 0, 1, 0, 1, 1]);
    assert.equal(result.infillPositions, undefined, 'a cavity preview does not read the infill');
    assert.deepEqual([...(result.removedVoxelCenters ?? [])], [1, 2, 3, 4, 5, 6]);
    assert.deepEqual([...(result.removedVoxelIndices ?? [])], [7, 9]);
    assert.deepEqual([...store.entries.keys()], [sessionId], 'every output id was read or dropped');
  } finally {
    restore();
  }
});

test('a session the store no longer has is opened again on the next call', async () => {
  const store = fakeHollowStore();
  const restore = installFakeWindow({ __TAURI_INTERNALS__: { invoke: store.invoke } });
  try {
    const geometry = triangles(1);
    const lost = await openHollowSession(geometry, 'lost::a');
    assert.ok(lost);
    store.entries.delete(lost);

    await assert.rejects(previewHollowSession(lost, cavityOptions), (error: unknown) => (
      error instanceof NativeMeshStoreError && error.code === 'unknown'
    ));
    const reopened = await openHollowSession(geometry, 'lost::a');
    assert.ok(reopened && reopened !== lost);
  } finally {
    restore();
  }
});
