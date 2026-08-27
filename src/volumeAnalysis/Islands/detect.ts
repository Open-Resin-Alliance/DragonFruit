import { createProgressThrottle, yieldToEventLoop } from '@/utils/yieldToEventLoop';
import type { ScanProgressCallback } from '@/volumeAnalysis/IslandScan/ScanOrchestrator';
import * as THREE from 'three';
import { type DetectedIsland } from './types';
import { VoxelFootprintBuilder } from './voxelFootprint';
// PORTABILITY: analysis-domain dependencies are confined to this file — the
// scanline island worker (the fast RLE engine the Analysis-tab voxel rescan
// uses) and the RleLabels type. If that infra is removed, this is the one
// Islands/ module to re-home; everything else is independent.
import type { RleLabels } from '@/volumeAnalysis/IslandScan/rle';

// Pixel-centre offsets — mirror ScanOrchestrator's VOXEL_OFFSET_{X,Y} so contact
// points land in the same world frame as the legacy overlay.
const VOXEL_OFFSET_X = 0.5;
const VOXEL_OFFSET_Y = 0;

export interface VoxelDetectParams {
  pxMm: number;
  supportBufferMm: number;
  /** Per-layer 2D candidate connectivity (passed to scanLayer in the worker). */
  connectivity?: 4 | 8;
  /** 3D cluster connectivity across layers: true = 26-conn (default), false = 6-conn. */
  diagonal3D?: boolean;
  minAreaMm2?: number;
}

export interface VoxelDetectInput {
  /** World-space (build-plate Z-up) non-indexed positions, 9 floats per triangle. */
  positions: Float32Array;
  /** World-space bbox of the same positions. */
  bbox: THREE.Box3;
}

interface GridRef {
  originX: number;
  originZ: number;
  width: number;
  height: number;
  px_mm: number;
}

/**
 * Rebuilt voxel island detection.
 *
 * THE FIX: an island is a 3D-connected cluster of the *unsupported* scanLayer
 * candidates only (current − dilate(prev_below)). Candidates never include the
 * supported bulk, so a cluster terminates as soon as the region becomes
 * supported — it can never climb to a top surface (the legacy bug).
 *
 * PERFORMANCE: slicing + per-layer candidate extraction run on the **scanline
 * worker pool** — the same fast RLE engine the Analysis-tab voxel rescan uses
 * (scanlineScan.worker.ts). We only collect each layer's candidate labels, then
 * run 3D connected-components (26-conn by default) on the union of candidate
 * voxels. (An earlier draft ran the point-in-polygon rasterizer on the main
 * thread — far slower; replaced.)
 */
/**
 * The scan's phases, in order. The count travels with every progress report so
 * the UI can render "2 of 3" without hard-coding a number that differs between
 * the two scan paths.
 */
const PHASES = ['Slicing', 'Collecting voxels', 'Connecting islands'] as const;

function phaseNumber(phase: string): number {
  const index = PHASES.indexOf(phase as typeof PHASES[number]);
  return index < 0 ? 1 : index + 1;
}

/** Layers processed between yields while unioning candidate voxels. */
const YIELD_INTERVAL_LAYERS = 64;

/** Voxels flooded between yields while building components. */
const YIELD_INTERVAL_VOXELS = 200_000;


/**
 * Writes to the app log file, not just the devtools console.
 *
 * `attachConsole` mirrors Rust records INTO the webview console; nothing goes
 * the other way, so a console.log here is invisible to anyone reading
 * dragonfruit.log — including us, when the measurement is the whole point.
 */
async function logToFile(message: string): Promise<void> {
  console.log(message);
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
  try {
    const { info } = await import('@tauri-apps/plugin-log');
    await info(message);
  } catch {
    // Not a Tauri context, or the plugin is unavailable: the console line stands.
  }
}

