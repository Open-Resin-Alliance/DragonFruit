import JSZip from 'jszip';
import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import type { MaterialProfile, PrinterProfile } from '@/features/profiles/profileStore';

const MAX_CANVAS_PIXELS = 24_000_000;

export type RasterLayerZipExportOptions = {
  models: LoadedModel[];
  printerProfile: PrinterProfile;
  materialProfile: MaterialProfile;
  filenameBase: string;
  outputMode?: 'download' | 'return';
  abortSignal?: AbortSignal;
  onProgress?: (done: number, total: number, phase: string) => void;
};

function createAbortError(message = 'Slicing canceled by user.'): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException(message, 'AbortError');
  }

  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

export type RasterLayerZipArtifact = {
  blob: Blob;
  outputName: string;
  totalLayers: number;
};

type RasterizedLayerEntry = {
  name: string;
  blob: Blob;
};

type RasterizationResult = {
  settings: EffectiveSettings;
  totalLayers: number;
  tallestObjectHeightMm: number;
  visibleModels: LoadedModel[];
  layerEntries: RasterizedLayerEntry[];
  manifest: Record<string, unknown>;
};

export type RasterizedLayerStackForWasm = {
  widthPx: number;
  heightPx: number;
  layerHeightMm: number;
  totalLayers: number;
  tallestObjectHeightMm: number;
  layerPngs: Uint8Array[];
  metadataJson: string;
};

export type SolidSliceMeshForWasm = {
  sourceWidthPx: number;
  sourceHeightPx: number;
  widthPx: number;
  heightPx: number;
  xPackingMode: 'none' | 'rgb8_div3' | 'gray3_div2';
  buildWidthMm: number;
  buildDepthMm: number;
  layerHeightMm: number;
  totalLayers: number;
  tallestObjectHeightMm: number;
  trianglesXYZ: Float32Array;
  metadataJson: string;
};

type RasterTriangle = {
  zMin: number;
  zMax: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  x3: number;
  y3: number;
};

type WorldTriangle = {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  cx: number;
  cy: number;
  cz: number;
  zMin: number;
  zMax: number;
};

type SliceSegment2D = {
  x1: number;
  y1: number;
  dxDy: number;
  yMin: number;
  yMax: number;
};

type EffectiveSettings = {
  widthPx: number;
  heightPx: number;
  sourceResolutionX: number;
  sourceResolutionY: number;
  xPackingMode: 'none' | 'rgb8_div3' | 'gray3_div2';
  layerHeightMm: number;
  totalLayers: number;
  tallestObjectHeightMm: number;
};

function resolveNanodlpPackedWidth(printerProfile: PrinterProfile): {
  widthPx: number;
  sourceResolutionX: number;
  sourceResolutionY: number;
  xPackingMode: 'none' | 'rgb8_div3' | 'gray3_div2';
} {
  const sourceResolutionX = Math.max(1, Math.round(printerProfile.display.resolutionX));
  const sourceResolutionY = Math.max(1, Math.round(printerProfile.display.resolutionY));

  const explicitBitDepth = Number(printerProfile.bitDepth?.bits);
  let bitDepth = Number.isFinite(explicitBitDepth) && explicitBitDepth > 0
    ? Math.round(explicitBitDepth)
    : 0;

  if (bitDepth <= 0) {
    const fingerprint = [
      printerProfile.name,
      printerProfile.manufacturer,
      printerProfile.officialPresetId,
      printerProfile.id,
    ]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join(' ')
      .toLowerCase();

    if (/\b3\s*[-_ ]?bit\b|\b3b\b|16k3b|gray3/.test(fingerprint)) {
      bitDepth = 3;
    } else if (/\b8\s*[-_ ]?bit\b|\b8b\b|rgb8/.test(fingerprint)) {
      bitDepth = 8;
    } else {
      const divisibleBy2 = sourceResolutionX % 2 === 0;
      const divisibleBy3 = sourceResolutionX % 3 === 0;

      if (divisibleBy2 && !divisibleBy3) {
        bitDepth = 3;
      } else if (divisibleBy3 && !divisibleBy2) {
        bitDepth = 8;
      } else if (divisibleBy2 && divisibleBy3) {
        // Ambiguous resolution: prefer Mono/3-bit path for Athena-class NanoDLP printers.
        bitDepth = /rgb|color/.test(fingerprint) ? 8 : 3;
      } else {
        // Failsafe: NanoDLP path should remain packed; default to 3-bit packing.
        bitDepth = 3;
      }
    }
  }

  if (bitDepth === 8) {
    // NanoDLP RGB 8-bit path packs 3 subpixels into 1 RGB output pixel on X.
    return {
      widthPx: Math.max(1, Math.round(sourceResolutionX / 3)),
      sourceResolutionX,
      sourceResolutionY,
      xPackingMode: 'rgb8_div3',
    };
  }

  if (bitDepth === 3) {
    // NanoDLP 3-bit path packs 2 source subpixels into 1 grayscale output pixel on X.
    return {
      widthPx: Math.max(1, Math.round(sourceResolutionX / 2)),
      sourceResolutionX,
      sourceResolutionY,
      xPackingMode: 'gray3_div2',
    };
  }

  // Unknown/unsupported bit-depth values still default to 3-bit packed path for NanoDLP.
  return {
    widthPx: Math.max(1, Math.round(sourceResolutionX / 2)),
    sourceResolutionX,
    sourceResolutionY,
    xPackingMode: 'gray3_div2',
  };
}

