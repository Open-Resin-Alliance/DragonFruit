import type { MaterialProfile, PrinterProfile } from '@/features/profiles/profileStore';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { buildSolidSliceMeshForWasm } from './rasterLayerZipExport';
import { resolveOutputFormatVersion, resolveOutputSettingsMode, resolveSlicingFormatDefinition } from './formats/registry';
import { getSavedSlicingPerformanceSettings, type PngCompressionStrategy } from '@/components/settings/performancePreferences';
import {
  isNativeSlicerAvailable,
  sliceSolidAndEncodeWithNativeSlicerToTempPath,
  type AntiAliasingLevel,
  type NativeSlicerPerfMetrics,
  type NativeSlicerRuntimeMetrics,
} from './tauri/nativeSlicerBridge';
import { invoke } from '@tauri-apps/api/core';
import { getProfileLocalMaterialSettingsAdapter } from '@/features/plugins/pluginRegistry';

function resolvePngCompressionStrategy(
  mode: PngCompressionStrategy,
  antiAliasingLevel: AntiAliasingLevel,
  outputUsesPngLayers: boolean,
): 'fastest' | 'balanced' | 'smallest' | 'optimal' {
  if (!outputUsesPngLayers) {
    return 'fastest';
  }

  if (mode !== 'auto') {
    return mode;
  }

  if (antiAliasingLevel === 'Off') {
    return 'fastest';
  }

  // Any level of AA (2x, 4x, 8x, 16x) benefits from balanced compression 
  // to avoid ballooning file sizes from the gray anti-aliased pixels.
  return 'balanced';
}

function resolveContainerCompressionLevel(strategy: 'fastest' | 'balanced' | 'smallest' | 'optimal'): number {
  switch (strategy) {
    case 'fastest': return 1;
    case 'balanced': return 3;
    case 'smallest': return 6;
    case 'optimal': return 9;
    default: return 2;
  }
}

const DEBUG_PREFIX = '[SlicingDebug]';
const BYTES_PER_TRIANGLE_XYZ = Float32Array.BYTES_PER_ELEMENT * 9;
const STAGING_PREALLOC_MIN_BYTES = 16 * 1024 * 1024;
const STAGING_PREALLOC_MAX_BYTES = 1024 * 1024 * 1024;
const STAGING_PREALLOC_HEADROOM = 1.35;
const STAGING_CHUNK_TARGET_MIN_BYTES = 16 * 1024 * 1024;
const STAGING_CHUNK_TARGET_MAX_BYTES = 128 * 1024 * 1024;
const STAGING_CHUNK_TARGET_DIVISOR = 6;
const STAGE_MESH_SINGLE_SHOT_MAX_BYTES = 256 * 1024 * 1024;
// File-backed staging incurs an additional disk write + read pass, so keep it as a
// high-watermark fallback for very large meshes where in-memory staging becomes risky.
const STAGE_MESH_FILE_BACKED_MIN_BYTES = 2 * 1024 * 1024 * 1024;
const MESH_TRANSPORT_ENCODING = 'quantized_u16' as const;
const STAGE_PROGRESS_UPDATE_MIN_INTERVAL_MS = 250;
const STAGE_PROGRESS_UPDATE_MIN_BYTES = 64 * 1024 * 1024;

type StageMeshChunkAck = {
  chunkBytes: number;
  totalBytes: number;
  capacityBytes: number;
  reserveGrew: boolean;
  chunksReceived: number;
  appendNs: number;
  appendNsTotal: number;
};

function logDebug(...args: unknown[]): void {
  if (typeof console === 'undefined' || typeof console.debug !== 'function') return;
  console.debug(DEBUG_PREFIX, ...args);
}

