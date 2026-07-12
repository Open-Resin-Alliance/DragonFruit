import * as THREE from 'three';
import { type DetectedIsland } from './types';
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
export async function detectVoxelIslands(
  input: VoxelDetectInput,
  layerHeightMm: number,
  params: VoxelDetectParams,
  onProgress?: (done: number, total: number) => void,
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
  const codec = gridCodec(width, height);
  const candidates = new Set<number>();
  for (let L = 0; L < numLayers; L++) {
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

  console.time('[Islands] 3D connected-components');
  const allIslands = buildIslands(
    candidates,
    codec,
    { originX, originZ, px, minZ, layerHeightMm },
    params.diagonal3D !== false,
  );
  console.timeEnd('[Islands] 3D connected-components');
  const result = allIslands.filter(
    (island) => (island.areaMm2 ?? 0) >= (params.minAreaMm2 ?? 0.02)
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
  onProgress?: (done: number, total: number) => void,
): Promise<RleLabels[]> {
  const candidateLayers: RleLabels[] = new Array(numLayers);

  const cores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 4) : 4;
  const concurrency = Math.min(Math.max(2, cores), numLayers);

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
              onProgress?.(done, numLayers);
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
function buildIslands(
  candidates: Set<number>,
  codec: GridCodec,
  geom: GridGeom,
  diagonal: boolean,
): DetectedIsland[] {
  const offsets = neighbourOffsets(diagonal);
  const visited = new Set<number>();
  const islands: DetectedIsland[] = [];
  let idx = 0;

  for (const startKey of candidates) {
    if (visited.has(startKey)) continue;

    // Flood this component.
    const comp: number[] = [];
    const stack = [startKey];
    visited.add(startKey);
    while (stack.length) {
      const k = stack.pop()!;
      comp.push(k);
      const { col, row, layer } = codec.unpack(k);
      for (const [dc, dr, dl] of offsets) {
        const nc = col + dc;
        const nr = row + dr;
        const nl = layer + dl;
        if (nc < 0 || nc >= codec.width || nr < 0 || nr >= codec.height || nl < 0) continue;
        const nk = codec.pack(nc, nr, nl);
        if (candidates.has(nk) && !visited.has(nk)) {
          visited.add(nk);
          stack.push(nk);
        }
      }
    }

    // Lowest-layer footprint defines the contact point (where support attaches).
    let minLayer = Infinity;
    let maxLayer = -Infinity;
    for (const k of comp) {
      const { layer } = codec.unpack(k);
      if (layer < minLayer) minLayer = layer;
      if (layer > maxLayer) maxLayer = layer;
    }

    let sumX = 0;
    let sumY = 0;
    let baseCount = 0;
    const contactVoxels: { x: number; y: number }[] = [];
    for (const k of comp) {
      const { col, row, layer } = codec.unpack(k);
      if (layer !== minLayer) continue;
      const vx = geom.originX + col * geom.px + geom.px * VOXEL_OFFSET_X;
      const vy = -(geom.originZ + row * geom.px - geom.px * VOXEL_OFFSET_Y);
      sumX += vx;
      sumY += vy;
      baseCount++;
      contactVoxels.push({ x: vx, y: vy });
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
      contactVoxels,
    });
  }

  return islands;
}

interface GridCodec {
  width: number;
  height: number;
  pack: (col: number, row: number, layer: number) => number;
  unpack: (key: number) => { col: number; row: number; layer: number };
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
  };
}

/** 6- or 26-connectivity neighbour offsets (excluding the origin). */
function neighbourOffsets(diagonal: boolean): Array<readonly [number, number, number]> {
  if (!diagonal) {
    return [
      [1, 0, 0], [-1, 0, 0],
      [0, 1, 0], [0, -1, 0],
      [0, 0, 1], [0, 0, -1],
    ];
  }
  const out: Array<readonly [number, number, number]> = [];
  for (let dc = -1; dc <= 1; dc++) {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dl = -1; dl <= 1; dl++) {
        if (dc === 0 && dr === 0 && dl === 0) continue;
        out.push([dc, dr, dl]);
      }
    }
  }
  return out;
}