function clampLayerIndex(index: number, totalLayers: number): number {
  if (index < 0) return 0;
  if (index >= totalLayers) return totalLayers - 1;
  return index;
}

function buildLayerTriangleBuckets(
  triangles: RasterTriangle[],
  totalLayers: number,
  layerHeightMm: number,
): number[][] {
  const buckets: number[][] = Array.from({ length: totalLayers }, () => []);

  for (let triIndex = 0; triIndex < triangles.length; triIndex += 1) {
    const tri = triangles[triIndex];
    if (tri.zMax < 0) continue;

    const startLayer = clampLayerIndex(Math.floor(tri.zMin / layerHeightMm), totalLayers);
    const endLayer = clampLayerIndex(Math.floor(tri.zMax / layerHeightMm), totalLayers);

    for (let layer = startLayer; layer <= endLayer; layer += 1) {
      buckets[layer].push(triIndex);
    }
  }

  return buckets;
}

function shouldEmitProgress(layerIndex: number, totalLayers: number): boolean {
  if (layerIndex === 0) return true;
  if (layerIndex === totalLayers - 1) return true;
  return layerIndex % 10 === 9;
}

function sameIndexSet(a: number[] | null, b: number[]): boolean {
  if (!a) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function safeFilenameBase(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'slice_export';
  const cleaned = trimmed.replace(/[^a-z0-9-_]+/gi, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'slice_export';
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const nav = typeof navigator !== 'undefined'
    ? (navigator as Navigator & { msSaveOrOpenBlob?: (payload: Blob, name?: string) => boolean })
    : null;

  if (nav?.msSaveOrOpenBlob) {
    nav.msSaveOrOpenBlob(blob, filename);
    return;
  }

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('Browser download APIs are unavailable in this runtime.');
  }

  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';

  document.body?.appendChild(anchor);
  anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  anchor.remove();

  window.setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 1000);
}

function composeModelMatrix(transform: LoadedModel['transform']): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromEuler(transform.rotation);
  return new THREE.Matrix4().compose(transform.position, q, transform.scale);
}

function toPixelX(xMm: number, minX: number, widthMm: number, widthPx: number): number {
  return ((xMm - minX) / widthMm) * (widthPx - 1);
}

function toPixelY(yMm: number, minY: number, depthMm: number, heightPx: number): number {
  // Canvas Y increases downward, build plate Y increases upward.
  return (1 - ((yMm - minY) / depthMm)) * (heightPx - 1);
}

function getCanvas(widthPx: number, heightPx: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(widthPx, heightPx);
  }

  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = widthPx;
    canvas.height = heightPx;
    return canvas;
  }

  throw new Error('No canvas implementation available in this runtime.');
}

