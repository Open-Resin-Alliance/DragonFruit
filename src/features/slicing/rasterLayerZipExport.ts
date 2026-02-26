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
  onProgress?: (done: number, total: number, phase: string) => void;
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

type EffectiveSettings = {
  widthPx: number;
  heightPx: number;
  layerHeightMm: number;
  totalLayers: number;
  tallestObjectHeightMm: number;
};

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

function resolveEffectiveSettings(options: RasterLayerZipExportOptions): EffectiveSettings {
  const baseWidth = Math.max(1, Math.round(options.printerProfile.display.resolutionX));
  const baseHeight = Math.max(1, Math.round(options.printerProfile.display.resolutionY));

  let widthPx = baseWidth;
  let heightPx = baseHeight;

  const pixelCount = widthPx * heightPx;
  if (pixelCount > MAX_CANVAS_PIXELS) {
    const scale = Math.sqrt(MAX_CANVAS_PIXELS / pixelCount);
    widthPx = Math.max(1, Math.floor(widthPx * scale));
    heightPx = Math.max(1, Math.floor(heightPx * scale));
  }

  const layerHeightMm = Math.max(0.001, Number(options.materialProfile.layerHeightMm) || 0.05);

  return {
    widthPx,
    heightPx,
    layerHeightMm,
    totalLayers: 1,
    tallestObjectHeightMm: layerHeightMm,
  };
}

async function rasterizeLayerStack(options: RasterLayerZipExportOptions): Promise<RasterizationResult> {
  const visibleModels = options.models.filter((model) => model.visible);
  if (visibleModels.length === 0) {
    throw new Error('No visible models available for slicing.');
  }

  const settings = resolveEffectiveSettings(options);
  const triangles = buildTriangles(visibleModels, settings, options.printerProfile);
  if (triangles.length === 0) {
    throw new Error('Unable to prepare slice triangles from visible models.');
  }

  let maxZ = 0;
  for (let i = 0; i < triangles.length; i += 1) {
    maxZ = Math.max(maxZ, triangles[i].zMax);
  }

  const buildHeight = Math.max(0, maxZ);
  const maxBuildHeight = Math.max(0, Number(options.printerProfile.buildVolumeMm.height) || 0);
  const tallestObjectHeightMm = Math.min(buildHeight, maxBuildHeight);
  const totalLayers = Math.max(1, Math.ceil(tallestObjectHeightMm / settings.layerHeightMm));

  const canvas = getCanvas(settings.widthPx, settings.heightPx);
  const ctx = canvas.getContext('2d', { willReadFrequently: false }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) {
    throw new Error('Failed to create 2D rendering context for slicing.');
  }

  const layerTriangleBuckets = buildLayerTriangleBuckets(triangles, totalLayers, settings.layerHeightMm);
  let emptyLayerPngBlob: Blob | null = null;
  let previousLayerTriangleIndices: number[] | null = null;
  let previousLayerPngBlob: Blob | null = null;
  const layerEntries: RasterizedLayerEntry[] = [];

  for (let layerIndex = 0; layerIndex < totalLayers; layerIndex += 1) {
    const zStart = layerIndex * settings.layerHeightMm;

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, settings.widthPx, settings.heightPx);

    const activeTriangleIndices = layerTriangleBuckets[layerIndex];
    let pngBlob: Blob;

    if (activeTriangleIndices.length === 0) {
      if (!emptyLayerPngBlob) {
        emptyLayerPngBlob = await canvasToPngBlob(canvas);
      }
      pngBlob = emptyLayerPngBlob;
    } else if (sameIndexSet(previousLayerTriangleIndices, activeTriangleIndices) && previousLayerPngBlob) {
      pngBlob = previousLayerPngBlob;
    } else {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();

      for (let i = 0; i < activeTriangleIndices.length; i += 1) {
        const tri = triangles[activeTriangleIndices[i]];
        ctx.moveTo(tri.x1, tri.y1);
        ctx.lineTo(tri.x2, tri.y2);
        ctx.lineTo(tri.x3, tri.y3);
        ctx.closePath();
      }

      ctx.fill('nonzero');
      pngBlob = await canvasToPngBlob(canvas);
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
    }
  }

  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    mode: 'raster_layer_zip_v0',
    notes: [
      'Initial JS slicer prototype before Rust/WASM backend integration.',
      'Per-layer raster currently uses slab-projected triangle fill and is intended for iterative validation.',
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

export async function exportRasterLayerZip(options: RasterLayerZipExportOptions): Promise<void> {
  const rasterized = await rasterizeLayerStack(options);

  const zip = new JSZip();
  const zipFolder = zip.folder('layers');
  if (!zipFolder) {
    throw new Error('Failed to initialize layers folder in ZIP.');
  }

  for (let i = 0; i < rasterized.layerEntries.length; i += 1) {
    const layer = rasterized.layerEntries[i];
    zipFolder.file(layer.name, layer.blob);
  }

  zip.file('manifest.json', JSON.stringify(rasterized.manifest, null, 2));

  options.onProgress?.(rasterized.totalLayers, rasterized.totalLayers, 'Compressing ZIP');

  const outputBlob = await zip.generateAsync({
    type: 'blob',
    compression: 'STORE',
  });

  const outputName = `${safeFilenameBase(options.filenameBase)}_layers.zip`;
  const objectUrl = URL.createObjectURL(outputBlob);
  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = outputName;
    anchor.click();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