function estimateInitialMeshStagingBytes(models: LoadedModel[]): number {
  const visibleModelTriangles = models.reduce((sum, model) => {
    if (!model.visible) return sum;
    const triangleCount = Number.isFinite(model.polygonCount)
      ? Math.max(0, Math.floor(model.polygonCount))
      : 0;
    return sum + triangleCount;
  }, 0);

  if (visibleModelTriangles <= 0) {
    return STAGING_PREALLOC_MIN_BYTES;
  }

  const estimatedBytes = Math.ceil(
    visibleModelTriangles * BYTES_PER_TRIANGLE_XYZ * STAGING_PREALLOC_HEADROOM,
  );

  return Math.max(
    STAGING_PREALLOC_MIN_BYTES,
    Math.min(STAGING_PREALLOC_MAX_BYTES, estimatedBytes),
  );
}

function resolveMeshChunkTargetBytes(initialMeshStagingBytes: number): number {
  const dynamicTarget = Math.ceil(initialMeshStagingBytes / STAGING_CHUNK_TARGET_DIVISOR);
  return Math.max(
    STAGING_CHUNK_TARGET_MIN_BYTES,
    Math.min(STAGING_CHUNK_TARGET_MAX_BYTES, dynamicTarget),
  );
}

function resolveMeshTransportQuantizationBounds(printerProfile: PrinterProfile) {
  const widthMm = Math.max(1, Number(printerProfile.buildVolumeMm.width) || 1);
  const depthMm = Math.max(1, Number(printerProfile.buildVolumeMm.depth) || 1);
  const heightMm = Math.max(1, Number(printerProfile.buildVolumeMm.height) || 1);

  return {
    minX: -widthMm * 0.5,
    minY: -depthMm * 0.5,
    minZ: 0,
    maxX: widthMm * 0.5,
    maxY: depthMm * 0.5,
    maxZ: heightMm,
  };
}

function quantizeMeshChunkToUint16(chunk: Uint8Array, bounds: ReturnType<typeof resolveMeshTransportQuantizationBounds>): Uint8Array {
  if (chunk.byteLength === 0) return chunk;
  if (chunk.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error(`Mesh chunk byte length ${chunk.byteLength} is not aligned to f32 boundaries.`);
  }

  const floats = new Float32Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / Float32Array.BYTES_PER_ELEMENT);
  const quantized = new Uint16Array(floats.length);

  const spans = [
    Math.max(0, bounds.maxX - bounds.minX),
    Math.max(0, bounds.maxY - bounds.minY),
    Math.max(0, bounds.maxZ - bounds.minZ),
  ];
  const mins = [bounds.minX, bounds.minY, bounds.minZ];
  const maxValue = 65535;

  for (let i = 0; i < floats.length; i += 1) {
    const axis = i % 3;
    const span = spans[axis];
    if (!Number.isFinite(span) || span <= 0) {
      quantized[i] = 0;
      continue;
    }

    const value = floats[i];
    const normalized = (value - mins[axis]) / span;
    const clamped = Math.max(0, Math.min(1, normalized));
    quantized[i] = Math.round(clamped * maxValue);
  }

  return new Uint8Array(quantized.buffer);
}