async function nanodlpPackRgbaToPngBlob(
  sourceRgba: Uint8ClampedArray,
  sourceWidthPx: number,
  sourceHeightPx: number,
  outputWidthPx: number,
  packingMode: EffectiveSettings['xPackingMode'],
): Promise<Blob> {
  const outCanvas = getCanvas(outputWidthPx, sourceHeightPx);
  const outCtx = outCanvas.getContext('2d', { willReadFrequently: false }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!outCtx) {
    throw new Error('Failed to create 2D context for NanoDLP packing.');
  }

  const outImage = new ImageData(outputWidthPx, sourceHeightPx);
  const out = outImage.data;

  if (packingMode === 'rgb8_div3') {
    const requiredSubpixels = outputWidthPx * 3;
    const padTotal = Math.max(0, requiredSubpixels - sourceWidthPx);
    const padLeft = Math.floor(padTotal / 2);

    for (let y = 0; y < sourceHeightPx; y += 1) {
      const srcRow = y * sourceWidthPx;
      const outRow = y * outputWidthPx;
      for (let x = 0; x < outputWidthPx; x += 1) {
        const sx = x * 3 - padLeft;
        const pOut = (outRow + x) * 4;
        const r = sx >= 0 && sx < sourceWidthPx ? sourceRgba[(srcRow + sx) * 4] : 0;
        const g = sx + 1 >= 0 && sx + 1 < sourceWidthPx ? sourceRgba[(srcRow + sx + 1) * 4] : 0;
        const b = sx + 2 >= 0 && sx + 2 < sourceWidthPx ? sourceRgba[(srcRow + sx + 2) * 4] : 0;
        out[pOut] = r;
        out[pOut + 1] = g;
        out[pOut + 2] = b;
        out[pOut + 3] = 255;
      }
    }
  } else if (packingMode === 'gray3_div2') {
    const requiredSubpixels = outputWidthPx * 2;
    const padTotal = Math.max(0, requiredSubpixels - sourceWidthPx);
    const padLeft = Math.floor(padTotal / 2);

    for (let y = 0; y < sourceHeightPx; y += 1) {
      const srcRow = y * sourceWidthPx;
      const outRow = y * outputWidthPx;
      for (let x = 0; x < outputWidthPx; x += 1) {
        const sx = x * 2 - padLeft;
        const a = sx >= 0 && sx < sourceWidthPx ? sourceRgba[(srcRow + sx) * 4] : 0;
        const b = sx + 1 >= 0 && sx + 1 < sourceWidthPx ? sourceRgba[(srcRow + sx + 1) * 4] : 0;
        const gray = ((a + b) >> 1);
        const pOut = (outRow + x) * 4;
        out[pOut] = gray;
        out[pOut + 1] = gray;
        out[pOut + 2] = gray;
        out[pOut + 3] = 255;
      }
    }
  } else {
    for (let y = 0; y < sourceHeightPx; y += 1) {
      const srcRow = y * sourceWidthPx;
      const outRow = y * outputWidthPx;
      for (let x = 0; x < outputWidthPx; x += 1) {
        const sx = Math.min(sourceWidthPx - 1, x);
        const gray = sourceRgba[(srcRow + sx) * 4];
        const pOut = (outRow + x) * 4;
        out[pOut] = gray;
        out[pOut + 1] = gray;
        out[pOut + 2] = gray;
        out[pOut + 3] = 255;
      }
    }
  }

  outCtx.putImageData(outImage, 0, 0);
  return canvasToPngBlob(outCanvas);
}

async function canvasToPngBlob(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<Blob> {
  if ('convertToBlob' in canvas && typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type: 'image/png' });
  }

  const htmlCanvas = canvas as HTMLCanvasElement;
  return new Promise<Blob>((resolve, reject) => {
    htmlCanvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Failed to encode layer image to PNG.'));
        return;
      }
      resolve(blob);
    }, 'image/png');
  });
}

function buildTriangles(
  models: LoadedModel[],
  settings: EffectiveSettings,
  printer: PrinterProfile,
): RasterTriangle[] {
  const widthMm = Math.max(1, printer.buildVolumeMm.width);
  const depthMm = Math.max(1, printer.buildVolumeMm.depth);
  const minX = -widthMm * 0.5;
  const minY = -depthMm * 0.5;

  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();

  const triangles: RasterTriangle[] = [];

  for (const model of models) {
    const matrix = composeModelMatrix(model.transform);
    const center = model.geometry.center;
    const geometry = model.geometry.geometry;
    const position = geometry.getAttribute('position');
    const index = geometry.getIndex();

    if (!position) continue;

    const readVertex = (vertexIndex: number, target: THREE.Vector3) => {
      target.set(
        position.getX(vertexIndex) - center.x,
        position.getY(vertexIndex) - center.y,
        position.getZ(vertexIndex) - center.z,
      );
      target.applyMatrix4(matrix);
      return target;
    };

    if (index) {
      const idx = index.array;
      for (let i = 0; i < idx.length; i += 3) {
        const a = Number(idx[i]);
        const b = Number(idx[i + 1]);
        const c = Number(idx[i + 2]);

        readVertex(a, v0);
        readVertex(b, v1);
        readVertex(c, v2);

        const zMin = Math.min(v0.z, v1.z, v2.z);
        const zMax = Math.max(v0.z, v1.z, v2.z);

        triangles.push({
          zMin,
          zMax,
          x1: toPixelX(v0.x, minX, widthMm, settings.widthPx),
          y1: toPixelY(v0.y, minY, depthMm, settings.heightPx),
          x2: toPixelX(v1.x, minX, widthMm, settings.widthPx),
          y2: toPixelY(v1.y, minY, depthMm, settings.heightPx),
          x3: toPixelX(v2.x, minX, widthMm, settings.widthPx),
          y3: toPixelY(v2.y, minY, depthMm, settings.heightPx),
        });
      }
    } else {
      const count = position.count;
      for (let i = 0; i < count; i += 3) {
        readVertex(i, v0);
        readVertex(i + 1, v1);
        readVertex(i + 2, v2);

        const zMin = Math.min(v0.z, v1.z, v2.z);
        const zMax = Math.max(v0.z, v1.z, v2.z);

        triangles.push({
          zMin,
          zMax,
          x1: toPixelX(v0.x, minX, widthMm, settings.widthPx),
          y1: toPixelY(v0.y, minY, depthMm, settings.heightPx),
          x2: toPixelX(v1.x, minX, widthMm, settings.widthPx),
          y2: toPixelY(v1.y, minY, depthMm, settings.heightPx),
          x3: toPixelX(v2.x, minX, widthMm, settings.widthPx),
          y3: toPixelY(v2.y, minY, depthMm, settings.heightPx),
        });
      }
    }
  }

  return triangles;
}

