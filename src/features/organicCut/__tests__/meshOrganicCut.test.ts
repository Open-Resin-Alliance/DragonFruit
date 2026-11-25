import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { installFakeWindow } from '@/utils/__tests__/helpers/fakeWindow';
import { NativeMeshStoreError } from '@/utils/nativeMeshStore';
import {
  computeGeodesicLoop,
  computeMembranePreview,
  computePlaneTenonPreview,
  cutFromSource,
  openCutSource,
} from '../meshOrganicCut';
import type { CutScale } from '../cutSpace';
import type { OrganicCutLoopPoint, OrganicCutOptions } from '../types';

const SESSION_COMMANDS = [
  'mesh_organic_cut_session_apply',
  'mesh_organic_cut_session_geodesic_loop',
  'mesh_organic_cut_session_membrane_preview',
  'mesh_organic_cut_session_plane_tenon_preview',
];

/**
 * A stand-in for the Rust store behind the IPC boundary, with the organic cut session
 * commands. A session keeps a copy of the soup it was opened on; every command that builds a
 * soup stores it under a new id, as the real ones do.
 */
function fakeCutStore() {
  const entries = new Map<string, { kind: 'soup' | 'session'; bytes: Float32Array }>();
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  let nextId = 1;
  const put = (kind: 'soup' | 'session', bytes: Float32Array) => {
    const id = `m${nextId++}`;
    entries.set(id, { kind, bytes });
    return id;
  };
  const get = (id: unknown, kind: 'soup' | 'session') => {
    const found = entries.get(String(id));
    if (!found) throw `mesh-store/unknown: no mesh '${String(id)}' (never stored, or already dropped)`;
    if (found.kind !== kind) throw `mesh-store/wrong_kind: '${String(id)}' holds a ${found.kind}`;
    return found.bytes;
  };
  const triangle = (offset: number) => new Float32Array([0, 0, offset, 1, 0, offset, 0, 1, offset]);

  const invoke = async (cmd: string, args?: unknown) => {
    const named = (args ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args: named });
    switch (cmd) {
      case 'mesh_store_open_client':
        return 0;
      case 'mesh_store_put': {
        const bytes = args as Uint8Array;
        return put('soup', new Float32Array(bytes.slice().buffer));
      }
      case 'mesh_store_read': {
        const found = get(named.meshId, 'soup');
        if (named.release) entries.delete(String(named.meshId));
        return found.slice().buffer;
      }
      case 'mesh_store_drop':
        return (named.meshIds as string[]).filter((id) => entries.delete(id)).length;
      case 'mesh_organic_cut_session_open':
        return put('session', get(named.meshId, 'soup').slice());
      case 'mesh_organic_cut_session_apply': {
        const source = get(named.sessionId, 'session');
        return JSON.stringify({
          sourceTriangleCount: source.length / 9,
          partATriangleCount: 1,
          partBTriangleCount: 1,
          engine: 'plane',
          partCount: 2,
          partIds: [put('soup', triangle(10)), put('soup', triangle(20))],
        });
      }
      case 'mesh_organic_cut_session_geodesic_loop': {
        get(named.sessionId, 'session');
        const request = JSON.parse(String(named.requestJson)) as { points: { position: number[] }[] };
        return new Float32Array(request.points.flatMap((p) => p.position)).buffer;
      }
      case 'mesh_organic_cut_session_membrane_preview':
        get(named.sessionId, 'session');
        return JSON.stringify({
          triangleCount: 1,
          jointTriangleCount: 1,
          tenonTriangleCount: 1,
          tenonKind: 'frustum',
          tenonFits: true,
          tenonDetail: '',
          tenonFrame: null,
          membraneId: put('soup', triangle(30)),
          tenonId: put('soup', triangle(40)),
        });
      case 'mesh_organic_cut_session_plane_tenon_preview':
        get(named.sessionId, 'session');
        return JSON.stringify({
          triangleCount: 0,
          jointTriangleCount: 1,
          tenonTriangleCount: 1,
          tenonKind: 'dome',
          tenonFits: false,
          tenonDetail: 'too thin',
          tenonFrame: null,
          tenonId: put('soup', triangle(50)),
        });
      default:
        throw new Error(`unexpected command: ${cmd}`);
    }
  };
  return { entries, calls, invoke };
}

function triangles(count: number): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Array(count * 9).fill(1), 3));
  return geometry;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

const square: OrganicCutLoopPoint[] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]].map((position) => ({
  position: position as [number, number, number],
  normal: [0, 0, 1],
}));

const flatCut: OrganicCutOptions = { cut: { loopPoints: square, smoothing: 0.5, mode: 'plane' } };

