import * as THREE from 'three';
import { IslandTracker } from './islandTracker';
import { type RleMask, type RleLabels, rleDecode } from './rle';
import type { Island, ComponentInfo } from './types';

export type GridRef = { originX: number; originZ: number; width: number; height: number; px_mm: number };
export type ScanLayerResult = {
  islandMaskRle: RleMask; // RLE compressed mask
  islandCount: number;
  islandLabels: RleLabels; // RLE Island IDs
};
export type ScanResults = {
  grid: GridRef;
  layers: Array<ScanLayerResult>;
  firstHit: Int16Array;
  lastHit: Int16Array;
  baseFootprint: Uint8Array;
  baseLabels: Int32Array;
  compBase: Int16Array;
  compTop: Int16Array;
  islands: Island[]; // All tracked islands with parent-child relationships
  islandLabelsPerLayer: RleLabels[]; // Per-layer island ID grids (RLE)
};

export type ScanParams = {
  px_mm: number;
  support_buffer_mm: number;
  connectivity?: 4 | 8;
  min_island_area_mm2?: number; // Minimum area in mm² for an island to be kept (default: 0.01)
};

export async function runIslandScan(
  geom: { geometry: THREE.BufferGeometry; bbox: THREE.Box3 },
  layerHeightMm: number,
  params: ScanParams,
  onProgress?: (done: number, total: number) => void,
): Promise<ScanResults> {
  return runScanInternal(
    geom,
    layerHeightMm,
    params,
    () => new Worker(new URL('@/workers/islandScan.worker.ts', import.meta.url), { type: 'module' }),
    onProgress
  );
}

export async function runScanlineScan(
  geom: { geometry: THREE.BufferGeometry; bbox: THREE.Box3 },
  layerHeightMm: number,
  params: ScanParams,
  onProgress?: (done: number, total: number) => void,
): Promise<ScanResults> {
  return runScanInternal(
    geom,
    layerHeightMm,
    params,
    () => new Worker(new URL('@/workers/scanlineScan.worker.ts', import.meta.url), { type: 'module' }),
    onProgress
  );
}