export async function detectVoxelIslands(
  input: VoxelDetectInput,
  layerHeightMm: number,
  params: VoxelDetectParams,
  onProgress?: ScanProgressCallback,
): Promise<DetectedIsland[]> {
  const px = params.pxMm;
  const bb = input.bbox;
  const minZ = bb.min.z;

  // Grid (mirrors ScanOrchestrator): mask row 0 stores -bb.max.y; mask Y == -worldY.
  const originX = bb.min.x;
  const originZ = -bb.max.y;
  const width = Math.max(1, Math.ceil((bb.max.x - bb.min.x) / px));
  const height = Math.max(1, Math.ceil((bb.max.y - bb.min.y) / px));
  const numLayers = Math.max(0, Math.ceil((bb.max.z - minZ) / layerHeightMm));
  if (numLayers === 0) return [];

  console.log(
    `[Islands] scanline grid ${width}×${height} px @ ${px} mm · ${numLayers} layers @ ${layerHeightMm} mm ` +
    `(${(width * height).toLocaleString()} px/layer, ${(width * height * numLayers).toLocaleString()} grid cells)`,
  );

  const gridRef: GridRef = { originX, originZ, width, height, px_mm: px };
  const opts = {
    px_mm: px,
    support_buffer_mm: params.supportBufferMm,
    connectivity: params.connectivity ?? 4,
  };

  await logToFile(`[Islands] phase=slice-start grid=${width}x${height} layers=${numLayers}`);
  console.time('[Islands] slice + candidate extraction');
  const candidateLayers = await sliceCandidateLayers(
    input.positions,
    gridRef,
    minZ,
    numLayers,
    layerHeightMm,
    opts,
    onProgress,
  );

  // Union of all unsupported candidate voxels.
  const reportProgress = createProgressThrottle();
  const codec = gridCodec(width, height);
  const candidates = new Set<number>();
  for (let L = 0; L < numLayers; L++) {
    if (L % YIELD_INTERVAL_LAYERS === 0) {
      reportProgress(() => onProgress?.(L, numLayers, 'Collecting voxels', phaseNumber('Collecting voxels'), PHASES.length));
      await yieldToEventLoop();
    }
    const labels = candidateLayers[L];
    if (!labels) continue;
    for (let y = 0; y < labels.height; y++) {
      const row = labels.rows[y];
      for (let i = 0; i < row.length; i += 3) {
        const start = row[i];
        const len = row[i + 1];
        const id = row[i + 2];
        if (id > 0) {
          for (let c = 0; c < len; c++) candidates.add(codec.pack(start + c, y, L));
        }
      }
    }
  }
  console.timeEnd('[Islands] slice + candidate extraction');
  console.log(`[Islands] candidate (unsupported) voxels: ${candidates.size.toLocaleString()}`);

  // What the per-layer RLE actually costs. `rows` is one Int32Array per row per
  // layer, so a tall model holds millions of small typed arrays, each with its
  // own object and buffer overhead — memory that lives outside the GC heap and
  // never showed up in the object counts we were chasing.
  // Release them before the flood fill. The union above is their last reader,
  // but the binding stays in scope for the rest of the function, so without
  // this the whole per-layer set is still reachable — and therefore still
  // resident — while the 3D walk builds its own structures on top.
  candidateLayers.length = 0;

  await logToFile('[Islands] phase=flood-start');
  console.time('[Islands] 3D connected-components');
  const allIslands = await buildIslands(
    candidates,
    codec,
    { originX, originZ, px, minZ, layerHeightMm },
    params.diagonal3D !== false,
    onProgress,
  );
  console.timeEnd('[Islands] 3D connected-components');
  const result = allIslands.filter(
    (island) => (island.areaMm2 ?? 0) >= (params.minAreaMm2 ?? 0.02)
  );

  let footprintBytes = 0;
  for (const island of allIslands) {
    if (island.contactVoxels) {
      footprintBytes += island.contactVoxels.xy.byteLength
        + (island.contactVoxels.z?.byteLength ?? 0);
    }
  }
  await logToFile(
    `[Islands] phase=flood-done islands=${allIslands.length} kept=${result.length} `
    + `footprintMiB=${(footprintBytes / 1048576).toFixed(1)}`,
  );
  console.log(`[Islands] islands detected (pre-filter): ${allIslands.length}, post-filter: ${result.length}`);
  return result;
}

/**
 * Slice every layer on the scanline worker pool and return each layer's
 * candidate (unsupported) RLE labels. Mirrors ScanOrchestrator.runScanInternal's
 * dispatch — concurrency = hardwareConcurrency — but keeps only res.labels.
 */
