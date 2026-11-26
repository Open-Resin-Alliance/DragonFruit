import { createProgressThrottle, yieldToEventLoop } from '@/utils/yieldToEventLoop';
import type { ScanProgressCallback } from '@/volumeAnalysis/IslandScan/ScanOrchestrator';
import {
  EMPTY_ROW,
  packCandidateLayerRuns,
  rleLabelComponents,
  type RleMask,
  type RleRow,
} from '@/volumeAnalysis/IslandScan/rle';
import * as THREE from 'three';
import { type DetectedIsland } from './types';
import { VoxelFootprintBuilder } from './voxelFootprint';
// PORTABILITY: analysis-domain dependencies are confined to this file — the
// scanline island worker (the fast RLE engine the Analysis-tab voxel rescan
// uses). If that infra is removed, this is the one Islands/ module to re-home;
// everything else is independent.

// Pixel-centre offsets — mirror ScanOrchestrator's VOXEL_OFFSET_{X,Y} so contact
// points land in the same world frame as the legacy overlay.
const VOXEL_OFFSET_X = 0.5;
const VOXEL_OFFSET_Y = 0.5;

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

interface CandidateLayerPayload {
  runs: Int32Array;
  detached: Uint8Array;
}

interface LayerComponentMeta {
  id: number;
  areaPx: number;
  isDetached: boolean;
  headRunIdx: number;
  tailRunIdx: number;
}

interface TrackedIsland {
  id: number;
  firstLayer: number;
  lastLayer: number;
  status: 'active' | 'complete';
  parentId: number | null;
  hasSaddleMerged: boolean;
  baseAreaMm2: number;
  lastLayerAreaMm2: number;
  maxAreaMm2: number;
  preMergeMaxAreaMm2: number;
  isDetached: boolean;
  birthSumX: number;
  birthSumY: number;
  birthCount: number;
  contactVoxels: VoxelFootprintBuilder;
}

/**
 * The scan's phases, in order. The count travels with every progress report so
 * the UI can render "2 of 2" without hard-coding a number that differs between
 * the two scan paths.
 */
const PHASES = ['Slicing', 'Connecting islands'] as const;

function phaseNumber(phase: string): number {
  const index = PHASES.indexOf(phase as typeof PHASES[number]);
  return index < 0 ? 1 : index + 1;
}