function buildWorldTriangles(models: LoadedModel[]): WorldTriangle[] {
  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();

  const triangles: WorldTriangle[] = [];

  for (const model of models) {
    const matrix = composeModelMatrix(model.transform);
    const center = model.geometry.center;
    const geometry = model.geometry.geometry;
    const position = geometry.getAttribute('position');
    const index = geometry.getIndex();

    if (!position) continue;

    const readVertex = (vertexIndex: number, target: THREE.Vector3) => {
      target.set(
        position.getX(vertexIndex) - center.x,
        position.getY(vertexIndex) - center.y,
        position.getZ(vertexIndex) - center.z,
      );
      target.applyMatrix4(matrix);
      return target;
    };

    if (index) {
      const idx = index.array;
      for (let i = 0; i < idx.length; i += 3) {
        const a = Number(idx[i]);
        const b = Number(idx[i + 1]);
        const c = Number(idx[i + 2]);

        readVertex(a, v0);
        readVertex(b, v1);
        readVertex(c, v2);

        const zMin = Math.min(v0.z, v1.z, v2.z);
        const zMax = Math.max(v0.z, v1.z, v2.z);

        triangles.push({
          ax: v0.x,
          ay: v0.y,
          az: v0.z,
          bx: v1.x,
          by: v1.y,
          bz: v1.z,
          cx: v2.x,
          cy: v2.y,
          cz: v2.z,
          zMin,
          zMax,
        });
      }
    } else {
      const count = position.count;
      for (let i = 0; i < count; i += 3) {
        readVertex(i, v0);
        readVertex(i + 1, v1);
        readVertex(i + 2, v2);

        const zMin = Math.min(v0.z, v1.z, v2.z);
        const zMax = Math.max(v0.z, v1.z, v2.z);

        triangles.push({
          ax: v0.x,
          ay: v0.y,
          az: v0.z,
          bx: v1.x,
          by: v1.y,
          bz: v1.z,
          cx: v2.x,
          cy: v2.y,
          cz: v2.z,
          zMin,
          zMax,
        });
      }
    }
  }

  return triangles;
}

function layerRangeForTriangle(tri: WorldTriangle, layerHeightMm: number, totalLayers: number): [number, number] | null {
  if (totalLayers <= 0 || layerHeightMm <= 0) return null;

  const last = totalLayers - 1;
  const start = Math.ceil((tri.zMin / layerHeightMm) - 0.5);
  const end = Math.floor((tri.zMax / layerHeightMm) - 0.5);

  if (end < 0 || start > last) return null;

  const clampedStart = Math.max(0, Math.min(last, start));
  const clampedEnd = Math.max(0, Math.min(last, end));
  if (clampedEnd < clampedStart) return null;
  return [clampedStart, clampedEnd];
}

function buildLayerWorldTriangleBuckets(
  triangles: WorldTriangle[],
  totalLayers: number,
  layerHeightMm: number,
): number[][] {
  const buckets: number[][] = Array.from({ length: totalLayers }, () => []);

  for (let triIndex = 0; triIndex < triangles.length; triIndex += 1) {
    const tri = triangles[triIndex];
    const range = layerRangeForTriangle(tri, layerHeightMm, totalLayers);
    if (!range) continue;

    const [start, end] = range;
    for (let layer = start; layer <= end; layer += 1) {
      buckets[layer].push(triIndex);
    }
  }

  return buckets;
}

function edgePlaneIntersectionXY(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  z: number,
): [number, number] | null {
  const dz1 = az - z;
  const dz2 = bz - z;
  const crosses = (dz1 <= 0 && dz2 > 0) || (dz2 <= 0 && dz1 > 0);
  if (!crosses) return null;

  const denom = bz - az;
  if (Math.abs(denom) < 1e-8) return null;

  const t = (z - az) / denom;
  return [ax + (bx - ax) * t, ay + (by - ay) * t];
}

function pushDistinctPoint(points: Array<[number, number]>, point: [number, number]): void {
  const eps = 1e-5;
  for (let i = 0; i < points.length; i += 1) {
    if (Math.abs(points[i][0] - point[0]) <= eps && Math.abs(points[i][1] - point[1]) <= eps) {
      return;
    }
  }
  points.push(point);
}