async function runScanInternal(
  geom: { geometry: THREE.BufferGeometry; bbox: THREE.Box3 },
  layerHeightMm: number,
  params: ScanParams,
  createWorker: () => Worker,
  onProgress?: (done: number, total: number) => void,
): Promise<ScanResults> {
  const bb = geom.bbox;
  const minX = bb.min.x, maxX = bb.max.x;
  const minMaskY = -bb.max.y; // mask Y corresponds to -Y (horizontal plane is XY)
  const maxMaskY = -bb.min.y;
  const width = Math.max(1, Math.ceil((maxX - minX) / params.px_mm));
  const height = Math.max(1, Math.ceil((maxMaskY - minMaskY) / params.px_mm));
  const gridRef: GridRef = { originX: minX + params.px_mm * 0.5, originZ: minMaskY + params.px_mm * 0.5, width, height, px_mm: params.px_mm };

  // Determine total layers - use Z as vertical axis
  const modelHeightMm = bb.max.z - bb.min.z;
  const numLayers = Math.max(0, Math.ceil(modelHeightMm / layerHeightMm));

  // Store worker results with component data for island tracking
  type WorkerResult = {
    islandMaskRle: RleMask; // Not used? actually it's solidMaskRle that matters
    solidMaskRle: RleMask;
    islandCount: number;
    islandLabelsRle: RleLabels; // Initial component labels from worker
    components: ComponentInfo[];
  };
  const workerResults: Array<WorkerResult> = new Array(numLayers);

  const concurrency = Math.min(Math.max(2, (typeof navigator !== 'undefined' ? (navigator as any).hardwareConcurrency || 4 : 4)), numLayers || 1);
  const workers: Worker[] = Array.from({ length: concurrency }, () => createWorker());

  // Initialize workers with geometry
  const positions = geom.geometry.getAttribute('position').array as Float32Array;
  workers.forEach(w => w.postMessage({ type: 'init', positions }));

  let nextIndex = 0;
  let done = 0;

  console.time('Total Scan');
  console.time('Slicing & Worker Dispatch');

  await Promise.all(workers.map((w) => new Promise<void>((resolve) => {
    const zOffset = geom.bbox.min.z;
    const runNext = async () => {
      if (nextIndex >= numLayers) { resolve(); return; }
      const idx = nextIndex++;

      const zTopGeom = zOffset + (idx + 1) * layerHeightMm + 1e-6;

      const onMessage = (e: MessageEvent) => {
        const msg = e.data as any;
        if (msg?.type !== 'done') return;
        w.removeEventListener('message', onMessage);

        // Store RLE masks directly
        const { islandMaskRle, solidMaskRle, islandCount, islandLabelsRle, components } = msg.result;

        workerResults[idx] = { islandMaskRle, solidMaskRle, islandCount, islandLabelsRle, components };
        done++;
        onProgress?.(done, numLayers);
        runNext();
      };
      w.addEventListener('message', onMessage);
      w.postMessage({
        type: 'layer',
        z: zTopGeom,
        layerHeightMm,
        gridRef,
        opts: { px_mm: params.px_mm, support_buffer_mm: params.support_buffer_mm, connectivity: params.connectivity ?? 4 }
      });
    };
    runNext();
  })));
  workers.forEach(w => w.terminate());

  console.timeEnd('Slicing & Worker Dispatch');

  // Initialize island tracker (filtering happens post-scan based on volume)
  console.time('Island Tracking');
  const tracker = new IslandTracker(params.px_mm);
  const islandLabelsPerLayer: RleLabels[] = new Array(numLayers);

  // Process layers sequentially to propagate island IDs
  for (let L = 0; L < numLayers; L++) {
    const workerResult = workerResults[L];

    const prevIslandLabels = L > 0 ? islandLabelsPerLayer[L - 1] : null;

    // Pass RLE data directly to tracker
    // workerResult.islandLabelsRle contains the component labels (unsupported)
    // workerResult.solidMaskRle contains the full solid geometry
    const islandLabels = tracker.processLayer(
      L,
      workerResult.islandLabelsRle,
      workerResult.components,
      prevIslandLabels,
      workerResult.solidMaskRle
    );

    islandLabelsPerLayer[L] = islandLabels;
  }

  // Finalize all active islands
  tracker.finalizeIslands(numLayers - 1);
  console.timeEnd('Island Tracking');

  console.time('Result Compilation');

  // Get all islands
  const islands = tracker.getIslands();

  // Build final layer results with island labels
  const results: Array<ScanLayerResult> = workerResults.map((wr, idx) => ({
    islandMaskRle: wr.solidMaskRle, // Use solid mask as the base mask
    islandCount: wr.islandCount,
    islandLabels: islandLabelsPerLayer[idx],
  }));

  // Aggregate per-pixel first/last (for backward compatibility and visualization)
  const firstHit = new Int16Array(width * height).fill(-1);
  const lastHit = new Int16Array(width * height).fill(-1);

  // Optimized RLE iteration for firstHit/lastHit
  for (let L = 0; L < results.length; L++) {
    const rleLabels = results[L].islandLabels;
    // Iterate RLE rows
    for (let y = 0; y < rleLabels.height; y++) {
      const row = rleLabels.rows[y];
      const rowOffset = y * width;
      for (let i = 0; i < row.length; i += 3) {
        const start = row[i];
        const len = row[i + 1];
        // const id = row[i+2]; // We just need to know it's an island

        for (let j = 0; j < len; j++) {
          const idx = rowOffset + start + j;
          if (firstHit[idx] === -1) firstHit[idx] = L;
          lastHit[idx] = L;
        }
      }
    }
  }

  const baseFootprint = new Uint8Array(width * height);
  for (let i = 0; i < baseFootprint.length; i++) baseFootprint[i] = firstHit[i] !== -1 ? 1 : 0;

  // Label connected components on base footprint (4-connect)
  // We can use RLE for this too if we encode baseFootprint, but it's 2D.
  // For now, keep legacy pixel-based labeling for base footprint as it's single layer.
  const labels = new Int32Array(width * height);
  let nextId = 1;
  const compMinFirst: number[] = [0];
  const compMaxLast: number[] = [0];
  const q: number[] = [];
  const push = (p: number) => { q.push(p); };
  const pop = () => q.pop() as number;
  const neighbors = (p: number): number[] => {
    const r = (p / width) | 0;
    const c = p % width;
    const arr: number[] = [];
    if (r > 0) arr.push((r - 1) * width + c);
    if (r + 1 < height) arr.push((r + 1) * width + c);
    if (c > 0) arr.push(r * width + (c - 1));
    if (c + 1 < width) arr.push(r * width + (c + 1));
    return arr;
  };
  for (let idx = 0; idx < baseFootprint.length; idx++) {
    if (baseFootprint[idx] !== 1 || labels[idx] !== 0) continue;
    const id = nextId++;
    let minF = Infinity;
    let maxT = -1;
    labels[idx] = id; push(idx);
    while (q.length) {
      const cur = pop();
      const fh = firstHit[cur];
      const lh = lastHit[cur];
      if (fh !== -1 && fh < minF) minF = fh;
      if (lh !== -1 && lh > maxT) maxT = lh;
      for (const nb of neighbors(cur)) {
        if (baseFootprint[nb] === 1 && labels[nb] === 0) { labels[nb] = id; push(nb); }
      }
    }
    compMinFirst[id] = isFinite(minF) ? minF : -1;
    compMaxLast[id] = maxT;
  }
  const compBase = new Int16Array(nextId);
  const compTop = new Int16Array(nextId);
  for (let i = 1; i < nextId; i++) { compBase[i] = (compMinFirst[i] ?? -1) as number; compTop[i] = (compMaxLast[i] ?? -1) as number; }

  // Build preliminary scan results for volume calculation
  const scanResults: ScanResults = {
    grid: gridRef,
    layers: results,
    firstHit,
    lastHit,
    baseFootprint,
    baseLabels: labels,
    compBase,
    compTop,
    islands,
    islandLabelsPerLayer,
  };

  // Calculate volumes for each island using perLayerAreaMm2 (accurate, not affected by relabeling)
  for (const island of islands) {
    let volumeMm3 = 0;

    // Use perLayerAreaMm2 which was recorded at the time each layer was processed
    // This is accurate because it captures the area BEFORE any relabeling from merges
    for (const [layer, areaMm2] of island.perLayerAreaMm2) {
      volumeMm3 += areaMm2 * layerHeightMm;
    }

    console.log(`Island ${island.id}: ${island.perLayerAreaMm2.size} layers (L${island.firstLayer}-${island.lastLayer}) = ${volumeMm3.toFixed(4)} mm³, status: ${island.status}, parentId: ${island.parentId || 'none'}`);
    island.volumeMm3 = volumeMm3;
  }

  // Calculate max area for each island (for filtering)
  for (const island of islands) {
    let maxAreaMm2 = 0;
    for (const areaMm2 of island.perLayerAreaMm2.values()) {
      if (areaMm2 > maxAreaMm2) maxAreaMm2 = areaMm2;
    }
    island.maxAreaMm2 = maxAreaMm2;
  }

  // Filter out temporary merged placeholder islands
  // These are created during merge evaluation and should not be shown to user
  const realIslands = islands.filter(island => !island.isMergedPlaceholder);
  console.log(`Filtered ${islands.length - realIslands.length} temporary merged placeholder islands`);

  // Build map of placeholder -> parent for pixel reassignment
  // IMPORTANT: Need to resolve chains of placeholders (placeholder -> placeholder -> real parent)
  const placeholderToParent = new Map<number, number>();
  for (const island of islands) {
    if (island.isMergedPlaceholder && island.parentId !== undefined) {
      placeholderToParent.set(island.id, island.parentId);
    }
  }

  // Resolve placeholder chains to find the true parent (non-placeholder)
  // Example: #25 -> #23 -> #19 -> #16 -> #1 (true parent)
  function resolveTrueParent(islandId: number): number {
    let current = islandId;
    const visited = new Set<number>();

    while (placeholderToParent.has(current)) {
      // Detect cycles (shouldn't happen, but safety check)
      if (visited.has(current)) {
        console.error(`Cycle detected in placeholder chain for island ${islandId}`);
        break;
      }
      visited.add(current);
      current = placeholderToParent.get(current)!;
    }

    return current;
  }

  // Filter islands based on minimum area threshold (not volume!)
  // Area is more relevant for 3D printing - if the base is too small, it won't print
  const minAreaMm2 = params.min_island_area_mm2 ?? 0.01; // Default 0.01 mm² (0.1mm x 0.1mm)
  const filteredIslands = realIslands.filter(island => (island.maxAreaMm2 ?? 0) >= minAreaMm2);
  const filteredIslandIds = new Set(filteredIslands.map(i => i.id));

  // Reassign placeholder pixels to their TRUE parent islands (following chains), and remove area-filtered islands
  // Optimized for RLE
  for (let L = 0; L < islandLabelsPerLayer.length; L++) {
    const layerLabels = islandLabelsPerLayer[L];
    // Iterate rows
    for (let y = 0; y < layerLabels.height; y++) {
      const row = layerLabels.rows[y];
      // Iterate runs
      for (let i = 0; i < row.length; i += 3) {
        const islandId = row[i + 2];
        if (islandId > 0) {
          // If this is a placeholder island, resolve to true parent
          if (placeholderToParent.has(islandId)) {
            row[i + 2] = resolveTrueParent(islandId);
          }
          // If this island was filtered out by area threshold, remove it
          else if (!filteredIslandIds.has(islandId)) {
            row[i + 2] = 0;
          }
        }
      }
    }
  }

  // Update scan results with filtered islands
  scanResults.islands = filteredIslands;

  console.timeEnd('Result Compilation');
  console.timeEnd('Total Scan');

  return scanResults;
}

