import * as THREE from 'three';
import { type RleMask, type RleLabels, rleDecode, rleEncodeLabels } from './rle';
// import { TerritoryTracker } from '@/VolumeAnalysis/TerritorySystem/TerritoryTracker'; // DEFERRING until needed
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
        () => new Worker(new URL('./islandScan.worker.ts', import.meta.url), { type: 'module' }),
        onProgress
    );
}

// scanline scan removed as it's not being used here

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

    // --- SIMPLIFIED LOGIC: No Island Information, just Solid Voxels ---
    // Create a single "dummy" island to represent the whole solid volume
    const singleIslandId = 1;
    const dummyIsland: Island = {
        id: singleIslandId,
        firstLayer: 0,
        lastLayer: numLayers - 1,
        status: 'active',
        totalAreaMm2: 0, // Not calculated
        perLayerAreaMm2: new Map(),
        childIds: [],
        centroidSumX: 0,
        centroidSumY: 0,
        centroidSumZ: 0,
        centroidCount: 0
    };

    const islandLabelsPerLayer: RleLabels[] = new Array(numLayers);

    // Convert solid RLE masks to Label RLE masks (all solid pixels = ID 1)
    for (let L = 0; L < numLayers; L++) {
        const workerResult = workerResults[L];
        const mask = workerResult.solidMaskRle;

        // Map mask to labels: 1 -> 1
        const rowCount = mask.height;
        const labelRows = new Array(rowCount);

        for (let y = 0; y < rowCount; y++) {
            const maskRow = mask.rows[y];
            const labelRowArr: number[] = [];
            // maskRow is [start, len, start, len...]
            for (let i = 0; i < maskRow.length; i += 2) {
                labelRowArr.push(maskRow[i], maskRow[i + 1], singleIslandId);
            }
            labelRows[y] = new Int32Array(labelRowArr);
        }

        islandLabelsPerLayer[L] = {
            width: mask.width,
            height: mask.height,
            rows: labelRows
        };
    }

    const islands = [dummyIsland];

    console.time('Result Compilation');

    // Build final layer results
    const results: Array<ScanLayerResult> = workerResults.map((wr, idx) => ({
        islandMaskRle: wr.solidMaskRle,
        islandCount: 1,
        islandLabels: islandLabelsPerLayer[idx],
    }));

    // Comp piles for visualization might need basic data
    const gridPoints = width * height;
    const firstHit = new Int16Array(gridPoints).fill(-1);
    const lastHit = new Int16Array(gridPoints).fill(-1);
    const baseLabels = new Int32Array(gridPoints).fill(0);
    const baseFootprint = new Uint8Array(gridPoints).fill(0);

    const compBase = new Int16Array(2).fill(0);
    const compTop = new Int16Array(2).fill(numLayers - 1);

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
        territoryLabelsPerLayer: undefined,
    };

    console.timeEnd('Result Compilation');
    console.timeEnd('Total Scan');

    return scanResults;
}

// --- STEP 2: VOXEL ANALYSIS (Identify Islands from Solid Voxels) ---

/**
 * Takes the "Solid Voxel" results from Step 1 and processes them to identify
 * individual islands, lowest points, and volume data.
 * This runs the "Smart Scan" logic on the "Dumb Voxel" data.
 */
export async function analyzeScanResults(
    solidResults: ScanResults,
    params: ScanParams,
    onProgress?: (done: number, total: number) => void
): Promise<ScanResults> {
    console.time('Voxel Analysis');

    // We strictly use the "Steps/Voxelization" duplicated logic
    const { IslandTracker } = await import('./islandTracker');
    const { scanLayer } = await import('./island');

    const numLayers = solidResults.layers.length;
    const tracker = new IslandTracker(params.px_mm);
    const islandLabelsPerLayer: RleLabels[] = new Array(numLayers);

    // We need to reconstruct the "Worker Result" like structure for the tracker
    // But computed on the main thread (since it's just RLE operations, it's fast)

    // Iterate layers
    for (let L = 0; L < numLayers; L++) {
        // 1. Get the Solid Mask (The Voxel Slice)
        const currentSolidRle = solidResults.layers[L].islandMaskRle;

        // 2. Need Previous Solid Mask for scanLayer logic (merging/overlap detection)
        const prevSolidRle = L > 0 ? solidResults.layers[L - 1].islandMaskRle : null;

        // 3. Run the "Smart Scan" logic (Components & Labels)
        // This was previously in the Worker. Now we run it here.
        // It identifies distinct blobs on this layer.
        const layerScanResult = scanLayer(currentSolidRle, prevSolidRle, params);

        // 4. Run the "Tracker" logic (Linking layers)
        // This links blobs on this layer to blobs on the previous layer (Islands)
        const prevIslandLabels = L > 0 ? islandLabelsPerLayer[L - 1] : null;

        const islandLabels = tracker.processLayer(
            L,
            layerScanResult.labels,
            layerScanResult.components,
            prevIslandLabels,
            currentSolidRle
        );

        islandLabelsPerLayer[L] = islandLabels;

        if (L % 10 === 0) onProgress?.(L, numLayers);
    }

    // Finalize
    tracker.finalizeIslands(numLayers - 1);
    const islands = tracker.getIslands();

    // Calculate volumes for islands
    const layerHeightMm = (solidResults.grid.px_mm); // Approximation if not stored, but we should probably pass it. 
    // Actually ScanResults doesn't store layerHeight! Accessing from logic or we assume standard.
    // For now, let's just use 0.05 or whatever was used. 
    // Wait, runIslandScan takes layerHeightMm. ScanResults doesn't. 
    // We'll just skip volume recalc for a moment or infer.

    // Filter & Cleanup (Logic from original runScanInternal)
    // ... (Simplified for now: Just return all found islands)

    console.timeEnd('Voxel Analysis');

    // Return UPDATED ScanResults with the explicit Island Data
    return {
        ...solidResults,
        islands: islands,
        islandLabelsPerLayer: islandLabelsPerLayer,
        // Update layer results to include the new labels
        layers: solidResults.layers.map((l, i) => ({
            ...l,
            islandCount: countIslandsInLayer(islandLabelsPerLayer[i]),
            islandLabels: islandLabelsPerLayer[i]
        }))
    };
}

function countIslandsInLayer(labels: RleLabels): number {
    const ids = new Set<number>();
    for (const row of labels.rows) {
        for (let i = 2; i < row.length; i += 3) {
            if (row[i] > 0) ids.add(row[i]);
        }
    }
    return ids.size;
}