function buildLayerSegmentsFromWorldTriangles(
  triangles: WorldTriangle[],
  triangleIndices: number[],
  zMm: number,
  settings: EffectiveSettings,
  printer: PrinterProfile,
): SliceSegment2D[] {
  const widthMm = Math.max(1, printer.buildVolumeMm.width);
  const depthMm = Math.max(1, printer.buildVolumeMm.depth);
  const minX = -widthMm * 0.5;
  const minY = -depthMm * 0.5;

  const segments: SliceSegment2D[] = [];

  for (let i = 0; i < triangleIndices.length; i += 1) {
    const tri = triangles[triangleIndices[i]];
    if (zMm < tri.zMin || zMm > tri.zMax) continue;

    const points: Array<[number, number]> = [];
    const p01 = edgePlaneIntersectionXY(tri.ax, tri.ay, tri.az, tri.bx, tri.by, tri.bz, zMm);
    if (p01) pushDistinctPoint(points, p01);

    const p12 = edgePlaneIntersectionXY(tri.bx, tri.by, tri.bz, tri.cx, tri.cy, tri.cz, zMm);
    if (p12) pushDistinctPoint(points, p12);

    const p20 = edgePlaneIntersectionXY(tri.cx, tri.cy, tri.cz, tri.ax, tri.ay, tri.az, zMm);
    if (p20) pushDistinctPoint(points, p20);

    if (points.length < 2) continue;

    const x1 = toPixelX(points[0][0], minX, widthMm, settings.widthPx);
    const y1 = toPixelY(points[0][1], minY, depthMm, settings.heightPx);
    const x2 = toPixelX(points[1][0], minX, widthMm, settings.widthPx);
    const y2 = toPixelY(points[1][1], minY, depthMm, settings.heightPx);

    const dy = y2 - y1;
    if (Math.abs(dy) < 1e-8) continue;

    segments.push({
      x1,
      y1,
      dxDy: (x2 - x1) / dy,
      yMin: Math.min(y1, y2),
      yMax: Math.max(y1, y2),
    });
  }

  return segments;
}

function buildRowSegmentBuckets(heightPx: number, segments: SliceSegment2D[]): number[][] {
  const rowBuckets: number[][] = Array.from({ length: heightPx }, () => []);

  for (let segIndex = 0; segIndex < segments.length; segIndex += 1) {
    const seg = segments[segIndex];
    const rowStart = Math.ceil(seg.yMin - 0.5);
    const rowEnd = Math.floor(seg.yMax - 0.5);

    if (rowEnd < 0 || rowStart >= heightPx) continue;

    const start = Math.max(0, Math.min(heightPx - 1, rowStart));
    const end = Math.max(0, Math.min(heightPx - 1, rowEnd));
    for (let row = start; row <= end; row += 1) {
      rowBuckets[row].push(segIndex);
    }
  }

  return rowBuckets;
}

function rasterizeSolidSegmentsToImage(
  widthPx: number,
  heightPx: number,
  segments: SliceSegment2D[],
  imageData: ImageData,
  baseOpaqueBlack: Uint8ClampedArray,
): void {
  const data = imageData.data;
  data.set(baseOpaqueBlack);

  const rowBuckets = buildRowSegmentBuckets(heightPx, segments);
  const intersections: number[] = [];

  for (let y = 0; y < heightPx; y += 1) {
    intersections.length = 0;
    const ySample = y + 0.5;

    const rowSegs = rowBuckets[y];
    for (let i = 0; i < rowSegs.length; i += 1) {
      const seg = segments[rowSegs[i]];
      intersections.push(seg.x1 + (ySample - seg.y1) * seg.dxDy);
    }

    if (intersections.length === 0) continue;
    intersections.sort((a, b) => a - b);

    let p = 0;
    while (p + 1 < intersections.length) {
      const xStart = Math.ceil(Math.max(0, Math.min(intersections[p], intersections[p + 1])));
      const xEnd = Math.floor(Math.min(widthPx - 1, Math.max(intersections[p], intersections[p + 1])));

      if (xEnd >= xStart) {
        let pixelIndex = (y * widthPx + xStart) * 4;
        for (let x = xStart; x <= xEnd; x += 1) {
          data[pixelIndex] = 255;
          data[pixelIndex + 1] = 255;
          data[pixelIndex + 2] = 255;
          pixelIndex += 4;
        }
      }

      p += 2;
    }
  }
}

function resolveEffectiveSettings(options: RasterLayerZipExportOptions): EffectiveSettings {
  const sourceResolutionX = Math.max(1, Math.round(options.printerProfile.display.resolutionX));
  const sourceResolutionY = Math.max(1, Math.round(options.printerProfile.display.resolutionY));

  const outputFormat = options.printerProfile.display.outputFormat;
  const packed = outputFormat === '.nanodlp'
    ? resolveNanodlpPackedWidth(options.printerProfile)
    : {
      widthPx: sourceResolutionX,
      sourceResolutionX,
      sourceResolutionY,
      xPackingMode: 'none' as const,
    };

  let widthPx = packed.widthPx;
  let heightPx = packed.sourceResolutionY;

  const pixelCount = widthPx * heightPx;
  if (pixelCount > MAX_CANVAS_PIXELS && outputFormat !== '.nanodlp') {
    const scale = Math.sqrt(MAX_CANVAS_PIXELS / pixelCount);
    widthPx = Math.max(1, Math.floor(widthPx * scale));
    heightPx = Math.max(1, Math.floor(heightPx * scale));
  }

  const layerHeightMm = Math.max(0.001, Number(options.materialProfile.layerHeightMm) || 0.05);

  return {
    widthPx,
    heightPx,
    sourceResolutionX: packed.sourceResolutionX,
    sourceResolutionY: packed.sourceResolutionY,
    xPackingMode: packed.xPackingMode,
    layerHeightMm,
    totalLayers: 1,
    tallestObjectHeightMm: layerHeightMm,
  };
}

