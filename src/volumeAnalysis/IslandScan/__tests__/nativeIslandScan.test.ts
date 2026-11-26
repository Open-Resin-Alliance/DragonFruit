import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { installFakeWindow } from '@/utils/__tests__/helpers/fakeWindow';
import { runIslandScanNative } from '../nativeIslandScan';

/**
 * A stand-in for the Rust store with the native island scan: the scan takes its soup out of
 * the store by id, as the real one does, and answers after a delay so two scans overlap.
 */
function fakeScanStore(options: { failBeforeTaking?: boolean } = {}) {
  const entries = new Map<string, Float32Array>();
  const scanned: Float32Array[] = [];
  let nextId = 1;
  const invoke = async (cmd: string, args?: unknown) => {
    const named = (args ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case 'mesh_store_open_client':
        return 0;
      case 'mesh_store_put': {
        const id = `m${nextId++}`;
        entries.set(id, new Float32Array((args as Uint8Array).slice().buffer));
        return id;
      }
      case 'mesh_store_drop':
        return (named.meshIds as string[]).filter((id) => entries.delete(id)).length;
      case 'run_island_scan_native': {
        if (options.failBeforeTaking) throw 'Invalid island scan params JSON';
        const id = String(named.meshId);
        const soup = entries.get(id);
        if (!soup) throw `mesh-store/unknown: no mesh '${id}' (never stored, or already dropped)`;
        entries.delete(id);
        await new Promise((resolve) => setTimeout(resolve, 5));
        scanned.push(soup);
        return emptyScan(soup[0]);
      }
      default:
        throw new Error(`unexpected command: ${cmd}`);
    }
  };
  return { entries, scanned, invoke };
}

/** A scan with nothing in it; `originX` echoes the soup's first float so a test can tell scans apart. */
function emptyScan(originX: number) {
  return {
    grid: { originX, originZ: 0, width: 1, height: 1, pxMm: 0.05 },
    islands: [],
    islandLabelsPerLayer: [],
    firstHit: [],
    lastHit: [],
    baseFootprint: [],
    baseLabels: [],
    compBase: [],
    compTop: [],
    rasterizeMs: 0,
    scanMs: 0,
    totalMs: 0,
  };
}

function triangleAt(x: number) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([x, 0, 0, x + 1, 0, 0, x, 1, 0], 3));
  return { geometry, bbox: new THREE.Box3(new THREE.Vector3(x, 0, 0), new THREE.Vector3(x + 1, 1, 1)) };
}

const params = { px_mm: 0.05, support_buffer_mm: 0.2 };

test('a native island scan sends its positions by id and leaves nothing in the store', async () => {
  const store = fakeScanStore();
  const restore = installFakeWindow({ __TAURI_INTERNALS__: { invoke: store.invoke } });
  try {
    const results = await Promise.all([
      runIslandScanNative(triangleAt(3), 0.05, params),
      runIslandScanNative(triangleAt(7), 0.05, params),
    ]);
    assert.deepEqual(results.map((result) => result.grid.originX), [3, 7], 'each scan sees its own mesh');
    assert.deepEqual(store.scanned.map((soup) => soup[3]), [4, 8]);
    assert.equal(store.entries.size, 0);
  } finally {
    restore();
  }
});

test('a native island scan that fails before taking its soup still drops it', async () => {
  const store = fakeScanStore({ failBeforeTaking: true });
  const restore = installFakeWindow({ __TAURI_INTERNALS__: { invoke: store.invoke } });
  try {
    await assert.rejects(runIslandScanNative(triangleAt(0), 0.05, params), /Invalid island scan params/);
    assert.equal(store.entries.size, 0);
  } finally {
    restore();
  }
});