async function sliceCandidateLayers(
  positions: Float32Array,
  gridRef: GridRef,
  minZ: number,
  numLayers: number,
  layerHeightMm: number,
  opts: { px_mm: number; support_buffer_mm: number; connectivity: 4 | 8 },
  onProgress?: ScanProgressCallback,
): Promise<RleLabels[]> {
  const candidateLayers: RleLabels[] = new Array(numLayers);

  const cores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 4) : 4;
  const concurrency = Math.min(Math.max(2, cores), numLayers);

  const reportSliceProgress = createProgressThrottle();
  const workers: Worker[] = Array.from(
    { length: concurrency },
    () => new Worker(new URL('@/volumeAnalysis/IslandScan/scanlineScan.worker.ts', import.meta.url), { type: 'module' }),
  );
  // Each worker builds its own BucketedSlicer from the positions.
  workers.forEach((w) => w.postMessage({ type: 'init', positions }));

  let nextIndex = 0;
  let done = 0;

  await Promise.all(
    workers.map(
      (w) =>
        new Promise<void>((resolve) => {
          const runNext = () => {
            if (nextIndex >= numLayers) {
              resolve();
              return;
            }
            const idx = nextIndex++;
            const zTop = minZ + (idx + 1) * layerHeightMm + 1e-6;

            const onMessage = (e: MessageEvent) => {
              const msg = e.data as { type?: string; result?: { islandLabelsRle: RleLabels } };
              if (msg?.type !== 'done') return;
              w.removeEventListener('message', onMessage);
              candidateLayers[idx] = msg.result!.islandLabelsRle;
              done++;
              reportSliceProgress(() => onProgress?.(done, numLayers, 'Slicing', phaseNumber('Slicing'), PHASES.length));
              runNext();
            };
            w.addEventListener('message', onMessage);
            w.postMessage({ type: 'layer', z: zTop, layerHeightMm, gridRef, opts });
          };
          runNext();
        }),
    ),
  );

  workers.forEach((w) => w.terminate());
  return candidateLayers;
}

interface GridGeom {
  originX: number;
  originZ: number;
  px: number;
  minZ: number;
  layerHeightMm: number;
}

/** 3D connected components over the candidate voxel set → contact-region islands. */
/**
 * Groups candidate voxels into islands by 3D flood fill.
 *
 * Consumes `candidates`: the Set is emptied as the walk proceeds and must not
 * be read afterwards.
 */
