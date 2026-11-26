import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { solidRemeshFromGeometry, tetSurfaceFromGeometry } from '../meshShrinkwrap';
import { installFakeWindow } from './helpers/fakeWindow';

/**
 * A stand-in for the Rust store with the two surfacing commands the app reaches: each reads its
 * input by id, answers after a delay so two runs overlap, and stores a result twice the input's
 * size for the input's owner, as the real commands store theirs.
 */
function fakeSurfacingStore() {
  const entries = new Map<string, { bytes: Uint8Array; owner: string }>();
  const calls: string[] = [];
  let nextId = 1;
  const entry = (id: unknown) => {
    const found = entries.get(String(id));
    if (!found) throw `mesh-store/unknown: no mesh '${String(id)}' (never stored, or already dropped)`;
    return found;
  };
  const surface = async (named: Record<string, unknown>) => {
    const input = entry(named.meshId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const doubled = new Uint8Array(input.bytes.byteLength * 2);
    doubled.set(input.bytes);
    doubled.set(input.bytes, input.bytes.byteLength);
    const resultId = `m${nextId++}`;
    entries.set(resultId, { bytes: doubled, owner: input.owner });
    const triangles = input.bytes.byteLength / 36;
    return JSON.stringify({ input_triangles: triangles, output_triangles: triangles * 2, meshId: resultId });
  };

  const invoke = async (cmd: string, args?: unknown, options?: { headers?: Record<string, string> }) => {
    calls.push(cmd);
    const named = (args ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case 'mesh_store_open_client':
        return 0;
      case 'mesh_store_put': {
        const id = `m${nextId++}`;
        entries.set(id, { bytes: (args as Uint8Array).slice(), owner: options?.headers?.['x-mesh-client-id'] ?? '' });
        return id;
      }
      case 'mesh_store_read': {
        const found = entry(named.meshId);
        if (named.release) entries.delete(String(named.meshId));
        return found.bytes.buffer;
      }
      case 'mesh_store_drop':
        return (named.meshIds as string[]).filter((id) => entries.delete(id)).length;
      case 'mesh_solid_remesh_staged':
      case 'mesh_tet_surface_staged':
        return surface(named);
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

const store = fakeSurfacingStore();
const restoreWindow = installFakeWindow({ __TAURI_INTERNALS__: { invoke: store.invoke } });
test.after(() => restoreWindow());

test('two surfacing runs in flight at once each get their own mesh back, and leave nothing stored', async () => {
  const [solid, tet] = await Promise.all([
    solidRemeshFromGeometry(geometryWithTriangles(1, 1), { fill_holes_max_edges: 1e9, remove_noise_shells: true, tolerance: 0 }),
    tetSurfaceFromGeometry(geometryWithTriangles(3, 3), { switches: 'pQ', max_triangles: 0, tolerance: 0 }),
  ]);

  assert.ok(solid && tet);
  assert.equal(solid.report.input_triangles, 1);
  assert.equal(tet.report.input_triangles, 3);
  assert.ok(!('meshId' in solid.report), 'the result id is collected, not handed on');
  const solidPositions = solid.geometry.getAttribute('position').array as Float32Array;
  const tetPositions = tet.geometry.getAttribute('position').array as Float32Array;
  assert.equal(solidPositions.length, 18);
  assert.ok(solidPositions.every((value) => value === 1), 'the shrink-wrap got the other mesh');
  assert.equal(tetPositions.length, 54);
  assert.ok(tetPositions.every((value) => value === 3), 'the tet surface got the other mesh');
  assert.equal(store.entries.size, 0, 'inputs are dropped and results are released as read');
  assert.ok(!store.calls.includes('stage_mesh_binary_set'), 'nothing went through the staging register');
});

test('a surfacing run that fails still drops its input', async () => {
  const restore = installFakeWindow({
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string, args?: unknown, options?: { headers?: Record<string, string> }) => {
        if (cmd === 'mesh_solid_remesh_staged') throw 'invalid shrink-wrap options JSON';
        return store.invoke(cmd, args, options);
      },
    },
  });
  try {
    await assert.rejects(
      solidRemeshFromGeometry(geometryWithTriangles(2, 2), { fill_holes_max_edges: 1, remove_noise_shells: false, tolerance: 0 }),
      /invalid shrink-wrap options/,
    );
  } finally {
    restore();
  }
  assert.equal(store.entries.size, 0);
});