async function rasterizeLayerStack(options: RasterLayerZipExportOptions): Promise<RasterizationResult> {
  throwIfAborted(options.abortSignal);
  const visibleModels = options.models.filter((model) => model.visible);
  if (visibleModels.length === 0) {
    throw new Error('No visible models available for slicing.');
  }

  const settings = resolveEffectiveSettings(options);
  const triangles = buildWorldTriangles(visibleModels);
  if (triangles.length === 0) {
    throw new Error('Unable to prepare world-space triangles from visible models.');
  }

  let maxZ = 0;
  for (let i = 0; i < triangles.length; i += 1) {
    maxZ = Math.max(maxZ, triangles[i].zMax);
  }

  const buildHeight = Math.max(0, maxZ);
  const maxBuildHeight = Math.max(0, Number(options.printerProfile.buildVolumeMm.height) || 0);
  const tallestObjectHeightMm = Math.min(buildHeight, maxBuildHeight);
  const totalLayers = Math.max(1, Math.ceil(tallestObjectHeightMm / settings.layerHeightMm));

  const rasterWidthPx = settings.sourceResolutionX;
  const rasterHeightPx = settings.sourceResolutionY;

  const canvas = getCanvas(rasterWidthPx, rasterHeightPx);
  const ctx = canvas.getContext('2d', { willReadFrequently: false }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) {
    throw new Error('Failed to create 2D rendering context for slicing.');
  }

  const layerTriangleBuckets = buildLayerWorldTriangleBuckets(triangles, totalLayers, settings.layerHeightMm);
  let emptyLayerPngBlob: Blob | null = null;
  let previousLayerTriangleIndices: number[] | null = null;
  let previousLayerPngBlob: Blob | null = null;
  const baseOpaqueBlack = new Uint8ClampedArray(rasterWidthPx * rasterHeightPx * 4);
  for (let i = 3; i < baseOpaqueBlack.length; i += 4) {
    baseOpaqueBlack[i] = 255;
  }
  const reusableImageData = new ImageData(rasterWidthPx, rasterHeightPx);
  reusableImageData.data.set(baseOpaqueBlack);
  ctx.putImageData(reusableImageData, 0, 0);
  const layerEntries: RasterizedLayerEntry[] = [];

  for (let layerIndex = 0; layerIndex < totalLayers; layerIndex += 1) {
    throwIfAborted(options.abortSignal);
    const zStart = layerIndex * settings.layerHeightMm;
    const zSample = (layerIndex + 0.5) * settings.layerHeightMm;

    const activeTriangleIndices = layerTriangleBuckets[layerIndex];
    let pngBlob: Blob;

    if (activeTriangleIndices.length === 0) {
      if (!emptyLayerPngBlob) {
        reusableImageData.data.set(baseOpaqueBlack);
        ctx.putImageData(reusableImageData, 0, 0);
        if (settings.xPackingMode === 'none') {
          emptyLayerPngBlob = await canvasToPngBlob(canvas);
        } else {
          emptyLayerPngBlob = await nanodlpPackRgbaToPngBlob(
            reusableImageData.data,
            rasterWidthPx,
            rasterHeightPx,
            settings.widthPx,
            settings.xPackingMode,
          );
        }
      }
      pngBlob = emptyLayerPngBlob;
    } else if (sameIndexSet(previousLayerTriangleIndices, activeTriangleIndices) && previousLayerPngBlob) {
      pngBlob = previousLayerPngBlob;
    } else {
      const segments = buildLayerSegmentsFromWorldTriangles(
        triangles,
        activeTriangleIndices,
        zSample,
          {
            ...settings,
            widthPx: rasterWidthPx,
            heightPx: rasterHeightPx,
          },
        options.printerProfile,
      );

      if (segments.length === 0) {
        if (!emptyLayerPngBlob) {
          reusableImageData.data.set(baseOpaqueBlack);
          ctx.putImageData(reusableImageData, 0, 0);
          if (settings.xPackingMode === 'none') {
            emptyLayerPngBlob = await canvasToPngBlob(canvas);
          } else {
            emptyLayerPngBlob = await nanodlpPackRgbaToPngBlob(
              reusableImageData.data,
              rasterWidthPx,
              rasterHeightPx,
              settings.widthPx,
              settings.xPackingMode,
            );
          }
        }
        pngBlob = emptyLayerPngBlob;
      } else {
        rasterizeSolidSegmentsToImage(
          rasterWidthPx,
          rasterHeightPx,
          segments,
          reusableImageData,
          baseOpaqueBlack,
        );
        if (settings.xPackingMode === 'none') {
          ctx.putImageData(reusableImageData, 0, 0);
          pngBlob = await canvasToPngBlob(canvas);
        } else {
          pngBlob = await nanodlpPackRgbaToPngBlob(
            reusableImageData.data,
            rasterWidthPx,
            rasterHeightPx,
            settings.widthPx,
            settings.xPackingMode,
          );
        }
      }
    }

    previousLayerTriangleIndices = activeTriangleIndices;
    previousLayerPngBlob = pngBlob;

    const layerUm = Math.round(zStart * 1000);
    const layerName = `layer_${String(layerIndex).padStart(5, '0')}_z_${String(layerUm).padStart(6, '0')}um.png`;
    layerEntries.push({ name: layerName, blob: pngBlob });

    if (shouldEmitProgress(layerIndex, totalLayers)) {
      options.onProgress?.(layerIndex + 1, totalLayers, 'Rasterizing layers');
    }

    if (layerIndex % 16 === 15) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      throwIfAborted(options.abortSignal);
    }
  }

  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    mode: 'raster_layer_zip_solid_v1',
    notes: [
      'JS fallback generates solid cross-sections via plane intersections and scanline fill.',
      'Used when WASM .nanodlp path is unavailable or fails.',
    ],
    printer: {
      id: options.printerProfile.id,
      name: options.printerProfile.name,
      resolutionX: options.printerProfile.display.resolutionX,
      resolutionY: options.printerProfile.display.resolutionY,
      buildVolumeMm: options.printerProfile.buildVolumeMm,
      bitDepth: options.printerProfile.bitDepth,
      outputFormat: options.printerProfile.display.outputFormat,
    },
    material: {
      id: options.materialProfile.id,
      name: options.materialProfile.name,
      layerHeightMm: options.materialProfile.layerHeightMm,
      normalExposureSec: options.materialProfile.normalExposureSec,
      bottomExposureSec: options.materialProfile.bottomExposureSec,
      bottomLayerCount: options.materialProfile.bottomLayerCount,
    },
    effective: {
      widthPx: settings.widthPx,
      heightPx: settings.heightPx,
      sourceResolutionX: settings.sourceResolutionX,
      sourceResolutionY: settings.sourceResolutionY,
      xPackingMode: settings.xPackingMode,
      layerHeightMm: settings.layerHeightMm,
      totalLayers,
      tallestObjectHeightMm,
    },
    models: visibleModels.map((model) => ({
      id: model.id,
      name: model.name,
      polygonCount: model.polygonCount,
      transform: {
        position: { x: model.transform.position.x, y: model.transform.position.y, z: model.transform.position.z },
        rotation: { x: model.transform.rotation.x, y: model.transform.rotation.y, z: model.transform.rotation.z },
        scale: { x: model.transform.scale.x, y: model.transform.scale.y, z: model.transform.scale.z },
      },
    })),
  };

  return {
    settings,
    totalLayers,
    tallestObjectHeightMm,
    visibleModels,
    layerEntries,
    manifest,
  };
}

