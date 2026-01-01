import { BucketedSlicer } from '@/components/analysis/Slice2D';
import { scanLayer } from './island';
import { rleEncode } from './rle';
import { rasterizeLoopsToExistingGrid, rasterizeLoopsToMask } from './raster';
import { type Mask, type RasterScanOptions } from './types';

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
        slicer = new BucketedSlicer(msg.positions, 5.0);
        return;
    }

    if (msg.type === 'start') {
        const current = { ...msg.current, originX: 0, originZ: 0, px_mm: msg.opts.px_mm } as any;
        const prev = (msg as StartMessage).prev ? ({ ...(msg as StartMessage).prev, originX: 0, originZ: 0, px_mm: (msg as StartMessage).opts.px_mm } as any) : null;

        const currentRle = rleEncode(current.data, current.width, current.height);
        const prevRle = prev ? rleEncode(prev.data, prev.width, prev.height) : null;
        const res = scanLayer(currentRle, prevRle, (msg as StartMessage).opts);
        (self as any).postMessage({ type: 'done', result: res });
        return;
    }

    if (msg.type === 'layer') {
        if (!slicer) {
            console.error('Worker received layer request before init');
            return;
        }

        const zTop = msg.z;
        const zBot = msg.z - msg.layerHeightMm;

        const loopsNow2 = slicer.slice(zTop);
        const loopsPrev2 = slicer.slice(zBot);

        // Convert Vector2 to simple object for rasterizer
        const loopsNow = loopsNow2.map(loop => loop.map(v => ({ x: v.x, y: v.y })));
        const loopsPrev = loopsPrev2.map(loop => loop.map(v => ({ x: v.x, y: v.y })));

        let currentMask: Mask;
        if (msg.gridRef) {
            currentMask = rasterizeLoopsToExistingGrid(loopsNow, toMaskFromGridRef(msg.gridRef));
        } else {
            currentMask = rasterizeLoopsToMask(loopsNow, msg.opts.px_mm, 0);
        }

        // Standard Island Scan
        const currentRle = rleEncode(currentMask.data, currentMask.width, currentMask.height);
        let prevRle = null;
        if (loopsPrev && loopsPrev.length > 0) {
            const prevMask = rasterizeLoopsToExistingGrid(loopsPrev, currentMask);
            prevRle = rleEncode(prevMask.data, prevMask.width, prevMask.height);
        }

        const res = scanLayer(currentRle, prevRle, msg.opts);

        (self as any).postMessage({
            type: 'done',
            result: {
                solidMaskRle: currentRle,
                islandLabelsRle: res.labels,
                islandCount: res.components.length,
                components: res.components,
            }
        });
        return;
    }
};