export type SliceExportOrchestratorOptions = {
  models: LoadedModel[];
  printerProfile: PrinterProfile;
  materialProfile: MaterialProfile;
  filenameBase: string;
  outputPath?: string | null;
  antiAliasingLevel?: AntiAliasingLevel;
  antiAliasingMode?: 'Blur' | '3DAA' | 'Vertical2' | 'Coverage';
  blurBrushRadiusPx?: number;
  blurBrushKernel?: 'box' | 'gaussian';
  blurBrushSigma?: number;
  blurBrushSigmaX?: number;
  blurBrushSigmaY?: number;
  zBlurRadiusLayers?: number;
  zBlurKernel?: 'box' | 'gaussian';
  zBlurSigma?: number;
  zBlendLookBack?: number;
  zBlendFadePx?: number;
  zBlendAutoFade?: boolean;
  zBlendMinimumAlphaPercent?: number;
  zBlendMaxAlphaPercent?: number;
  zBlendCustomLut?: number[];
  zaaKernel?: 'perturb';
  zaaPattern?: 'uniform' | 'halton' | 'base2';
  zaaDuplicateZ?: boolean;
  minimumAaAlphaPercentOverride?: number;
  aaOnSupports?: boolean;
  ditherEnabled?: boolean;
  ditherBitDepth?: number;
  ditherDeviceGamma?: number;
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
  /** Output format identifier, e.g. ".nanodlp" or ".ctb". Used to route layer preview decoding to the correct plugin decoder. */
  outputFormat: string;
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
      formatVersion?: string;
      settingsMode?: string;
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
      antiAliasingLevel: AntiAliasingLevel;
      antiAliasingMode: 'Blur' | '3DAA' | 'Vertical2' | 'Coverage';
      blurBrushRadiusPx: number;
      blurBrushKernel: 'box' | 'gaussian';
      blurBrushSigmaX: number;
      blurBrushSigmaY: number;
      zBlurRadiusLayers: number;
      zBlurKernel: 'box' | 'gaussian';
      zBlurSigma: number;
      aaOnSupports: boolean;
      minimumAaAlphaPercent: number;
      zaaKernel?: 'perturb';
      zaaPattern?: 'uniform' | 'halton' | 'base2';
      zaaDuplicateZ?: boolean;
      modelTriangleCount: number;
      triangleFloatCount: number;
      buildWidthMm: number;
      buildDepthMm: number;
      layerHeightMm: number;
      totalLayers: number;
      metadataJsonBytes: number;
      exportThumbnailProvided: boolean;
      exportThumbnailBytes: number;
      initialMeshStagingBytes: number;
      meshChunkTargetBytes: number;
      meshEncoding: 'raw_f32' | 'quantized_u16';
      meshQuantization: {
        minX: number;
        minY: number;
        minZ: number;
        maxX: number;
        maxY: number;
        maxZ: number;
      };
      meshTransferMode: 'single-shot' | 'streamed' | 'file-backed';
      meshStageFilePath: string | null;
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
      stageMeshBytes: number | null;
      stageMeshChunkCount: number | null;
      stageMeshAvgChunkBytes: number | null;
      stageMeshThroughputMiBPerSec: number | null;
      stageMeshAckAppendMs: number | null;
      stageMeshCapacityMaxBytes: number | null;
      stageMeshReserveGrowthEvents: number | null;
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

function setMetadataPathValue(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path
    .split('.')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) return;

  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    const existing = cursor[segment];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }

  cursor[segments[segments.length - 1]] = value;
}

function coerceLocalMaterialSettingValue(
  rawValue: string | number | boolean,
  kind: 'number' | 'integer' | 'text' | 'boolean' | 'select',
): string | number | boolean {
  if (kind === 'boolean') {
    if (typeof rawValue === 'boolean') return rawValue;
    if (typeof rawValue === 'string') {
      const normalized = rawValue.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
    return Boolean(rawValue);
  }

  if (kind === 'number' || kind === 'integer') {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) return kind === 'integer' ? 0 : 0;
    return kind === 'integer' ? Math.round(parsed) : parsed;
  }

  return String(rawValue);
}

function mergeMetadataOverridesIntoMetadata(
  metadataJson: string,
  outputFormat: string,
  materialProfile: MaterialProfile,
  settingsMode?: string,
  printerOutputFormat?: string,
): string {
  try {
    const parsed = JSON.parse(metadataJson) as Record<string, unknown>;

    if (settingsMode) {
      const printer = (parsed.printer ?? {}) as Record<string, unknown>;
      parsed.printer = {
        ...printer,
        settingsMode,
      };

      const exportNode = (parsed.export ?? {}) as Record<string, unknown>;
      const formatKey = outputFormat.replace(/^\./, '').toLowerCase();
      const formatNode = (exportNode[formatKey] ?? {}) as Record<string, unknown>;
      exportNode[formatKey] = {
        ...formatNode,
        settingsMode,
      };
      parsed.export = exportNode;
    }

    const adapter = getProfileLocalMaterialSettingsAdapter(printerOutputFormat ?? outputFormat, settingsMode)
      ?? getProfileLocalMaterialSettingsAdapter(outputFormat, settingsMode);
    const fieldSchema = adapter?.fields ?? [];
    if (fieldSchema.length > 0) {
      const localForOutput = materialProfile.localSettingsByOutput?.[printerOutputFormat ?? outputFormat]
        ?? materialProfile.localSettingsByOutput?.[outputFormat]
        ?? {};

      fieldSchema.forEach((field) => {
        const fieldValue = Object.prototype.hasOwnProperty.call(localForOutput, field.key)
          ? localForOutput[field.key]
          : field.defaultValue;

        const coercedValue = coerceLocalMaterialSettingValue(
          fieldValue,
          field.kind,
        );

        const targetPath = (field.metadataPath?.trim() || `material.${field.key}`);
        setMetadataPathValue(parsed, targetPath, coercedValue);
      });
    }

    return JSON.stringify(parsed);
  } catch {
    return metadataJson;
  }
}