export async function rasterizeLayersForWasm(options: RasterLayerZipExportOptions): Promise<RasterizedLayerStackForWasm> {
  const rasterized = await rasterizeLayerStack(options);
  const layerPngs: Uint8Array[] = [];

  for (let i = 0; i < rasterized.layerEntries.length; i += 1) {
    const bytes = new Uint8Array(await rasterized.layerEntries[i].blob.arrayBuffer());
    layerPngs.push(bytes);
  }

  return {
    widthPx: rasterized.settings.widthPx,
    heightPx: rasterized.settings.heightPx,
    layerHeightMm: rasterized.settings.layerHeightMm,
    totalLayers: rasterized.totalLayers,
    tallestObjectHeightMm: rasterized.tallestObjectHeightMm,
    layerPngs,
    metadataJson: JSON.stringify(rasterized.manifest),
  };
}

export function buildSolidSliceMeshForWasm(options: RasterLayerZipExportOptions): SolidSliceMeshForWasm {
  const visibleModels = options.models.filter((model) => model.visible);
  if (visibleModels.length === 0) {
    throw new Error('No visible models available for slicing.');
  }

  const settings = resolveEffectiveSettings(options);
  const worldTriangles = buildWorldTriangles(visibleModels);
  if (worldTriangles.length === 0) {
    throw new Error('Unable to prepare world-space triangles from visible models.');
  }

  let maxZ = 0;
  for (let i = 0; i < worldTriangles.length; i += 1) {
    maxZ = Math.max(maxZ, worldTriangles[i].zMax);
  }

  const buildHeight = Math.max(0, maxZ);
  const maxBuildHeight = Math.max(0, Number(options.printerProfile.buildVolumeMm.height) || 0);
  const tallestObjectHeightMm = Math.min(buildHeight, maxBuildHeight);
  const totalLayers = Math.max(1, Math.ceil(tallestObjectHeightMm / settings.layerHeightMm));

  const trianglesXYZ = new Float32Array(worldTriangles.length * 9);
  for (let i = 0; i < worldTriangles.length; i += 1) {
    const tri = worldTriangles[i];
    const base = i * 9;
    trianglesXYZ[base] = tri.ax;
    trianglesXYZ[base + 1] = tri.ay;
    trianglesXYZ[base + 2] = tri.az;
    trianglesXYZ[base + 3] = tri.bx;
    trianglesXYZ[base + 4] = tri.by;
    trianglesXYZ[base + 5] = tri.bz;
    trianglesXYZ[base + 6] = tri.cx;
    trianglesXYZ[base + 7] = tri.cy;
    trianglesXYZ[base + 8] = tri.cz;
  }

  const manifest = {
    version: 2,
    createdAt: new Date().toISOString(),
    mode: 'wasm_solid_slice_v0',
    notes: [
      'Solid cross-sections are generated in Rust/WASM from transformed triangle meshes.',
      'Container packaging is encoded by plugin-owned format encoders.',
    ],
    printer: {
      id: options.printerProfile.id,
      name: options.printerProfile.name,
      resolutionX: options.printerProfile.display.resolutionX,
      resolutionY: options.printerProfile.display.resolutionY,
      buildVolumeMm: options.printerProfile.buildVolumeMm,
      bitDepth: options.printerProfile.bitDepth,
      outputFormat: options.printerProfile.display.outputFormat,
    },
    material: {
      id: options.materialProfile.id,
      name: options.materialProfile.name,
      layerHeightMm: options.materialProfile.layerHeightMm,
      normalExposureSec: options.materialProfile.normalExposureSec,
      bottomExposureSec: options.materialProfile.bottomExposureSec,
      bottomLayerCount: options.materialProfile.bottomLayerCount,
    },
    effective: {
      widthPx: settings.widthPx,
      heightPx: settings.heightPx,
      sourceResolutionX: settings.sourceResolutionX,
      sourceResolutionY: settings.sourceResolutionY,
      xPackingMode: settings.xPackingMode,
      layerHeightMm: settings.layerHeightMm,
      totalLayers,
      tallestObjectHeightMm,
    },
    models: visibleModels.map((model) => ({
      id: model.id,
      name: model.name,
      polygonCount: model.polygonCount,
      transform: {
        position: { x: model.transform.position.x, y: model.transform.position.y, z: model.transform.position.z },
        rotation: { x: model.transform.rotation.x, y: model.transform.rotation.y, z: model.transform.rotation.z },
        scale: { x: model.transform.scale.x, y: model.transform.scale.y, z: model.transform.scale.z },
      },
    })),
  };

  return {
    sourceWidthPx: settings.sourceResolutionX,
    sourceHeightPx: settings.sourceResolutionY,
    widthPx: settings.widthPx,
    heightPx: settings.heightPx,
    xPackingMode: settings.xPackingMode,
    buildWidthMm: Math.max(1, options.printerProfile.buildVolumeMm.width),
    buildDepthMm: Math.max(1, options.printerProfile.buildVolumeMm.depth),
    layerHeightMm: settings.layerHeightMm,
    totalLayers,
    tallestObjectHeightMm,
    trianglesXYZ,
    metadataJson: JSON.stringify(manifest),
  };
}