/** Layers processed between yields while tracking per-layer components. */
const YIELD_INTERVAL_LAYERS = 64;

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
    connectivity: params.connectivity ?? 8,
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
  console.timeEnd('[Islands] slice + candidate extraction');

  const supportBufferPx = Math.max(0, Math.round(params.supportBufferMm / px));
  const r = supportBufferPx + 1;
  const reachRSq =
    params.diagonal3D === false && supportBufferPx === 0
      ? 0
      : params.diagonal3D !== false
        ? Math.max(r * r, 2)
        : r * r;
  const maxDy = Math.floor(Math.sqrt(reachRSq));
  const dxByDy = new Int32Array(maxDy + 1);
  for (let dy = 0; dy <= maxDy; dy++) {
    dxByDy[dy] = Math.floor(Math.sqrt(reachRSq - dy * dy));
  }

  await logToFile('[Islands] phase=track-start');
  console.time('[Islands] bottom-up tracking');

  const islands = new Map<number, TrackedIsland>();
  let nextIslandId = 1;

  const resolveParent = (startId: number): number => {
    let current = startId;
    const visited = new Set<number>();
    for (;;) {
      if (visited.has(current)) break;
      visited.add(current);
      const isl = islands.get(current);
      if (!isl || isl.parentId === null) break;
      current = isl.parentId;
    }
    return current;
  };

  const createNewIsland = (layer: number, areaMm2: number, areaPx: number, isDetached: boolean): TrackedIsland => {
    const id = nextIslandId++;
    const island: TrackedIsland = {
      id,
      firstLayer: layer,
      lastLayer: layer,
      status: 'active',
      parentId: null,
      hasSaddleMerged: false,
      baseAreaMm2: areaMm2,
      lastLayerAreaMm2: areaMm2,
      maxAreaMm2: areaMm2,
      preMergeMaxAreaMm2: areaMm2,
      isDetached,
      birthSumX: 0,
      birthSumY: 0,
      birthCount: 0,
      contactVoxels: new VoxelFootprintBuilder(Math.min(Math.max(1, areaPx), 1024)),
    };
    islands.set(id, island);
    return island;
  };

  const updateIsland = (id: number, layer: number, areaMm2: number): void => {
    const isl = islands.get(id);
    if (!isl) return;

    if (layer === isl.lastLayer) {
      isl.lastLayerAreaMm2 += areaMm2;
    } else {
      if (layer > isl.lastLayer) {
        isl.lastLayer = layer;
      }
      isl.lastLayerAreaMm2 = areaMm2;
    }

    const layerArea = isl.lastLayerAreaMm2;
    if (layerArea > isl.maxAreaMm2) {
      isl.maxAreaMm2 = layerArea;
    }
    if (!isl.hasSaddleMerged && layerArea > isl.preMergeMaxAreaMm2) {
      isl.preMergeMaxAreaMm2 = layerArea;
    }
  };

  const reportProgress = createProgressThrottle();
  let prevIslandRows: Array<Int32Array | null> | null = null;
  let candidateRunCount = 0;

  for (let L = 0; L < numLayers; L++) {
    if (L % YIELD_INTERVAL_LAYERS === 0) {
      reportProgress(() => onProgress?.(L, numLayers, 'Connecting islands', phaseNumber('Connecting islands'), PHASES.length));
      await yieldToEventLoop();
    }

    const layerPayload = candidateLayers[L];
    candidateLayers[L] = undefined;
    if (!layerPayload || layerPayload.runs.length === 0) {
      prevIslandRows = null;
      continue;
    }

    const { runs, detached } = layerPayload;
    const numRuns = runs.length >>> 2;
    candidateRunCount += numRuns;

    const nextRunIdx = new Int32Array(numRuns).fill(-1);
    const compMap = new Map<number, LayerComponentMeta>();
    for (let ri = 0; ri < numRuns; ri++) {
      const off = ri << 2;
      const y = runs[off];
      const len = runs[off + 2];
      const compId = runs[off + 3];
      if (compId <= 0 || len <= 0 || y < 0 || y >= height) continue;

      const existing = compMap.get(compId);
      if (existing) {
        existing.areaPx += len;
        nextRunIdx[existing.tailRunIdx] = ri;
        existing.tailRunIdx = ri;
      } else {
        compMap.set(compId, {
          id: compId,
          areaPx: len,
          isDetached: L === 0 ? true : Boolean(detached[compId]),
          headRunIdx: ri,
          tailRunIdx: ri,
        });
      }
    }

    if (compMap.size === 0) {
      prevIslandRows = null;
      continue;
    }

    const components = Array.from(compMap.values()).sort((a, b) => a.id - b.id);
    const compToIsland = new Map<number, number>();
    const birthCompToIsland = new Map<number, TrackedIsland>();

    if (L === 0 || prevIslandRows === null) {
      for (const comp of components) {
        const areaMm2 = comp.areaPx * px * px;
        const isDetached = L === 0 ? true : comp.isDetached;
        const isl = createNewIsland(L, areaMm2, comp.areaPx, isDetached);
        compToIsland.set(comp.id, isl.id);
        birthCompToIsland.set(comp.id, isl);
      }
    } else {
      const activeAtLayerStart = new Set<number>();
      for (const isl of islands.values()) {
        if (isl.status === 'active') {
          activeAtLayerStart.add(isl.id);
        }
      }

      const continuations: Array<{ target: number; areaMm2: number }> = [];
      const merges: Array<{ ancestor: number; resolved: Set<number>; areaMm2: number }> = [];

      for (const comp of components) {
        const areaMm2 = comp.areaPx * px * px;
        if (comp.isDetached) {
          const isl = createNewIsland(L, areaMm2, comp.areaPx, true);
          compToIsland.set(comp.id, isl.id);
          birthCompToIsland.set(comp.id, isl);
          continue;
        }

        const prevIds = new Set<number>();
        for (let ri = comp.headRunIdx; ri !== -1; ri = nextRunIdx[ri]) {
          const off = ri << 2;
          const y = runs[off];
          const start = runs[off + 1];
          const end = start + runs[off + 2];
          const pyStart = Math.max(0, y - maxDy);
          const pyEnd = Math.min(height - 1, y + maxDy);

          for (let py = pyStart; py <= pyEnd; py++) {
            const pRow = prevIslandRows[py];
            if (!pRow) continue;
            const dx = dxByDy[Math.abs(py - y)];
            const searchStart = start - dx;
            const searchEnd = end + dx;

            for (let j = 0; j < pRow.length; j += 3) {
              const pStart = pRow[j];
              if (pStart >= searchEnd) break;
              const pEnd = pStart + pRow[j + 1];
              const pId = pRow[j + 2];
              if (pEnd > searchStart && pId > 0) {
                prevIds.add(pId);
              }
            }
          }
        }

        const activePrevIds = new Set<number>();
        for (const id of prevIds) {
          if (activeAtLayerStart.has(id)) {
            activePrevIds.add(id);
          }
        }

        if (activePrevIds.size === 0) {
          if (prevIds.size > 0) {
            let minPrev = Infinity;
            for (const id of prevIds) {
              if (id < minPrev) minPrev = id;
            }
            const target = resolveParent(minPrev);
            compToIsland.set(comp.id, target);
            continuations.push({ target, areaMm2 });
          } else {
            const isl = createNewIsland(L, areaMm2, comp.areaPx, false);
            compToIsland.set(comp.id, isl.id);
            birthCompToIsland.set(comp.id, isl);
          }
        } else if (activePrevIds.size === 1) {
          const target = activePrevIds.values().next().value as number;
          compToIsland.set(comp.id, target);
          continuations.push({ target, areaMm2 });
        } else {
          const resolved = new Set<number>();
          for (const id of activePrevIds) {
            resolved.add(resolveParent(id));
          }
          let ancestor = Infinity;
          let ancestorFirstLayer = Infinity;
          for (const id of resolved) {
            const firstLayer = islands.get(id)?.firstLayer ?? Infinity;
            if (
              firstLayer < ancestorFirstLayer ||
              (firstLayer === ancestorFirstLayer && id < ancestor)
            ) {
              ancestorFirstLayer = firstLayer;
              ancestor = id;
            }
          }
          compToIsland.set(comp.id, ancestor);
          merges.push({ ancestor, resolved, areaMm2 });
        }
      }

      const updatedThisLayer = new Set<number>();
      const absorbedThisLayer = new Set<number>();

      for (const { target, areaMm2 } of continuations) {
        updateIsland(target, L, areaMm2);
        updatedThisLayer.add(target);
      }

      for (const { ancestor, resolved, areaMm2 } of merges) {
        if (resolved.size > 1) {
          const ancIsl = islands.get(ancestor);
          if (ancIsl) {
            // Freeze preMergeMaxAreaMm2 before recording the merged layer's area.
            ancIsl.hasSaddleMerged = true;
          }
          for (const id of resolved) {
            if (id !== ancestor) {
              absorbedThisLayer.add(id);
            }
          }
        }
        updateIsland(ancestor, L, areaMm2);
        updatedThisLayer.add(ancestor);
      }

      for (const id of absorbedThisLayer) {
        if (!updatedThisLayer.has(id)) {
          const isl = islands.get(id);
          if (isl) {
            isl.hasSaddleMerged = true;
            isl.status = 'complete';
            isl.parentId = null;
            if (L > 0) {
              isl.lastLayer = L - 1;
            }
          }
        }
      }
    }

    prevIslandRows = buildPrevIslandRowsAndBirthFootprints(
      runs,
      height,
      originX,
      originZ,
      px,
      compToIsland,
      birthCompToIsland,
    );
  }

  candidateLayers.length = 0;
  prevIslandRows = null;
  console.timeEnd('[Islands] bottom-up tracking');
  console.log(`[Islands] candidate (unsupported) runs: ${candidateRunCount.toLocaleString()}`);

  const minAreaMm2 = params.minAreaMm2 ?? 0.02;
  const result: DetectedIsland[] = [];
  let idx = 0;

  for (const isl of islands.values()) {
    const effectiveArea = isl.preMergeMaxAreaMm2 ?? isl.maxAreaMm2;
    const keep = (isl.isDetached && isl.maxAreaMm2 > 0) || effectiveArea >= minAreaMm2;
    if (!keep) continue;

    const contactX = isl.birthCount > 0 ? isl.birthSumX / isl.birthCount : originX;
    const contactY = isl.birthCount > 0 ? isl.birthSumY / isl.birthCount : -originZ;
    const baseZ = minZ + isl.firstLayer * layerHeightMm;

    result.push({
      id: `v${idx++}`,
      source: 'voxel',
      contact: new THREE.Vector3(contactX, contactY, baseZ),
      baseZ,
      rawBaseZ: baseZ,
      areaMm2: isl.baseAreaMm2,
      peakAreaMm2: isl.preMergeMaxAreaMm2 ?? isl.maxAreaMm2,
      isDetached: isl.isDetached,
      layerSpan: [isl.firstLayer, isl.lastLayer],
      contactVoxels: isl.contactVoxels.build(),
    });
  }

  let footprintBytes = 0;
  for (const island of result) {
    if (island.contactVoxels) {
      footprintBytes += island.contactVoxels.xy.byteLength
        + (island.contactVoxels.z?.byteLength ?? 0);
    }
  }
  await logToFile(
    `[Islands] phase=track-done islands=${islands.size} kept=${result.length} `
    + `footprintMiB=${(footprintBytes / 1048576).toFixed(1)}`,
  );
  console.log(`[Islands] islands detected (pre-filter): ${islands.size}, post-filter: ${result.length}`);
  return result;
}

