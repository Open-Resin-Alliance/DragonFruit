/* eslint-disable no-restricted-globals */
import { type ScanLayerResult, type GridRef, VOXEL_OFFSET_X, VOXEL_OFFSET_Y, VOXEL_OFFSET_Z } from './ScanOrchestrator';
import { type RleMask, rleEncode } from './rle';
import { rasterizeLoopsScanline as rasterizeLoopsToMask, rasterizeLoopsToExistingGridScanline as rasterizeLoopsToExistingGrid } from './scanline';
import { type Connectivity, type RasterScanOptions, type Mask } from './types';
import { scanLayer } from './island';
import { BucketedSlicer } from '@/components/analysis/Slice2D';

let slicer: BucketedSlicer | null = null;

interface InitMessage {
    type: 'init';
    positions: Float32Array;
}

interface StartMessage {
    type: 'start';
    current: { data: Uint8Array; width: number; height: number };
    prev: { data: Uint8Array; width: number; height: number } | null;
    opts: RasterScanOptions;
}

interface LayerMessage {
    type: 'layer';
    z: number;
    layerHeightMm: number;
    gridRef?: { originX: number; originZ: number; width: number; height: number; px_mm: number };
    opts: RasterScanOptions;
}

function toMaskFromGridRef(ref: { originX: number; originZ: number; width: number; height: number; px_mm: number }): Mask {
    return { data: new Uint8Array(ref.width * ref.height), width: ref.width, height: ref.height, originX: ref.originX, originZ: ref.originZ, px_mm: ref.px_mm } as Mask;
}

self.onmessage = (e: MessageEvent<InitMessage | StartMessage | LayerMessage>) => {
    const msg = e.data;
    if (!msg) return;

    if (msg.type === 'init') {
        // Initialize bucketed slicer with 5mm buckets (tunable)
        slicer = new BucketedSlicer(msg.positions, 5.0);
        return;
    }

    if (msg.type === 'start') {
        // Legacy start message - not used in main flow anymore but kept for safety
        // Needs update if used, but skipping for now as we use 'layer' messages
        return;
    }

    if (msg.type === 'layer') {
        if (!slicer) {
            console.error('Worker received layer request before init');
            return;
        }

        const t0 = performance.now();

        // Slice geometry locally using optimized slicer
        const zTop = msg.z;
        const zBot = msg.z - msg.layerHeightMm;

        const loopsNow2 = slicer.slice(zTop);
        const loopsPrev2 = slicer.slice(zBot);

        const t1 = performance.now();

        // Convert Vector2 to simple object for rasterizer
        const loopsNow = loopsNow2.map(loop => loop.map(v => ({ x: v.x, y: v.y })));
        const loopsPrev = loopsPrev2.map(loop => loop.map(v => ({ x: v.x, y: v.y })));

        let currentMask: Mask;
        if (msg.gridRef) {
            currentMask = rasterizeLoopsToExistingGrid(loopsNow, toMaskFromGridRef(msg.gridRef));
        } else {
            currentMask = rasterizeLoopsToMask(loopsNow, msg.opts.px_mm, 0);
        }

        // Ensure prevMask matches currentMask dimensions
        let prevMask: Mask | null = null;
        if (loopsPrev) {
            // Create a mask with same dimensions as currentMask
            const pm = { ...currentMask, data: new Uint8Array(currentMask.width * currentMask.height) };
            prevMask = rasterizeLoopsToExistingGrid(loopsPrev, pm);
        }

        const t2 = performance.now();

        // Convert to RLE for processing
        const currentRle = rleEncode(currentMask.data, currentMask.width, currentMask.height);
        const prevRle = prevMask ? rleEncode(prevMask.data, prevMask.width, prevMask.height) : null;

        const t3 = performance.now();

        // Run Island Detection on RLE data
        const res = scanLayer(currentRle, prevRle, msg.opts);

        const t4 = performance.now();

        if (Math.random() < 0.01) { // Log 1% of layers
            console.log(`Layer ${msg.z.toFixed(2)}: Slice ${(t1 - t0).toFixed(2)}ms, Raster ${(t2 - t1).toFixed(2)}ms, RLE Encode ${(t3 - t2).toFixed(2)}ms, Island ${(t4 - t3).toFixed(2)}ms`);
        }

        // Send RLE results back
        // We need to flatten RLE arrays for transfer if they are jagged arrays of Int32Array
        // But postMessage can handle arrays of TypedArrays.
        // However, to be efficient, we might want to keep them as is.
        // ScanOrchestrator expects: islandMaskRle, solidMaskRle, islandCount, labels, components

        // Wait, ScanOrchestrator expects 'islandMaskRle' as Int32Array (single array).
        // But our new RleMask is { rows: Int32Array[] }.
        // We should probably flatten it for transfer or update Orchestrator to handle rows.
        // Flattening is safer for now to match previous "RLE" concept (though previous was 1D RLE).
        // Actually, previous RLE was just a placeholder I implemented in scanline.ts.
        // Let's check what ScanOrchestrator expects.
        // It expects 'islandMaskRle: Int32Array'.
        // My new RleMask is 2D (rows).
        // I should probably flatten it to a single Int32Array with row delimiters or just keep it as rows?
        // Keeping as rows is better for processing but harder to transfer as a single buffer.
        // Let's flatten it: [rowCount, row1_len, ...row1_data, row2_len, ...row2_data]
        // Or just send the array of arrays?
        // Let's send the object structure, but we can't transfer ownership of nested arrays easily.
        // Actually, let's just send the object. Structure clone algorithm handles it.

        (self as any).postMessage({
            type: 'done',
            result: {
                islandMaskRle: res.solidMask, // Wait, islandMask is effectively solidMask for visualization? No.
                // In previous code: islandMask was "labels > 0".
                // In new code: res.labels is RleLabels.
                // We should send res.labels and res.solidMask.

                // ScanOrchestrator expects:
                // islandMaskRle: Int32Array
                // solidMaskRle: Int32Array
                // labels: Int32Array

                // I need to update ScanOrchestrator to accept the new RleMask structure.
                // For now, I will send the new structure and update Orchestrator next.

                islandLabelsRle: res.labels,
                solidMaskRle: res.solidMask,
                islandCount: res.components.length,
                components: res.components,
                grid: { originX: currentMask.originX, originZ: currentMask.originZ, width: currentMask.width, height: currentMask.height, px_mm: currentMask.px_mm },
            }
        });
        return;
    }
};

