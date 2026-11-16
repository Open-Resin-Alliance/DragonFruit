import { BucketedSlicer } from '@/components/analysis/Slice2D';
import { scanLayer } from './island';
import { rleEncode } from './rle';
import { rasterizeSegmentsScanline as rasterizeSegmentsToMask, rasterizeSegmentsToExistingGridScanline as rasterizeSegmentsToExistingGrid } from './scanline';
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

export type IslandWorkerMessage = InitMessage | StartMessage | LayerMessage;

function toMaskFromGridRef(ref: { originX: number; originZ: number; width: number; height: number; px_mm: number }): Mask {
  return { data: new Uint8Array(0), width: ref.width, height: ref.height, originX: ref.originX, originZ: ref.originZ, px_mm: ref.px_mm } as Mask;
}

export function dispatchIslandScanWorkerMessage(
  msg: IslandWorkerMessage | null | undefined,
  post: (payload: { type: 'done'; result: unknown }) => void,
): void {
  if (!msg) return;

  if (msg.type === 'init') {
    slicer = new BucketedSlicer(msg.positions, 5.0);
    return;
  }

  if (msg.type === 'start') {
    const current = { ...msg.current, originX: 0, originZ: 0, px_mm: msg.opts.px_mm } as Mask;
    const prev = msg.prev ? ({ ...msg.prev, originX: 0, originZ: 0, px_mm: msg.opts.px_mm } as Mask) : null;

    const currentRle = rleEncode(current.data, current.width, current.height);
    const prevRle = prev ? rleEncode(prev.data, prev.width, prev.height) : null;
    const res = scanLayer(currentRle, prevRle, msg.opts);
    post({ type: 'done', result: res });
    return;
  }

  if (msg.type === 'layer') {
    if (!slicer) {
      console.error('Worker received layer request before init');
      return;
    }

    const zTop = msg.z;
    const zBot = msg.z - msg.layerHeightMm;

    const segsNow = slicer.sliceSegments(zTop);
    const segsPrev = slicer.sliceSegments(zBot);

    let currentMask: Mask;
    if (msg.gridRef) {
      currentMask = rasterizeSegmentsToExistingGrid(segsNow, toMaskFromGridRef(msg.gridRef));
    } else {
      currentMask = rasterizeSegmentsToMask(segsNow, msg.opts.px_mm, 0);
    }

    // --- TERRITORY LOGIC REMOVED (Handled in ScanOrchestrator Phase 3) ---

    // Standard Island Scan
    const currentRle = rleEncode(currentMask.data, currentMask.width, currentMask.height);
    let prevRle = null;
    if (segsPrev.length > 0) {
      const prevMask = rasterizeSegmentsToExistingGrid(segsPrev, currentMask);
      prevRle = rleEncode(prevMask.data, prevMask.width, prevMask.height);
    }

    const res = scanLayer(currentRle, prevRle, msg.opts);

    post({
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
}

if (typeof self !== 'undefined') {
  self.onmessage = (e: MessageEvent<IslandWorkerMessage>) => {
    dispatchIslandScanWorkerMessage(e.data, (payload) => (self as unknown as { postMessage: (v: unknown) => void }).postMessage(payload));
  };
}
