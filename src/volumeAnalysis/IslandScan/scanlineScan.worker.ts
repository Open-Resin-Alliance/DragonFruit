import { type ScanLayerResult, type GridRef, VOXEL_OFFSET_X, VOXEL_OFFSET_Y, VOXEL_OFFSET_Z } from './ScanOrchestrator';
import { type RleMask, candidateVoxelPairs, rleEncode } from './rle';
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

        // Only the candidate voxels go back. The RLE, the solid mask, the
        // components and the grid all describe this layer to a caller that only
        // wants these, and cloning them per layer on the receiving thread was
        // most of a scan's wall clock. See `candidateVoxelPairs`.
        self.postMessage({
            type: 'done',
            result: { candidatePairs: candidateVoxelPairs(res.labels) },
        });
        return;
    }
};