function buildPrevIslandRowsAndBirthFootprints(
  runs: Int32Array,
  height: number,
  originX: number,
  originZ: number,
  px: number,
  compToIsland: Map<number, number>,
  birthCompToIsland: Map<number, TrackedIsland>,
): Array<Int32Array | null> | null {
  const rowLists: Array<number[] | null> = new Array(height).fill(null);
  const rowNeedsSort = new Uint8Array(height);
  const rowLastStart = new Int32Array(height).fill(-1);
  let hasAnyRows = false;

  for (let off = 0; off < runs.length; off += 4) {
    const y = runs[off];
    const start = runs[off + 1];
    const len = runs[off + 2];
    const compId = runs[off + 3];
    if (compId <= 0 || len <= 0 || y < 0 || y >= height) continue;

    const islandId = compToIsland.get(compId) ?? 0;
    if (islandId > 0) {
      hasAnyRows = true;
      let list = rowLists[y];
      if (!list) {
        list = [];
        rowLists[y] = list;
      }
      if (start < rowLastStart[y]) {
        rowNeedsSort[y] = 1;
      }
      rowLastStart[y] = start;
      list.push(start, len, islandId);
    }

    const birthIsl = birthCompToIsland.get(compId);
    if (birthIsl) {
      const vy = -(originZ + y * px + px * VOXEL_OFFSET_Y);
      for (let c = 0; c < len; c++) {
        const vx = originX + (start + c) * px + px * VOXEL_OFFSET_X;
        birthIsl.birthSumX += vx;
        birthIsl.birthSumY += vy;
        birthIsl.birthCount += 1;
        birthIsl.contactVoxels.push(vx, vy);
      }
    }
  }

  if (!hasAnyRows) return null;

  const out: Array<Int32Array | null> = new Array(height).fill(null);
  for (let y = 0; y < height; y++) {
    const list = rowLists[y];
    if (!list) continue;
    if (rowNeedsSort[y]) {
      const triplets: Array<[number, number, number]> = [];
      for (let i = 0; i < list.length; i += 3) {
        triplets.push([list[i], list[i + 1], list[i + 2]]);
      }
      triplets.sort((a, b) => a[0] - b[0]);
      const sorted = new Int32Array(triplets.length * 3);
      for (let i = 0; i < triplets.length; i++) {
        sorted[i * 3] = triplets[i][0];
        sorted[i * 3 + 1] = triplets[i][1];
        sorted[i * 3 + 2] = triplets[i][2];
      }
      out[y] = sorted;
    } else {
      out[y] = new Int32Array(list);
    }
  }
  return out;
}

