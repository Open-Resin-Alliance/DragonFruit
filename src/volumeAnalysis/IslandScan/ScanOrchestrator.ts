import * as THREE from 'three';
import { IslandTracker } from './islandTracker';
import { type RleMask, type RleLabels, rleDecode, rleEncodeLabels } from './rle';
export type { RleLabels };
import { TerritoryTracker } from '@/volumeAnalysis/TerritorySystem/TerritoryTracker';
import type { Island, ComponentInfo } from './types';

// Offset ratios for visual alignment of voxels and overlays.
// 0.5 = Center of pixel.
// Independent axis control requested.
export const VOXEL_OFFSET_X = 0.5;
export const VOXEL_OFFSET_Y = 0;
export const VOXEL_OFFSET_Z = 0.5;

export type GridRef = { originX: number; originZ: number; width: number; height: number; px_mm: number };
export type ScanLayerResult = {
  islandMaskRle: RleMask; // RLE compressed mask
  islandCount: number;
  islandLabels: RleLabels; // RLE Island IDs
  territoryLabels?: RleLabels; // RLE Territory IDs (Densified Kingdoms)
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
  territoryLabelsPerLayer?: RleLabels[]; // Per-layer territory ID grids (RLE)
};

export type ScanParams = {
  px_mm: number;
  support_buffer_mm: number;
  connectivity?: 4 | 8;
  min_island_area_mm2?: number; // Minimum area in mm² for an island to be kept (default: 0.01)
  min_overlap_px?: number;
  overlap_neighborhood_px?: number;
  useSurfaceContiguity?: boolean; // If true, favors surface connectivity (neighbors) over internal volume proximity
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
    () => new Worker(new URL('@/volumeAnalysis/IslandScan/islandScan.worker.ts', import.meta.url), { type: 'module' }),
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
    () => new Worker(new URL('@/volumeAnalysis/IslandScan/scanlineScan.worker.ts', import.meta.url), { type: 'module' }),
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
  // originX/Z are now grid corners (minX), not pixel centers.
  const gridRef: GridRef = { originX: minX, originZ: minMaskY, width, height, px_mm: params.px_mm };

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
    territoryLabelsRle?: RleLabels; // New Territory Data
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
        const { islandMaskRle, solidMaskRle, islandCount, islandLabelsRle, components, territoryLabelsRle } = msg.result;

        workerResults[idx] = { islandMaskRle, solidMaskRle, islandCount, islandLabelsRle, components, territoryLabelsRle };
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
  const tracker = new IslandTracker(params.px_mm, {
    minOverlapPx: params.min_overlap_px,
    overlapNeighborhoodPx: params.overlap_neighborhood_px,
  });
  const islandLabelsPerLayer: RleLabels[] = new Array(numLayers);

  // Process layers sequentially to propagate island IDs
  for (let L = 0; L < numLayers; L++) {
    const workerResult = workerResults[L];

    const prevIslandLabels = L > 0 ? islandLabelsPerLayer[L - 1] : null;

    // 1. Island Tracking
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

  // --- PHASE 3: TERRITORY ANALYSIS (Second Pass) ---
  console.time('Territory Tracking');
  const islands = tracker.getIslands(); // Now contains Final Centroids
  const territoryTracker = new TerritoryTracker(islands);
  const territoryLabelsPerLayer: RleLabels[] = new Array(numLayers);
  let prevTerritoryMap: RleLabels | null = null;

  for (let L = 0; L < numLayers; L++) {
    const workerResult = workerResults[L];

    // Decode RLE solid mask to dense grid for TerritoryTracker -- NO LONGER NEEDED (RLE LOGIC)
    // const denseMask = rleDecode(workerResult.solidMaskRle);

    // Process using Global Centroids + Connectivity (RLE Mode)
    // Note: processLayer now accepts RleLabels directly. 
    // We pass 'islandLabelsRle' which contains the PRE-MERGE island IDs (needed for correct decomposition?)
    // Actually, 'workerResult.islandLabelsRle' has Component IDs, not Island IDs.
    // IslandTracker converts Component IDs to Island IDs.
    // 'islandLabelsPerLayer[L]' contains the Resolved Island IDs in RLE format.
    // This is what we want! Use the output of Phase 1.

    // IMPORTANT: 'islandLabelsPerLayer[L]' is available here.
    const islandLabelsRle = islandLabelsPerLayer[L];

    const territoryRes = territoryTracker.processLayer(
      islandLabelsRle,
      gridRef.width,
      gridRef.height,
      L,
      prevTerritoryMap
    );

    // Encode result for storage - processLayer now returns RLE map directly!
    // territoryLabelsPerLayer[L] = rleEncodeLabels(territoryRes.labelMap, gridRef.width, gridRef.height);
    territoryLabelsPerLayer[L] = territoryRes.labelMap;

    // Keep dense map for next layer's connectivity check
    // The Watershed Logic REQUIRES knowing the prev layer's territories for vertical growth.
    // So we must pass the result of this layer as the input for the next.
    prevTerritoryMap = territoryRes.labelMap;
  }
  console.timeEnd('Territory Tracking');

  console.time('Result Compilation');

  // Build final layer results with island labels
  // Note: We use the already-computed separate array for territoryLabels
  const results: Array<ScanLayerResult> = workerResults.map((wr, idx) => ({
    islandMaskRle: wr.solidMaskRle, // Use solid mask as the base mask
    islandCount: wr.islandCount,
    islandLabels: islandLabelsPerLayer[idx],
    territoryLabels: territoryLabelsPerLayer[idx]
  }));

  // Aggregate per-pixel first/last (for backward compatibility and visualization)
  const firstHit = new Int16Array(width * height).fill(-1);
  const lastHit = new Int16Array(width * height).fill(-1);
  const baseLabels = new Int32Array(width * height).fill(0);

  // Optimized RLE iteration for firstHit/lastHit and baseLabels
  for (let L = 0; L < results.length; L++) {
    const rleLabels = results[L].islandLabels;
    // Iterate RLE rows
    for (let y = 0; y < rleLabels.height; y++) {
      const row = rleLabels.rows[y];
      const rowOffset = y * width;
      for (let i = 0; i < row.length; i += 3) {
        const start = row[i];
        const len = row[i + 1];
        const id = row[i + 2]; // Island ID

        for (let j = 0; j < len; j++) {
          const idx = rowOffset + start + j;
          if (firstHit[idx] === -1) {
            firstHit[idx] = L;
            // Store the Island ID that created this first hit
            if (id > 0) baseLabels[idx] = id;
          }
          lastHit[idx] = L;
        }
      }
    }
  }

  const baseFootprint = new Uint8Array(width * height);
  for (let i = 0; i < baseFootprint.length; i++) baseFootprint[i] = firstHit[i] !== -1 ? 1 : 0;

  // Populate compBase/compTop maps from island data
  // Find max ID to size arrays
  let maxId = 0;
  for (const island of islands) {
    if (island.id > maxId) maxId = island.id;
  }

  const compBase = new Int16Array(maxId + 1).fill(-1);
  const compTop = new Int16Array(maxId + 1).fill(-1);

  for (const island of islands) {
    compBase[island.id] = island.firstLayer;
    compTop[island.id] = island.lastLayer;
  }

  // Build preliminary scan results for volume calculation
  const scanResults: ScanResults = {
    grid: gridRef,
    layers: results,
    firstHit,
    lastHit,
    baseFootprint,
    baseLabels,
    compBase,
    compTop,
    islands,
    islandLabelsPerLayer,
    territoryLabelsPerLayer,
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

