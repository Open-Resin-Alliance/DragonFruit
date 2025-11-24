/* eslint-disable no-restricted-globals */
import { type RasterScanOptions, type Mask } from '@/modules/island/types';
import { scanLayer } from '@/modules/island/island';
import { rasterizeLoopsToMask, rasterizeLoopsToExistingGrid } from '@/modules/island/raster';
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
    const current = { ...msg.current, originX: 0, originZ: 0, px_mm: msg.opts.px_mm } as any;
    const prev = (msg as StartMessage).prev ? ({ ...(msg as StartMessage).prev, originX: 0, originZ: 0, px_mm: (msg as StartMessage).opts.px_mm } as any) : null;
    const res = scanLayer(current, prev, (msg as StartMessage).opts);
    (self as any).postMessage({ type: 'done', result: res });
    return;
  }

  if (msg.type === 'layer') {
    if (!slicer) {
      console.error('Worker received layer request before init');
      return;
    }

    // Slice geometry locally using optimized slicer
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
    const prevMask = loopsPrev ? rasterizeLoopsToExistingGrid(loopsPrev, currentMask) : null;
    const res = scanLayer(currentMask, prevMask, msg.opts);
    const islandMask = new Uint8Array(res.labels.data.length);
    for (let i = 0; i < res.labels.data.length; i++) islandMask[i] = res.labels.data[i] > 0 ? 1 : 0;
    const solidMask = new Uint8Array(currentMask.data.length);
    for (let i = 0; i < currentMask.data.length; i++) solidMask[i] = currentMask.data[i] ? 1 : 0;
    (self as any).postMessage({
      type: 'done',
      result: {
        islandMask,
        solidMask,
        islandCount: res.components.length,
        labels: res.labels.data, // Include full label grid for ID tracking
        components: res.components, // Include component metadata
        grid: { originX: currentMask.originX, originZ: currentMask.originZ, width: currentMask.width, height: currentMask.height, px_mm: currentMask.px_mm },
      }
    });
    return;
  }
};