async function buildIslands(
  candidates: Set<number>,
  codec: GridCodec,
  geom: GridGeom,
  diagonal: boolean,
  onProgress?: ScanProgressCallback,
): Promise<DetectedIsland[]> {
  const offsets = neighbourOffsets(diagonal);
  const islands: DetectedIsland[] = [];
  let idx = 0;
  const total = candidates.size;
  const reportProgress = createProgressThrottle();
  let flooded = 0;
  let sinceYield = 0;

  // `candidates` IS the unvisited set: each voxel is deleted as it is flooded,
  // so no second Set of the same ten million boxed numbers has to exist beside
  // it. That pair was most of a 17.5 GB peak, against WebKit's 16 GB ceiling.
  //
  // Deleting during iteration is well defined — entries removed before the
  // iterator reaches them are skipped, which is exactly the "already visited"
  // check this used to perform. The caller must treat the Set as consumed.
  for (const startKey of candidates) {

    // Yielding between components rather than inside a flood keeps the walk
    // itself untouched; a single component can still be large, so this bounds
    // responsiveness by the largest island, not by the whole model.
    if (sinceYield >= YIELD_INTERVAL_VOXELS) {
      sinceYield = 0;
      reportProgress(() => onProgress?.(flooded, total, 'Connecting islands', phaseNumber('Connecting islands'), PHASES.length));
      await yieldToEventLoop();
    }

    // Flood this component.
    const comp: number[] = [];
    const stack = [startKey];
    candidates.delete(startKey);
    while (stack.length) {
      const k = stack.pop()!;
      comp.push(k);
      flooded++;
      sinceYield++;
      const col = codec.colOf(k);
      const row = codec.rowOf(k);
      const layer = codec.layerOf(k);
      for (let o = 0; o < offsets.length; o += 3) {
        const nc = col + offsets[o];
        const nr = row + offsets[o + 1];
        const nl = layer + offsets[o + 2];
        if (nc < 0 || nc >= codec.width || nr < 0 || nr >= codec.height || nl < 0) continue;
        const nk = codec.pack(nc, nr, nl);
        // `delete` reports whether it was there, so claiming a neighbour is one
        // hash lookup rather than the previous three.
        if (candidates.delete(nk)) {
          stack.push(nk);
        }
      }
    }

    // Lowest-layer footprint defines the contact point (where support attaches).
    let minLayer = Infinity;
    let maxLayer = -Infinity;
    for (const k of comp) {
      const layer = codec.layerOf(k);
      if (layer < minLayer) minLayer = layer;
      if (layer > maxLayer) maxLayer = layer;
    }

    let sumX = 0;
    let sumY = 0;
    let baseCount = 0;
    const contactVoxels = new VoxelFootprintBuilder(Math.min(comp.length, 1024));
    for (const k of comp) {
      const layer = codec.layerOf(k);
      if (layer !== minLayer) continue;
      const col = codec.colOf(k);
      const row = codec.rowOf(k);
      const vx = geom.originX + col * geom.px + geom.px * VOXEL_OFFSET_X;
      const vy = -(geom.originZ + row * geom.px - geom.px * VOXEL_OFFSET_Y);
      sumX += vx;
      sumY += vy;
      baseCount++;
      contactVoxels.push(vx, vy);
    }

    const contactX = sumX / baseCount;
    const contactY = sumY / baseCount;
    const baseZ = geom.minZ + minLayer * geom.layerHeightMm;

    islands.push({
      id: `v${idx++}`,
      source: 'voxel',
      contact: new THREE.Vector3(contactX, contactY, baseZ),
      baseZ,
      areaMm2: baseCount * geom.px * geom.px,
      layerSpan: [minLayer, maxLayer],
      contactVoxels: contactVoxels.build(),
    });
  }

  return islands;
}

interface GridCodec {
  width: number;
  height: number;
  pack: (col: number, row: number, layer: number) => number;
  unpack: (key: number) => { col: number; row: number; layer: number };
  /**
   * Component accessors, for the hot loops.
   *
   * `unpack` returns a fresh object, and the flood fill calls it once per voxel
   * as it walks plus twice more per voxel in the passes that follow — around
   * thirty million throwaway objects for a ten-million-voxel scan, all of it
   * allocation and collection for three numbers.
   */
  colOf: (key: number) => number;
  rowOf: (key: number) => number;
  layerOf: (key: number) => number;
}

function gridCodec(width: number, height: number): GridCodec {
  return {
    width,
    height,
    pack: (col, row, layer) => (layer * height + row) * width + col,
    unpack: (key) => {
      const col = key % width;
      const rest = (key - col) / width;
      const row = rest % height;
      const layer = (rest - row) / height;
      return { col, row, layer };
    },
    colOf: (key) => key % width,
    rowOf: (key) => Math.floor(key / width) % height,
    layerOf: (key) => Math.floor(key / (width * height)),
  };
}

/** 6- or 26-connectivity neighbour offsets (excluding the origin). */
/**
 * Neighbour deltas flattened into one array of triples, read by index.
 *
 * The obvious shape is an array of `[dc, dr, dl]` tuples, but the flood fill
 * destructures it once per neighbour per voxel — 26 array iterators per voxel
 * at 26-connectivity, each one an allocation. Sampling a scan of a tall model
 * put 8,090 samples in `operationNewArrayIterator` alone.
 */
function neighbourOffsets(diagonal: boolean): Int8Array {
  if (!diagonal) {
    return Int8Array.from([
      1, 0, 0, -1, 0, 0,
      0, 1, 0, 0, -1, 0,
      0, 0, 1, 0, 0, -1,
    ]);
  }
  const out: number[] = [];
  for (let dc = -1; dc <= 1; dc++) {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dl = -1; dl <= 1; dl++) {
        if (dc === 0 && dr === 0 && dl === 0) continue;
        out.push(dc, dr, dl);
      }
    }
  }
  return Int8Array.from(out);
}