/** Fallback adapter when a mock worker supplies only legacy `candidatePairs` without `candidateRuns`. */
function packLegacyCandidatePairs(
  pairs: Int32Array,
  width: number,
  height: number,
  connectivity: 4 | 8,
): CandidateLayerPayload {
  if (pairs.length === 0 || width <= 0 || height <= 0) {
    return { runs: new Int32Array(0), detached: new Uint8Array(0) };
  }

  const rowCols: Array<number[] | null> = new Array(height).fill(null);
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const col = pairs[i];
    const row = pairs[i + 1];
    if (col < 0 || col >= width || row < 0 || row >= height) continue;
    let list = rowCols[row];
    if (!list) {
      list = [];
      rowCols[row] = list;
    }
    list.push(col);
  }

  const rows: RleRow[] = new Array(height);
  for (let y = 0; y < height; y++) {
    const cols = rowCols[y];
    if (!cols || cols.length === 0) {
      rows[y] = EMPTY_ROW;
      continue;
    }
    cols.sort((a, b) => a - b);
    const spans: number[] = [];
    let runStart = cols[0];
    let runEnd = runStart + 1;
    for (let i = 1; i < cols.length; i++) {
      const c = cols[i];
      if (c < runEnd) continue;
      if (c === runEnd) {
        runEnd = c + 1;
      } else {
        spans.push(runStart, runEnd - runStart);
        runStart = c;
        runEnd = c + 1;
      }
    }
    spans.push(runStart, runEnd - runStart);
    rows[y] = new Int32Array(spans);
  }

  const mask: RleMask = { rows, width, height };
  const { labels, components } = rleLabelComponents(mask, connectivity);
  const { candidateRuns, componentDetached } = packCandidateLayerRuns(labels, components);
  return { runs: candidateRuns, detached: componentDetached };
}

