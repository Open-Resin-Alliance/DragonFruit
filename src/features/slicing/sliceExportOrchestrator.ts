import type { MaterialProfile, PrinterProfile } from '@/features/profiles/profileStore';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { buildSolidSliceMeshForWasm } from './rasterLayerZipExport';
import { resolveOutputFormatVersion, resolveOutputSettingsMode, resolveSlicingFormatDefinition } from './formats/registry';
import type { PngCompressionStrategy } from '@/components/settings/performancePreferences';
import {
  isNativeSlicerAvailable,
  sliceSolidAndEncodeWithNativeSlicerToTempPath,
  type NativeSlicerPerfMetrics,
  type NativeSlicerRuntimeMetrics,
} from './tauri/nativeSlicerBridge';
import { getProfileLocalMaterialSettingsAdapter } from '@/features/plugins/pluginRegistry';

function resolvePngCompressionStrategy(
  mode: PngCompressionStrategy,
  antiAliasingLevel: 'Off' | '2x' | '4x' | '8x' | '16x',
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
  minimumAaAlphaPercentOverride?: number;
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
      antiAliasingLevel: 'Off' | '2x' | '4x' | '8x' | '16x';
      aaOnSupports: boolean;
      minimumAaAlphaPercent: number;
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

    const adapter = getProfileLocalMaterialSettingsAdapter(outputFormat, settingsMode);
    const fieldSchema = adapter?.fields ?? [];
    if (fieldSchema.length > 0) {
      const localForOutput = materialProfile.localSettingsByOutput?.[outputFormat] ?? {};

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
  emitDiagnosticProgress('Preparing mesh complete', 1, 1, {
    meshPrepMs,
    triangleFloatCount: solidMesh.trianglesXYZ.length,
    totalLayers: solidMesh.totalLayers,
  });

  options.onProgress?.(0, solidMesh.totalLayers, 'Staging');

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
    aaOnSupports: true,
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
    metadataJson: mergeMetadataOverridesIntoMetadata(
      solidMesh.metadataJson,
      format.outputFormat,
      options.materialProfile,
      resolveOutputSettingsMode(format.outputFormat, options.printerProfile.display.settingsMode),
    ),
  };

  const coreStartMs = performance.now();
  logDebug('Native slicing starting…');
  logDebug('Native slicing AA settings', {
    antiAliasingLevel: nativeJob.antiAliasingLevel,
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

  const outputExt = format.outputFormat.replace(/^\./, '') || 'slice';
  const outputName = `${safeFilenameBase(options.filenameBase)}.${outputExt}`;

  const totalElapsedMs = performance.now() - orchestratorStartMs;
  options.onProgress?.(progressTotal, progressTotal, 'Handoff');
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
        aaOnSupports: nativeJob.aaOnSupports,
        minimumAaAlphaPercent: nativeJob.minimumAaAlphaPercent,
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
