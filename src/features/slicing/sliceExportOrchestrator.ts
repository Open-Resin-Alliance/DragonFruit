import type { MaterialProfile, PrinterProfile } from '@/features/profiles/profileStore';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { buildSolidSliceMeshForWasm } from './rasterLayerZipExport';
import { resolveSlicingFormatDefinition } from './formats/registry';
import {
  isNativeSlicerAvailable,
  sliceSolidAndEncodeWithNativeSlicerToTempPath,
  type NativeSlicerPerfMetrics,
  type NativeSlicerRuntimeMetrics,
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
  antiAliasingLevel?: 'Off' | '2x' | '4x' | '8x' | '16x';
  aaOnSupports?: boolean;
  outputMode?: 'download' | 'return';
  exportThumbnailPng?: Uint8Array | null;
  abortSignal?: AbortSignal;
  onProgress?: (done: number, total: number, phase: string) => void;
  onLayerPreview?: (layerIndex: number, totalLayers: number, pngBytes: Uint8Array) => void;
};

function encodeBytesToBase64(bytes: Uint8Array): string {
  // Chunk to avoid stack/memory pressure on large arrays.
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

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
    jobConfig: {
      outputFormat: string;
      outputDisplayName: string;
      sourceWidthPx: number;
      sourceHeightPx: number;
      widthPx: number;
      heightPx: number;
      xPackingMode: 'none' | 'rgb8_div3' | 'gray3_div2';
      computeBackend: 'auto' | 'cpu' | 'gpu';
      pngCompressionStrategy: 'fastest' | 'balanced' | 'smallest' | 'optimal';
      containerCompressionLevel: number;
      bvhAccelerationEnabled: boolean;
      antiAliasingLevel: 'Off' | '2x' | '4x' | '8x' | '16x';
      aaOnSupports: boolean;
      modelTriangleCount: number;
      triangleFloatCount: number;
      buildWidthMm: number;
      buildDepthMm: number;
      layerHeightMm: number;
      totalLayers: number;
      metadataJsonBytes: number;
      exportThumbnailProvided: boolean;
      exportThumbnailBytes: number;
    };
    nativePerf: {
      perf: NativeSlicerPerfMetrics | null;
      runtime: NativeSlicerRuntimeMetrics | null;
      bridgePayloadBuildMs: number | null;
      bridgeInvokeRoundTripMs: number | null;
      bridgeTotalMs: number | null;
      bridgePayloadChars: number | null;
      triangleFloatCount: number | null;
      meshBytesLen: number | null;
      stageMeshMs: number | null;
      transportOverheadMs: number | null;
      renderWallMs: number | null;
      renderCpuMs: number | null;
      indexBuildMs: number | null;
      pngEncodeCpuMs: number | null;
      archiveEncodeMs: number | null;
      totalMs: number | null;
      renderWallMsPerLayer: number | null;
      renderCpuMsPerLayer: number | null;
      pngCpuMsPerLayer: number | null;
      totalMsPerLayer: number | null;
    };
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

  options.onProgress?.(0, 1, 'Preparing');
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

  options.onProgress?.(0, solidMesh.totalLayers, 'Staging');

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
    mirrorX: solidMesh.mirrorX,
    mirrorY: solidMesh.mirrorY,
    modelTriangleCount: solidMesh.modelTriangleCount,
    containerCompressionLevel: 2,
    buildWidthMm: solidMesh.buildWidthMm,
    buildDepthMm: solidMesh.buildDepthMm,
    layerHeightMm: solidMesh.layerHeightMm,
    totalLayers: solidMesh.totalLayers,
    exportThumbnailPngBase64: options.exportThumbnailPng && options.exportThumbnailPng.length > 0
      ? encodeBytesToBase64(options.exportThumbnailPng)
      : null,
    trianglesXYZ: solidMesh.trianglesXYZ,
    metadataJson: solidMesh.metadataJson,
  };

  const coreStartMs = performance.now();
  logDebug('Native slicing starting…');
  logDebug('Native slicing AA settings', {
    antiAliasingLevel: nativeJob.antiAliasingLevel,
    aaOnSupports: nativeJob.aaOnSupports,
  });

  options.onProgress?.(0, solidMesh.totalLayers, 'Slicing');

  const slicerProgressCallback = (done: number, total: number) => {
    options.onProgress?.(
      done,
      total,
      done >= total ? `Packaging (${nativeJob.pngCompressionStrategy})` : 'Slicing',
    );
  };

  const encodedArtifact = await sliceSolidAndEncodeWithNativeSlicerToTempPath(
    nativeJob,
    options.abortSignal,
    slicerProgressCallback,
  );
  const coreSlicingMs = performance.now() - coreStartMs;
  logDebug('Native slicing completed', { coreSlicingMs });

  throwIfAborted(options.abortSignal);
  options.onProgress?.(solidMesh.totalLayers, solidMesh.totalLayers, 'Finalizing Package');

  const outputExt = format.outputFormat.replace(/^\./, '') || 'slice';
  const outputName = `${safeFilenameBase(options.filenameBase)}.${outputExt}`;

  const totalElapsedMs = performance.now() - orchestratorStartMs;
  options.onProgress?.(solidMesh.totalLayers, solidMesh.totalLayers, 'Handoff');
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
      jobConfig: {
        outputFormat: format.outputFormat,
        outputDisplayName: format.displayName,
        sourceWidthPx: nativeJob.sourceWidthPx,
        sourceHeightPx: nativeJob.sourceHeightPx,
        widthPx: nativeJob.widthPx,
        heightPx: nativeJob.heightPx,
        xPackingMode: nativeJob.xPackingMode,
        computeBackend: nativeJob.computeBackend,
        pngCompressionStrategy: nativeJob.pngCompressionStrategy,
        containerCompressionLevel: nativeJob.containerCompressionLevel,
        bvhAccelerationEnabled: nativeJob.bvhAccelerationEnabled,
        antiAliasingLevel: nativeJob.antiAliasingLevel,
        aaOnSupports: nativeJob.aaOnSupports,
        modelTriangleCount: nativeJob.modelTriangleCount,
        triangleFloatCount: nativeJob.trianglesXYZ.length,
        buildWidthMm: nativeJob.buildWidthMm,
        buildDepthMm: nativeJob.buildDepthMm,
        layerHeightMm: nativeJob.layerHeightMm,
        totalLayers: nativeJob.totalLayers,
        metadataJsonBytes: nativeJob.metadataJson.length,
        exportThumbnailProvided: Boolean(options.exportThumbnailPng && options.exportThumbnailPng.length > 0),
        exportThumbnailBytes: options.exportThumbnailPng?.length ?? 0,
      },
      nativePerf: {
        perf: encodedArtifact.perf,
        runtime: encodedArtifact.runtime,
        bridgePayloadBuildMs: encodedArtifact.bridge?.payloadBuildMs ?? null,
        bridgeInvokeRoundTripMs: encodedArtifact.bridge?.invokeRoundTripMs ?? null,
        bridgeTotalMs: encodedArtifact.bridge?.bridgeTotalMs ?? null,
        bridgePayloadChars: encodedArtifact.bridge?.payloadChars ?? null,
        triangleFloatCount: encodedArtifact.bridge?.triangleFloatCount ?? null,
        meshBytesLen: encodedArtifact.bridge?.meshBytesLen ?? null,
        stageMeshMs: encodedArtifact.bridge?.stageMeshMs ?? null,
        transportOverheadMs: encodedArtifact.perf
          ? Math.max(0, coreSlicingMs - (encodedArtifact.perf.totalNs / 1_000_000))
          : null,
        renderWallMs: encodedArtifact.perf ? (encodedArtifact.perf.renderWallNs / 1_000_000) : null,
        renderCpuMs: encodedArtifact.perf ? (encodedArtifact.perf.renderNs / 1_000_000) : null,
        indexBuildMs: encodedArtifact.perf ? (encodedArtifact.perf.indexBuildNs / 1_000_000) : null,
        pngEncodeCpuMs: encodedArtifact.perf ? (encodedArtifact.perf.pngEncodeNs / 1_000_000) : null,
        archiveEncodeMs: encodedArtifact.perf ? (encodedArtifact.perf.archiveEncodeNs / 1_000_000) : null,
        totalMs: encodedArtifact.perf ? (encodedArtifact.perf.totalNs / 1_000_000) : null,
        renderWallMsPerLayer: encodedArtifact.perf && encodedArtifact.perf.layers > 0
          ? (encodedArtifact.perf.renderWallNs / 1_000_000) / encodedArtifact.perf.layers
          : null,
        renderCpuMsPerLayer: encodedArtifact.perf && encodedArtifact.perf.layers > 0
          ? (encodedArtifact.perf.renderNs / 1_000_000) / encodedArtifact.perf.layers
          : null,
        pngCpuMsPerLayer: encodedArtifact.perf && encodedArtifact.perf.layers > 0
          ? (encodedArtifact.perf.pngEncodeNs / 1_000_000) / encodedArtifact.perf.layers
          : null,
        totalMsPerLayer: encodedArtifact.perf && encodedArtifact.perf.layers > 0
          ? (encodedArtifact.perf.totalNs / 1_000_000) / encodedArtifact.perf.layers
          : null,
      },
    },
  };
}