/**
 * Slice every layer on the scanline worker pool and return each layer's
 * compact packed candidate runs (`[y, start, length, compId, ...]`) and
 * per-component detached flags.
 */
async function sliceCandidateLayers(
  positions: Float32Array,
  gridRef: GridRef,
  minZ: number,
  numLayers: number,
  layerHeightMm: number,
  opts: { px_mm: number; support_buffer_mm: number; connectivity: 4 | 8 },
  onProgress?: ScanProgressCallback,
): Promise<(CandidateLayerPayload | undefined)[]> {
  const candidateLayers: (CandidateLayerPayload | undefined)[] = new Array(numLayers);

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
              const msg = e.data as {
                type?: string;
                result?: {
                  candidatePairs?: Int32Array;
                  candidateRuns?: Int32Array;
                  componentDetached?: Uint8Array;
                };
              };
              if (msg?.type !== 'done') return;
              w.removeEventListener('message', onMessage);
              const res = msg.result;
              if (res?.candidateRuns instanceof Int32Array) {
                candidateLayers[idx] = {
                  runs: res.candidateRuns,
                  detached: res.componentDetached instanceof Uint8Array ? res.componentDetached : new Uint8Array(0),
                };
              } else if (res?.candidatePairs instanceof Int32Array) {
                candidateLayers[idx] = packLegacyCandidatePairs(
                  res.candidatePairs,
                  gridRef.width,
                  gridRef.height,
                  opts.connectivity,
                );
              } else {
                candidateLayers[idx] = { runs: new Int32Array(0), detached: new Uint8Array(0) };
              }
              done++;
              reportSliceProgress(() => onProgress?.(done, numLayers, 'Slicing', phaseNumber('Slicing'), PHASES.length));
              runNext();
            };
            w.addEventListener('message', onMessage);
            w.postMessage({ type: 'layer', z: zTop, layerHeightMm, gridRef, opts, candidatesOnly: true });
          };
          runNext();
        }),
    ),
  );

  workers.forEach((w) => w.terminate());
  return candidateLayers;
}