test('a cut session is opened once per source and the previous one dropped', async () => {
  const store = fakeCutStore();
  const restore = installFakeWindow({ __TAURI_INTERNALS__: { invoke: store.invoke } });
  try {
    const geometry = triangles(2);
    const first = await openCutSource(geometry, 'reuse::a');
    assert.ok(first);
    assert.equal(await openCutSource(geometry, 'reuse::a'), first);
    assert.deepEqual([...store.entries.keys()], [first.id], 'the mesh it opened on is dropped');

    // The same key with a new geometry object (a cut then undo), or a new scale, is a new source.
    const replaced = await openCutSource(triangles(2), 'reuse::a');
    assert.ok(replaced && replaced.id !== first.id);
    const rescaled = await openCutSource(geometry, 'reuse::a', [2, 2, 2]);
    assert.ok(rescaled && rescaled.id !== replaced.id);
    await settle();
    assert.deepEqual([...store.entries.keys()], [rescaled.id], 'each previous session is dropped');
    assert.equal(store.calls.filter(({ cmd }) => cmd === 'mesh_organic_cut_session_open').length, 3);
  } finally {
    restore();
  }
});

test('a session holds the mesh at printed size and everything read back is unscaled', async () => {
  const store = fakeCutStore();
  const restore = installFakeWindow({ __TAURI_INTERNALS__: { invoke: store.invoke } });
  try {
    const scale: CutScale = [2, 3, 4];
    const source = await openCutSource(triangles(1), 'scaled::a', scale);
    assert.ok(source);
    assert.deepEqual([...store.entries.get(source.id)!.bytes].slice(0, 3), [2, 3, 4]);

    const loop = await computeGeodesicLoop(source, square, true);
    const sent = JSON.parse(String(store.calls.at(-1)!.args.requestJson)) as { points: { position: number[] }[] };
    assert.deepEqual(sent.points[2].position, [2, 3, 0], 'waypoints go out scaled');
    assert.deepEqual([...loop!].slice(6, 9), [1, 1, 0], 'and the seam comes back unscaled');

    const result = await cutFromSource(source, flatCut);
    assert.deepEqual([...result!.parts[1]].slice(0, 3), [0, 0, 5], 'parts come back unscaled');
  } finally {
    restore();
  }
});

test('a cut collects every part and leaves only its session', async () => {
  const store = fakeCutStore();
  const restore = installFakeWindow({ __TAURI_INTERNALS__: { invoke: store.invoke } });
  try {
    const source = await openCutSource(triangles(3), 'cut::a');
    assert.ok(source);
    for (let run = 0; run < 2; run += 1) {
      const result = await cutFromSource(source, flatCut);
      assert.ok(result);
      assert.equal(result.report.sourceTriangleCount, 3);
      assert.equal('partIds' in result.report, false, 'the part ids are not part of the report');
      assert.deepEqual(result.parts.map((part) => part[2]), [10, 20]);
    }
    assert.deepEqual([...store.entries.keys()], [source.id]);
  } finally {
    restore();
  }
});

test('the previews collect their soups and leave only the session', async () => {
  const store = fakeCutStore();
  const restore = installFakeWindow({ __TAURI_INTERNALS__: { invoke: store.invoke } });
  try {
    const source = await openCutSource(triangles(1), 'preview::a');
    assert.ok(source);

    const membrane = await computeMembranePreview(source, square, 0.5, 1, 0, true);
    assert.equal(membrane.membrane?.[2], 30);
    assert.equal(membrane.tenonPreview?.[2], 40);
    assert.equal(membrane.tenonKind, 'frustum');

    const plane = await computePlaneTenonPreview(source, [0, 0, 1], 0, true);
    assert.equal(plane.membrane, null);
    assert.equal(plane.tenonPreview?.[2], 50);
    assert.equal(plane.tenonFits, false);
    assert.equal(plane.tenonDetail, 'too thin');

    assert.deepEqual([...store.entries.keys()], [source.id]);
    assert.ok(store.calls.every(({ cmd, args }) => !SESSION_COMMANDS.includes(cmd) || args.sessionId === source.id));
  } finally {
    restore();
  }
});

test('a session the store no longer has is opened again on the next call', async () => {
  const store = fakeCutStore();
  const restore = installFakeWindow({ __TAURI_INTERNALS__: { invoke: store.invoke } });
  try {
    const geometry = triangles(1);
    const lost = await openCutSource(geometry, 'lost::a');
    assert.ok(lost);
    store.entries.delete(lost.id);

    await assert.rejects(
      cutFromSource(lost, flatCut),
      (error: unknown) => error instanceof NativeMeshStoreError && error.code === 'unknown',
    );
    const reopened = await openCutSource(geometry, 'lost::a');
    assert.ok(reopened && reopened.id !== lost.id);

    // The seam swallows its errors (it runs every frame), but still forgets the session.
    store.entries.delete(reopened.id);
    assert.equal(await computeGeodesicLoop(reopened, square, true), null);
    const again = await openCutSource(geometry, 'lost::a');
    assert.ok(again && again.id !== reopened.id);
  } finally {
    restore();
  }
});
