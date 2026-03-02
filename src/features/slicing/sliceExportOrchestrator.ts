import type { MaterialProfile, PrinterProfile } from '@/features/profiles/profileStore';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { buildSolidSliceMeshForWasm } from './rasterLayerZipExport';
import { resolveSlicingFormatDefinition } from './formats/registry';
import {
  isNativeSlicerAvailable,
  sliceSolidAndEncodeWithNativeSlicerToTempPath,
} from './tauri/nativeSlicerBridge';

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
  blob: Blob | null;
  outputName: string;
  mimeType: string;
  byteSize: number;
  nativeTempPath: string | null;
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
    computeBackend: solidMesh.computeBackend,
    pngCompressionStrategy: solidMesh.pngCompressionStrategy,
    bvhAccelerationEnabled: solidMesh.bvhAccelerationEnabled,
    antiAliasingLevel: options.antiAliasingLevel ?? 'Off',
    aaOnSupports: options.aaOnSupports ?? false,
    modelTriangleCount: solidMesh.modelTriangleCount,
    containerCompressionLevel: 2,
    buildWidthMm: solidMesh.buildWidthMm,
    buildDepthMm: solidMesh.buildDepthMm,
    layerHeightMm: solidMesh.layerHeightMm,
    totalLayers: solidMesh.totalLayers,
    trianglesXYZ: solidMesh.trianglesXYZ,
    metadataJson: solidMesh.metadataJson,
  };

  const coreStartMs = performance.now();
  logDebug('Native slicing starting…');

  const slicerProgressCallback = (done: number, total: number) => {
    options.onProgress?.(done, total, `Slicing layer ${done}/${total} · ${format.displayName}`);
  };

  const encodedArtifact = await sliceSolidAndEncodeWithNativeSlicerToTempPath(
    nativeJob,
    options.abortSignal,
    slicerProgressCallback,
  );
  const coreSlicingMs = performance.now() - coreStartMs;
  logDebug('Native slicing completed', { coreSlicingMs });

  throwIfAborted(options.abortSignal);
  options.onProgress?.(solidMesh.totalLayers, solidMesh.totalLayers, 'Native slicing finished');

  const outputExt = format.outputFormat.replace(/^\./, '') || 'slice';
  const outputName = `${safeFilenameBase(options.filenameBase)}.${outputExt}`;

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
      blob: null,
      outputName,
      mimeType: 'application/octet-stream',
      byteSize: encodedArtifact.byteLen,
      nativeTempPath: encodedArtifact.tempPath,
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