export async function exportRasterLayerZip(options: RasterLayerZipExportOptions): Promise<RasterLayerZipArtifact> {
  throwIfAborted(options.abortSignal);
  const rasterized = await rasterizeLayerStack(options);

  const zip = new JSZip();
  const zipFolder = zip.folder('layers');
  if (!zipFolder) {
    throw new Error('Failed to initialize layers folder in ZIP.');
  }

  for (let i = 0; i < rasterized.layerEntries.length; i += 1) {
    throwIfAborted(options.abortSignal);
    const layer = rasterized.layerEntries[i];
    zipFolder.file(layer.name, layer.blob);
  }

  zip.file('manifest.json', JSON.stringify(rasterized.manifest, null, 2));

  options.onProgress?.(rasterized.totalLayers, rasterized.totalLayers, 'Compressing ZIP');
  throwIfAborted(options.abortSignal);

  const outputBlob = await zip.generateAsync({
    type: 'blob',
    compression: 'STORE',
  });

  throwIfAborted(options.abortSignal);

  const outputName = `${safeFilenameBase(options.filenameBase)}_layers.zip`;
  if (options.outputMode !== 'return') {
    triggerBlobDownload(outputBlob, outputName);
  }

  return {
    blob: outputBlob,
    outputName,
    totalLayers: rasterized.totalLayers,
  };
}