/**
 * Orchestrates export via DragonFruit Desktop native slicer.
 */
export async function runSliceExportOrchestrator(options: SliceExportOrchestratorOptions): Promise<SliceExportResult> {
  throwIfAborted(options.abortSignal);
  const orchestratorStartMs = performance.now();
  const emitDiagnosticProgress = (phase: string, done: number, total: number, extra?: Record<string, unknown>) => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('dragonfruit:slicing-progress', {
      detail: {
        phase,
        done,
        total,
        ...extra,
      },
    }));
  };

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
  emitDiagnosticProgress('Preparing mesh', 0, 1, {
    format: format.outputFormat,
    modelCount: options.models.length,
  });

  const initialMeshStagingBytes = estimateInitialMeshStagingBytes(options.models);
  const meshTransportBytesEstimate = Math.ceil(initialMeshStagingBytes / 2);
  const meshTransportEncoding: 'raw_f32' | 'quantized_u16' = MESH_TRANSPORT_ENCODING;
  const meshTransportQuantization = resolveMeshTransportQuantizationBounds(options.printerProfile);
  const meshChunkTargetBytes = resolveMeshChunkTargetBytes(meshTransportBytesEstimate);
  const meshTransferMode: 'single-shot' | 'streamed' | 'file-backed' = meshTransportBytesEstimate >= STAGE_MESH_FILE_BACKED_MIN_BYTES
    ? 'file-backed'
    : meshTransportBytesEstimate <= STAGE_MESH_SINGLE_SHOT_MAX_BYTES
      ? 'single-shot'
      : 'streamed';
  let meshStageFilePath: string | null = null;

  if (meshTransferMode === 'streamed') {
    // Tell Rust to reserve a realistic staging buffer before chunks arrive.
    await invoke('stage_mesh_binary_start', { totalBytes: meshTransportBytesEstimate });
  } else if (meshTransferMode === 'file-backed') {
    meshStageFilePath = await invoke<string>('allocate_mesh_stage_path');
  }

  logDebug('Initialized mesh staging buffer', {
    initialMeshStagingBytes,
    initialMeshStagingMiB: Number((initialMeshStagingBytes / (1024 * 1024)).toFixed(2)),
    meshChunkTargetBytes,
    meshChunkTargetMiB: Number((meshChunkTargetBytes / (1024 * 1024)).toFixed(2)),
    meshTransportBytesEstimate,
    meshTransportEncoding,
    meshTransferMode,
  });

  let cumulativeBytesStage = 0;
  let stageMeshIpcMs = 0;
  let stageMeshChunkCount = 0;
  let stageMeshAckAppendNsTotal = 0;
  let stageMeshCapacityMaxBytes = 0;
  let stageMeshReserveGrowthEvents = 0;
  let lastStageProgressUpdateMs = 0;
  let lastStageProgressUpdateBytes = 0;

  const maybeEmitStageProgress = () => {
    const nowMs = performance.now();
    const shouldEmitProgress = stageMeshChunkCount === 1
      || (nowMs - lastStageProgressUpdateMs) >= STAGE_PROGRESS_UPDATE_MIN_INTERVAL_MS
      || (cumulativeBytesStage - lastStageProgressUpdateBytes) >= STAGE_PROGRESS_UPDATE_MIN_BYTES;
    if (!shouldEmitProgress) return;

    const mb = Math.round(cumulativeBytesStage / (1024 * 1024));
    options.onProgress?.(0, 1, `Transferring Mesh (${mb} MB)`);
    lastStageProgressUpdateMs = nowMs;
    lastStageProgressUpdateBytes = cumulativeBytesStage;
  };

  const handleMeshChunk = async (chunk: Uint8Array) => {
    throwIfAborted(options.abortSignal);
    const transportChunk = meshTransportEncoding === 'quantized_u16'
      ? quantizeMeshChunkToUint16(chunk, meshTransportQuantization)
      : chunk;

    cumulativeBytesStage += transportChunk.byteLength;
    stageMeshChunkCount += 1;
    maybeEmitStageProgress();

    const chunkInvokeStart = performance.now();
    const chunkAck = await invoke<StageMeshChunkAck>('stage_mesh_binary_chunk', transportChunk, {
      headers: { 'Content-Type': 'application/octet-stream' },
    });

    stageMeshAckAppendNsTotal = Math.max(stageMeshAckAppendNsTotal, chunkAck.appendNsTotal ?? 0);
    stageMeshCapacityMaxBytes = Math.max(stageMeshCapacityMaxBytes, chunkAck.capacityBytes ?? 0);
    if (chunkAck.reserveGrew) {
      stageMeshReserveGrowthEvents += 1;
    }

    stageMeshIpcMs += performance.now() - chunkInvokeStart;
  };

  const handleMeshFileChunk = async (chunk: Uint8Array) => {
    throwIfAborted(options.abortSignal);
    if (!meshStageFilePath) {
      throw new Error('Mesh stage file path was not allocated before chunk append.');
    }

    const transportChunk = meshTransportEncoding === 'quantized_u16'
      ? quantizeMeshChunkToUint16(chunk, meshTransportQuantization)
      : chunk;

    cumulativeBytesStage += transportChunk.byteLength;
    stageMeshChunkCount += 1;
    maybeEmitStageProgress();

    const appendStart = performance.now();
    const appendedLen = await invoke<number>('append_mesh_stage_chunk', transportChunk, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-mesh-stage-path': meshStageFilePath,
      },
    });
    stageMeshIpcMs += performance.now() - appendStart;

    if (appendedLen > 0) {
      cumulativeBytesStage = appendedLen;
    }
  };

  const meshPrepStartMs = performance.now();
  const solidMesh = await buildSolidSliceMeshForWasm({
    models: options.models,
    printerProfile: options.printerProfile,
    materialProfile: options.materialProfile,
    filenameBase: options.filenameBase,
    flushBinaryMeshChunk: meshTransferMode === 'streamed'
      ? handleMeshChunk
      : meshTransferMode === 'file-backed'
        ? handleMeshFileChunk
        : undefined,
    meshChunkTargetBytes,
  });
  const meshPrepMs = performance.now() - meshPrepStartMs;

  if (meshTransferMode === 'single-shot') {
    const meshBytes = new Uint8Array(
      solidMesh.trianglesXYZ.buffer,
      solidMesh.trianglesXYZ.byteOffset,
      solidMesh.trianglesXYZ.byteLength,
    );
    const transportBytes = meshTransportEncoding === 'quantized_u16'
      ? quantizeMeshChunkToUint16(meshBytes, meshTransportQuantization)
      : meshBytes;
    const mb = Math.round(transportBytes.byteLength / (1024 * 1024));
    options.onProgress?.(0, 1, `Transferring Mesh (${mb} MB)`);

    const chunkInvokeStart = performance.now();
    const chunkAck = await invoke<StageMeshChunkAck>('stage_mesh_binary_set', transportBytes, {
      headers: { 'Content-Type': 'application/octet-stream' },
    });

    stageMeshIpcMs += performance.now() - chunkInvokeStart;
    cumulativeBytesStage = chunkAck.totalBytes > 0 ? chunkAck.totalBytes : transportBytes.byteLength;
    stageMeshChunkCount = chunkAck.chunksReceived > 0 ? chunkAck.chunksReceived : 1;
    stageMeshAckAppendNsTotal = Math.max(stageMeshAckAppendNsTotal, chunkAck.appendNsTotal ?? 0);
    stageMeshCapacityMaxBytes = Math.max(stageMeshCapacityMaxBytes, chunkAck.capacityBytes ?? 0);
    if (chunkAck.reserveGrew) {
      stageMeshReserveGrowthEvents += 1;
    }
  } else if (meshTransferMode === 'file-backed') {
    if (!meshStageFilePath) {
      throw new Error('Mesh stage file path missing for file-backed transfer mode.');
    }

    const registerStart = performance.now();
    const registeredLen = await invoke<number>('stage_mesh_file_path', {
      meshFilePath: meshStageFilePath,
    });
    stageMeshIpcMs += performance.now() - registerStart;

    if (registeredLen > 0) {
      cumulativeBytesStage = registeredLen;
    }
  }

  logDebug('Solid mesh prepared for native backend', {
    source: `${solidMesh.sourceWidthPx}x${solidMesh.sourceHeightPx}`,
    output: `${solidMesh.widthPx}x${solidMesh.heightPx}`,
    packingMode: solidMesh.xPackingMode,
    totalLayers: solidMesh.totalLayers,
    meshPrepMs,
    stagedMeshBytes: cumulativeBytesStage,
    stagedMeshChunkCount: stageMeshChunkCount,
    stageMeshIpcMs,
    meshTransportEncoding,
    meshTransferMode,
    meshStageFilePath,
  });
  emitDiagnosticProgress('Preparing mesh complete', 1, 1, {
    meshPrepMs,
    triangleFloatCount: solidMesh.trianglesXYZ.length,
    totalLayers: solidMesh.totalLayers,
  });

  options.onProgress?.(0, solidMesh.totalLayers, 'Staging');

  const perfSettings = getSavedSlicingPerformanceSettings();

  const resolvedPngStrategy = resolvePngCompressionStrategy(
    solidMesh.pngCompressionStrategy,
    options.antiAliasingLevel ?? 'Off',
    format.layerDataKind === 'png',
  );

  const nativeJob = {
    outputFormat: format.outputFormat,
    formatVersion: resolveOutputFormatVersion(
      format.outputFormat,
      options.printerProfile.display.formatVersion,
    ),
    settingsMode: resolveOutputSettingsMode(
      format.outputFormat,
      options.printerProfile.display.settingsMode,
    ),
    sourceWidthPx: solidMesh.sourceWidthPx,
    sourceHeightPx: solidMesh.sourceHeightPx,
    widthPx: solidMesh.widthPx,
    heightPx: solidMesh.heightPx,
    xPackingMode: solidMesh.xPackingMode,
    computeBackend: solidMesh.computeBackend,
    pngCompressionStrategy: resolvedPngStrategy,
    bvhAccelerationEnabled: solidMesh.bvhAccelerationEnabled,
    antiAliasingLevel: options.antiAliasingLevel ?? 'Off',
    antiAliasingMode: options.antiAliasingMode ?? 'Blur',
    blurBrushRadiusPx: Math.max(1, Math.round(options.blurBrushRadiusPx ?? 1)),
    blurBrushKernel: options.blurBrushKernel ?? 'gaussian',
    blurBrushSigmaX: Math.max(0.05, Math.min(16, Number(options.blurBrushSigmaX ?? options.blurBrushSigma ?? 0.5))),
    blurBrushSigmaY: Math.max(0.05, Math.min(16, Number(options.blurBrushSigmaY ?? options.blurBrushSigma ?? 0.5))),
    zBlurRadiusLayers: Math.max(0, Math.min(8, Math.round(options.zBlurRadiusLayers ?? 0))),
    zBlurKernel: options.zBlurKernel ?? 'box',
    zBlurSigma: Math.max(0.05, Math.min(16, Number(options.zBlurSigma ?? 0.5))),
    zBlendLookBack: Math.max(1, Math.round(options.zBlendLookBack ?? 2)),
    zBlendFadePx: Math.max(1, Math.round(options.zBlendFadePx ?? 20)),
    zBlendAutoFade: options.zBlendAutoFade !== false,
    zBlendMinimumAlphaPercent: Math.max(0, Math.min(100, options.zBlendMinimumAlphaPercent ?? 0)),
    zBlendMaxAlphaPercent: Math.max(0, Math.min(100, options.zBlendMaxAlphaPercent ?? 90)),
    zBlendCustomLut: options.zBlendCustomLut,
    zaaKernel: options.zaaKernel,
    zaaPattern: options.zaaPattern,
    zaaDuplicateZ: options.zaaDuplicateZ,
    aaOnSupports: options.aaOnSupports ?? (perfSettings.aaOnSupportsExperimental === true),
    minimumAaAlphaPercent: Math.max(
      0,
      Math.min(
        100,
        options.minimumAaAlphaPercentOverride
          ?? options.materialProfile.minimumAaAlphaPercent
          ?? 50,
      ),
    ),
    mirrorX: solidMesh.mirrorX,
    mirrorY: solidMesh.mirrorY,
    ditherEnabled: options.ditherEnabled ?? options.materialProfile.antiAliasingSettings?.ditherEnabled ?? false,
    ditherBitDepth: options.ditherBitDepth ?? options.materialProfile.antiAliasingSettings?.ditherBitDepth ?? 3,
    ditherDeviceGamma: options.ditherDeviceGamma ?? options.materialProfile.antiAliasingSettings?.ditherDeviceGamma ?? 3.0,
    modelTriangleCount: solidMesh.modelTriangleCount,
    containerCompressionLevel: resolveContainerCompressionLevel(resolvedPngStrategy),
    buildWidthMm: solidMesh.buildWidthMm,
    buildDepthMm: solidMesh.buildDepthMm,
    layerHeightMm: solidMesh.layerHeightMm,
    totalLayers: solidMesh.totalLayers,
    exportThumbnailPngBase64: options.exportThumbnailPng && options.exportThumbnailPng.length > 0
      ? encodeBytesToBase64(options.exportThumbnailPng)
      : null,
    trianglesXYZ: solidMesh.trianglesXYZ,
    meshEncoding: meshTransportEncoding,
    meshQuantization: meshTransportQuantization,
    outputPath: options.outputPath?.trim() || null,
    metadataJson: mergeMetadataOverridesIntoMetadata(
      solidMesh.metadataJson,
      format.outputFormat,
      options.materialProfile,
      resolveOutputSettingsMode(format.outputFormat, options.printerProfile.display.settingsMode),
      options.printerProfile.display.outputFormat,
    ),
  };

  const coreStartMs = performance.now();
  logDebug('Native slicing starting…');
  logDebug('Native slicing AA settings', {
    antiAliasingLevel: nativeJob.antiAliasingLevel,
    antiAliasingMode: nativeJob.antiAliasingMode,
    blurBrushRadiusPx: nativeJob.blurBrushRadiusPx,
    zBlurRadiusLayers: nativeJob.zBlurRadiusLayers,
    zaaKernel: nativeJob.zaaKernel,
    zaaPattern: nativeJob.zaaPattern,
    zaaDuplicateZ: nativeJob.zaaDuplicateZ,
  });

  let progressTotal = solidMesh.totalLayers;
  let progressDone = 0;

  options.onProgress?.(0, solidMesh.totalLayers, 'Slicing');

  const slicerProgressCallback = (done: number, total: number, phase: string) => {
    progressTotal = Math.max(1, total);
    progressDone = Math.max(0, Math.min(done, progressTotal));
    options.onProgress?.(
      progressDone,
      progressTotal,
      phase,
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
  options.onProgress?.(Math.max(progressDone, progressTotal), progressTotal, 'Finalizing');

  const printerExt = options.printerProfile.display.outputFormat.replace(/^\./, '') || format.outputFormat.replace(/^\./, '') || 'slice';
  const outputName = `${safeFilenameBase(options.filenameBase)}.${printerExt}`;

  const totalElapsedMs = performance.now() - orchestratorStartMs;
  options.onProgress?.(progressTotal, progressTotal, 'Handoff');
  const layersPerSecond = totalElapsedMs > 0
    ? (solidMesh.totalLayers * 1000) / totalElapsedMs
    : null;
  const stageMeshAvgChunkBytes = stageMeshChunkCount > 0
    ? (cumulativeBytesStage / stageMeshChunkCount)
    : null;
  const stageMeshThroughputMiBPerSec = stageMeshIpcMs > 0
    ? ((cumulativeBytesStage / (1024 * 1024)) / (stageMeshIpcMs / 1000))
    : null;
  const stageMeshAckAppendMs = stageMeshAckAppendNsTotal > 0
    ? (stageMeshAckAppendNsTotal / 1_000_000)
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
      outputFormat: format.outputFormat,
    },
    benchmark: {
      totalElapsedMs,
      meshPrepMs,
      coreSlicingMs,
      totalLayers: solidMesh.totalLayers,
      layersPerSecond,
      jobConfig: {
        outputFormat: format.outputFormat,
        formatVersion: nativeJob.formatVersion,
        settingsMode: nativeJob.settingsMode,
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
        antiAliasingMode: nativeJob.antiAliasingMode,
        blurBrushRadiusPx: nativeJob.blurBrushRadiusPx,
        blurBrushKernel: nativeJob.blurBrushKernel,
        blurBrushSigmaX: nativeJob.blurBrushSigmaX,
        blurBrushSigmaY: nativeJob.blurBrushSigmaY,
        zBlurRadiusLayers: nativeJob.zBlurRadiusLayers,
        zBlurKernel: nativeJob.zBlurKernel,
        zBlurSigma: nativeJob.zBlurSigma,
        aaOnSupports: nativeJob.aaOnSupports,
        minimumAaAlphaPercent: nativeJob.minimumAaAlphaPercent,
        zaaKernel: nativeJob.zaaKernel,
        zaaPattern: nativeJob.zaaPattern,
        zaaDuplicateZ: nativeJob.zaaDuplicateZ,
        modelTriangleCount: nativeJob.modelTriangleCount,
        triangleFloatCount: nativeJob.trianglesXYZ.length,
        buildWidthMm: nativeJob.buildWidthMm,
        buildDepthMm: nativeJob.buildDepthMm,
        layerHeightMm: nativeJob.layerHeightMm,
        totalLayers: nativeJob.totalLayers,
        metadataJsonBytes: nativeJob.metadataJson.length,
        exportThumbnailProvided: Boolean(options.exportThumbnailPng && options.exportThumbnailPng.length > 0),
        exportThumbnailBytes: options.exportThumbnailPng?.length ?? 0,
        initialMeshStagingBytes: meshTransportBytesEstimate,
        meshChunkTargetBytes,
        meshEncoding: meshTransportEncoding,
        meshQuantization: meshTransportQuantization,
        meshTransferMode,
        meshStageFilePath,
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
        stageMeshMs: stageMeshIpcMs > 0
          ? stageMeshIpcMs
          : (encodedArtifact.bridge?.stageMeshMs ?? null),
        stageMeshBytes: cumulativeBytesStage > 0 ? cumulativeBytesStage : null,
        stageMeshChunkCount: stageMeshChunkCount > 0 ? stageMeshChunkCount : null,
        stageMeshAvgChunkBytes,
        stageMeshThroughputMiBPerSec,
        stageMeshAckAppendMs,
        stageMeshCapacityMaxBytes: stageMeshCapacityMaxBytes > 0 ? stageMeshCapacityMaxBytes : null,
        stageMeshReserveGrowthEvents,
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
