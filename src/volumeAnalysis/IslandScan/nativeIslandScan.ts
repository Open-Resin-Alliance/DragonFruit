/**
 * Native (Rust) island scan bridge via Tauri IPC.
 *
 * Uses the same two-phase IPC pattern as slicing:
 *   1. stage_mesh_binary_set() — send geometry bytes (raw binary, single-shot)
 *   2. run_island_scan_native() — run scan, receive results
 *
 * Returns a `ScanResults`-compatible object so all existing overlay/voxel
 * rendering works unchanged.
 */

import * as core from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import * as THREE from 'three';
import type { ScanResults, ScanParams, GridRef, ScanLayerResult } from './ScanOrchestrator';
import type { Island } from './types';
import type { RleMask, RleLabels } from './rle';

// ---------------------------------------------------------------------------
// Native response types (camelCase from Rust serde)
// ---------------------------------------------------------------------------

interface NativeGridRef {
  originX: number;
  originZ: number;
  width: number;
  height: number;
  pxMm: number;
}

interface NativeCentroid { x: number; y: number; z: number }

interface NativeIsland {
  id: number;
  firstLayer: number;
  lastLayer: number;
  status: string;
  totalAreaMm2: number;
  perLayerAreaMm2: Record<string, number>;
  parentId: number | null;
  childIds: number[];
  volumeMm3: number | null;
  maxAreaMm2: number | null;
  maxAreaLayer: number | null;
  isMergedPlaceholder: boolean;
  centroid: NativeCentroid | null;
  lastLayerCentroid: NativeCentroid | null;
}

interface NativeRleLabels {
  rows: number[][];
  width: number;
  height: number;
}

interface NativeIslandScanResult {
  grid: NativeGridRef;
  islands: NativeIsland[];
  islandLabelsPerLayer: NativeRleLabels[];
  firstHit: number[];
  lastHit: number[];
  baseFootprint: number[];
  baseLabels: number[];
  compBase: number[];
  compTop: number[];
  rasterizeMs: number;
  scanMs: number;
  totalMs: number;
}

// ---------------------------------------------------------------------------
// Converters (native JSON → TS domain types)
// ---------------------------------------------------------------------------

function toRleLabels(native: NativeRleLabels): RleLabels {
  return {
    rows: native.rows.map(row => new Int32Array(row)),
    width: native.width,
    height: native.height,
  };
}

function toIsland(native: NativeIsland): Island {
  const perLayerAreaMm2 = new Map<number, number>();
  for (const [k, v] of Object.entries(native.perLayerAreaMm2)) {
    perLayerAreaMm2.set(Number(k), v);
  }

  return {
    id: native.id,
    firstLayer: native.firstLayer,
    lastLayer: native.lastLayer,
    status: native.status as 'active' | 'complete',
    totalAreaMm2: native.totalAreaMm2,
    perLayerAreaMm2,
    parentId: native.parentId ?? undefined,
    childIds: native.childIds,
    volumeMm3: native.volumeMm3 ?? undefined,
    maxAreaMm2: native.maxAreaMm2 ?? undefined,
    maxAreaLayer: native.maxAreaLayer ?? undefined,
    isMergedPlaceholder: native.isMergedPlaceholder,
    centroidSumX: 0,
    centroidSumY: 0,
    centroidSumZ: 0,
    centroidCount: 0,
    centroid: native.centroid ?? undefined,
    lastLayerCentroid: native.lastLayerCentroid ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run island scan on the Rust backend via Tauri IPC.
 *
 * Drop-in replacement for `runIslandScan()` / `runScanlineScan()`.
 */
export async function runIslandScanNative(
  geom: { geometry: THREE.BufferGeometry; bbox: THREE.Box3 },
  layerHeightMm: number,
  params: ScanParams,
  onProgress?: (done: number, total: number) => void,
): Promise<ScanResults> {
  // Step 1: Stage mesh binary via raw binary IPC.
  // Uses `stage_mesh_binary_set` (single-shot), which replaced the old `stage_mesh_binary` command in v3.1.
  const positions = geom.geometry.getAttribute('position').array as Float32Array;
  const meshBytes = new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength);

  await core.invoke('stage_mesh_binary_set', meshBytes, {
    headers: { 'Content-Type': 'application/octet-stream' },
  });

  // Step 2: Listen for progress events
  let unlisten: UnlistenFn | null = null;
  if (onProgress) {
    unlisten = await listen<{ done: number; total: number }>('islandscan://progress', (event) => {
      onProgress(event.payload.done, event.payload.total);
    });
  }

  try {
    // Step 3: Build params JSON and invoke native scan
    const bb = geom.bbox;
    const paramsJson = JSON.stringify({
      px_mm: params.px_mm,
      support_buffer_mm: params.support_buffer_mm,
      connectivity: params.connectivity ?? 4,
      min_island_area_mm2: params.min_island_area_mm2 ?? 0.01,
      min_overlap_px: params.min_overlap_px ?? 1,
      overlap_neighborhood_px: params.overlap_neighborhood_px ?? 1,
      layer_height_mm: layerHeightMm,
      bbox_min_x: bb.min.x,
      bbox_max_x: bb.max.x,
      bbox_min_y: bb.min.y,
      bbox_max_y: bb.max.y,
      bbox_min_z: bb.min.z,
      bbox_max_z: bb.max.z,
    });

    const native = await core.invoke<NativeIslandScanResult>('run_island_scan_native', {
      paramsJson,
    });

    console.log(
      `[native island scan] rasterize=${native.rasterizeMs.toFixed(0)}ms ` +
      `scan=${native.scanMs.toFixed(0)}ms total=${native.totalMs.toFixed(0)}ms ` +
      `islands=${native.islands.length}`
    );

    // Step 4: Convert to ScanResults (frontend-compatible)
    const grid: GridRef = {
      originX: native.grid.originX,
      originZ: native.grid.originZ,
      width: native.grid.width,
      height: native.grid.height,
      px_mm: native.grid.pxMm,
    };

    const islands = native.islands.map(toIsland);
    const islandLabelsPerLayer = native.islandLabelsPerLayer.map(toRleLabels);

    // Build per-layer results (overlay painter reads islandLabels from layers[])
    const layers: ScanLayerResult[] = islandLabelsPerLayer.map((labels) => ({
      islandMaskRle: { rows: [], width: grid.width, height: grid.height } as RleMask,
      islandCount: 0,
      islandLabels: labels,
    }));

    return {
      grid,
      layers,
      firstHit: new Int16Array(native.firstHit),
      lastHit: new Int16Array(native.lastHit),
      baseFootprint: new Uint8Array(native.baseFootprint),
      baseLabels: new Int32Array(native.baseLabels),
      compBase: new Int16Array(native.compBase),
      compTop: new Int16Array(native.compTop),
      islands,
      islandLabelsPerLayer,
    };
  } finally {
    if (unlisten) unlisten();
  }
}
