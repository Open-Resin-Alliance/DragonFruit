import type { MaterialProfile, PrinterProfile } from '@/features/profiles/profileStore';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { buildSolidSliceMeshForWasm } from './rasterLayerZipExport';
import { resolveSlicingFormatDefinition } from './formats/registry';
import { isNativeSlicerAvailable, sliceSolidAndEncodeWithNativeSlicer } from './tauri/nativeSlicerBridge';

const DEBUG_PREFIX = '[SlicingDebug]';

function logDebug(...args: unknown[]): void {
  if (typeof console === 'undefined' || typeof console.debug !== 'function') return;
  console.debug(DEBUG_PREFIX, ...args);
}

export type SliceExportOrchestratorOptions = {
  models: LoadedModel[];
  printerProfile: PrinterProfile;
  materialProfile: MaterialProfile;
  filenameBase: string;
  antiAliasingLevel?: 'Off' | '2x' | '4x' | '8x';
  aaOnSupports?: boolean;
  outputMode?: 'download' | 'return';
  exportThumbnailPng?: Uint8Array | null;
  abortSignal?: AbortSignal;
  onProgress?: (done: number, total: number, phase: string) => void;
  onLayerPreview?: (layerIndex: number, totalLayers: number, pngBytes: Uint8Array) => void;
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

export type SliceExportArtifact = {
  blob: Blob;
  outputName: string;
  mimeType: string;
  byteSize: number;
};

export type SliceExportResult = {
  backend: 'native-rust-tauri';
  outputFormat: string;
  nativeAvailable: boolean;
  nativeError: string | null;
  artifact: SliceExportArtifact | null;
  benchmark: {
    totalElapsedMs: number;
    meshPrepMs: number | null;
    coreSlicingMs: number | null;
    totalLayers: number | null;
    layersPerSecond: number | null;
  };
};

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

function triggerByteDownload(bytes: Uint8Array, filename: string, mimeType = 'application/octet-stream'): void {
  const normalized = Uint8Array.from(bytes);
  const blob = new Blob([normalized], { type: mimeType });
  triggerBlobDownload(blob, filename);
}

/**
 * Orchestrates export via DragonFruit Desktop native slicer.
 */
export async function runSliceExportOrchestrator(options: SliceExportOrchestratorOptions): Promise<SliceExportResult> {
  throwIfAborted(options.abortSignal);
  const orchestratorStartMs = performance.now();
  const format = resolveSlicingFormatDefinition({
    printerProfile: options.printerProfile,
    materialProfile: options.materialProfile,
  });

  logDebug('Export orchestrator start', {
    format: format.outputFormat,
    displayName: format.displayName,
    printer: options.printerProfile.name,
    material: options.materialProfile.name,
    modelCount: options.models.length,
  });

  throwIfAborted(options.abortSignal);
  const nativeAvailable = await isNativeSlicerAvailable();
  if (!nativeAvailable) {
    throw new Error('Native slicer requires DragonFruit Desktop (Tauri). JS/WebGPU slicing has been removed.');
  }

  options.onProgress?.(0, 1, `Preparing solid mesh · ${format.displayName}`);
  const meshPrepStartMs = performance.now();
  const solidMesh = buildSolidSliceMeshForWasm({
    models: options.models,
    printerProfile: options.printerProfile,
    materialProfile: options.materialProfile,
    filenameBase: options.filenameBase,
  });
  const meshPrepMs = performance.now() - meshPrepStartMs;

  logDebug('Solid mesh prepared for native backend', {
    source: `${solidMesh.sourceWidthPx}x${solidMesh.sourceHeightPx}`,
    output: `${solidMesh.widthPx}x${solidMesh.heightPx}`,
    packingMode: solidMesh.xPackingMode,
    totalLayers: solidMesh.totalLayers,
    meshPrepMs,
  });

  options.onProgress?.(
    0,
    solidMesh.totalLayers,
    `Native Rust slicing (${format.displayName}) · mode=${solidMesh.xPackingMode} · ${solidMesh.widthPx}x${solidMesh.heightPx}`,
  );

  const nativeJob = {
    outputFormat: format.outputFormat,
    sourceWidthPx: solidMesh.sourceWidthPx,
    sourceHeightPx: solidMesh.sourceHeightPx,
    widthPx: solidMesh.widthPx,
    heightPx: solidMesh.heightPx,
    xPackingMode: solidMesh.xPackingMode,
    pngCompressionStrategy: solidMesh.pngCompressionStrategy,
    bvhAccelerationEnabled: solidMesh.bvhAccelerationEnabled,
    antiAliasingLevel: options.antiAliasingLevel ?? 'Off',
    aaOnSupports: options.aaOnSupports ?? false,
    modelTriangleCount: solidMesh.modelTriangleCount,
    buildWidthMm: solidMesh.buildWidthMm,
    buildDepthMm: solidMesh.buildDepthMm,
    layerHeightMm: solidMesh.layerHeightMm,
    totalLayers: solidMesh.totalLayers,
    trianglesXYZ: solidMesh.trianglesXYZ,
    metadataJson: solidMesh.metadataJson,
  };

  const coreStartMs = performance.now();
  const encodedBytes = await sliceSolidAndEncodeWithNativeSlicer(nativeJob);
  const coreSlicingMs = performance.now() - coreStartMs;

  throwIfAborted(options.abortSignal);
  options.onProgress?.(solidMesh.totalLayers, solidMesh.totalLayers, 'Native slicing finished');

  const outputExt = format.outputFormat.replace(/^\./, '') || 'slice';
  const outputName = `${safeFilenameBase(options.filenameBase)}.${outputExt}`;
  const artifactBlob = new Blob([Uint8Array.from(encodedBytes)], { type: 'application/octet-stream' });
  if (options.outputMode !== 'return') {
    triggerByteDownload(encodedBytes, outputName);
  }

  const totalElapsedMs = performance.now() - orchestratorStartMs;
  const layersPerSecond = totalElapsedMs > 0
    ? (solidMesh.totalLayers * 1000) / totalElapsedMs
    : null;

  return {
    backend: 'native-rust-tauri',
    outputFormat: format.outputFormat,
    nativeAvailable,
    nativeError: null,
    artifact: {
      blob: artifactBlob,
      outputName,
      mimeType: 'application/octet-stream',
      byteSize: artifactBlob.size,
    },
    benchmark: {
      totalElapsedMs,
      meshPrepMs,
      coreSlicingMs,
      totalLayers: solidMesh.totalLayers,
      layersPerSecond,
    },
  };
}
