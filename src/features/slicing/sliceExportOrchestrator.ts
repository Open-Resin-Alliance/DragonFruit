import type { MaterialProfile, PrinterProfile } from '@/features/profiles/profileStore';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { buildSolidSliceMeshForWasm, exportRasterLayerZip } from './rasterLayerZipExport';
import { resolveSlicingFormatDefinition } from './formats/registry';
import { isSlicerWasmAvailable, sliceSolidAndEncodeWithSlicerWasm } from './wasm/slicerWasmBridge';
import { sliceSolidNanodlpInWorker, supportsSlicingWorker } from './slicingWorkerClient';

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
  backend: 'wasm-nanodlp' | 'js-raster-zip';
  outputFormat: string;
  wasmAvailable: boolean;
  fallbackUsed: boolean;
  wasmError: string | null;
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
 * Orchestrates export for the current prototype pipeline.
 *
 * Current behavior:
 * - Resolves a format definition (plugin-aware metadata contract)
 * - Uses JS raster ZIP implementation as temporary backend
 *
 * Planned behavior:
 * - Route through Rust/WASM encoder selected by `format.wasmExportName`
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

  let wasmAvailable = false;
  let fallbackUsed = false;
  let wasmError: string | null = null;

  if (format.outputFormat === '.nanodlp') {
    throwIfAborted(options.abortSignal);
    wasmAvailable = await isSlicerWasmAvailable();
    logDebug('WASM availability', { wasmAvailable });
    if (wasmAvailable) {
      try {
        throwIfAborted(options.abortSignal);
        options.onProgress?.(0, 1, `Preparing solid mesh · ${format.displayName}`);
        const meshPrepStartMs = performance.now();
        const solidMesh = buildSolidSliceMeshForWasm({
          models: options.models,
          printerProfile: options.printerProfile,
          materialProfile: options.materialProfile,
          filenameBase: options.filenameBase,
        });
        const meshPrepMs = performance.now() - meshPrepStartMs;

        logDebug('Solid mesh prepared', {
          source: `${solidMesh.sourceWidthPx}x${solidMesh.sourceHeightPx}`,
          output: `${solidMesh.widthPx}x${solidMesh.heightPx}`,
          packingMode: solidMesh.xPackingMode,
          totalLayers: solidMesh.totalLayers,
          meshPrepMs,
        });

        options.onProgress?.(
          0,
          solidMesh.totalLayers,
          `Solid slicing + encoding .nanodlp (WASM) · mode=${solidMesh.xPackingMode} · ${solidMesh.widthPx}x${solidMesh.heightPx}`,
        );
        const coreStartMs = performance.now();
        const wasmJob = {
          outputFormat: format.outputFormat,
          sourceWidthPx: solidMesh.sourceWidthPx,
          sourceHeightPx: solidMesh.sourceHeightPx,
          widthPx: solidMesh.widthPx,
          heightPx: solidMesh.heightPx,
          xPackingMode: solidMesh.xPackingMode,
          buildWidthMm: solidMesh.buildWidthMm,
          buildDepthMm: solidMesh.buildDepthMm,
          layerHeightMm: solidMesh.layerHeightMm,
          totalLayers: solidMesh.totalLayers,
          trianglesXYZ: solidMesh.trianglesXYZ,
          metadataJson: solidMesh.metadataJson,
        };

        const useWorker = supportsSlicingWorker();
        let encodedBytes: Uint8Array | null = null;
        let encodedBlob: Blob | null = null;
        let coreSlicingMs: number;

        if (useWorker) {
          throwIfAborted(options.abortSignal);
          logDebug('Using worker pool path for NanoDLP');
          options.onProgress?.(0, solidMesh.totalLayers, 'Starting high-performance slicing workers…');
          const workerResult = await sliceSolidNanodlpInWorker({
            job: wasmJob,
            previewPngBytes: options.exportThumbnailPng ?? undefined,
            abortSignal: options.abortSignal,
            onProgress: (done: number, total: number, phase: string) => {
              options.onProgress?.(Math.min(Math.max(0, done), Math.max(1, total)), Math.max(1, total), phase);
            },
            onLayerPreview: options.onLayerPreview,
          });
          options.onProgress?.(solidMesh.totalLayers, solidMesh.totalLayers, 'WASM slicing finished');
          encodedBlob = workerResult.blob;
          coreSlicingMs = workerResult.coreElapsedMs;
        } else {
          throwIfAborted(options.abortSignal);
          logDebug('Using direct WASM path for NanoDLP');
          encodedBytes = await sliceSolidAndEncodeWithSlicerWasm(format, wasmJob);
          coreSlicingMs = performance.now() - coreStartMs;
        }

        throwIfAborted(options.abortSignal);
        const outputName = `${safeFilenameBase(options.filenameBase)}.nanodlp`;
        let artifactBlob: Blob;
        if (encodedBlob) {
          artifactBlob = encodedBlob;
          if (options.outputMode !== 'return') {
            triggerBlobDownload(encodedBlob, outputName);
          }
        } else if (encodedBytes) {
          artifactBlob = new Blob([Uint8Array.from(encodedBytes)], { type: 'application/octet-stream' });
          if (options.outputMode !== 'return') {
            triggerByteDownload(encodedBytes, outputName);
          }
        } else {
          throw new Error('Slicing produced no output payload.');
        }
        const totalElapsedMs = performance.now() - orchestratorStartMs;
        const layersPerSecond = totalElapsedMs > 0
          ? (solidMesh.totalLayers * 1000) / totalElapsedMs
          : null;

        logDebug('Export orchestrator success', {
          backend: 'wasm-nanodlp',
          totalElapsedMs,
          coreSlicingMs,
          layersPerSecond,
        });

        return {
          backend: 'wasm-nanodlp',
          outputFormat: format.outputFormat,
          wasmAvailable,
          fallbackUsed: false,
          wasmError: null,
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
      } catch (error) {
        if ((error as { name?: string } | null)?.name === 'AbortError') {
          throw error;
        }
        console.warn('[Slicing] WASM .nanodlp encode failed; falling back to ZIP prototype.', error);
        wasmError = error instanceof Error ? error.message : String(error);
        logDebug('Falling back due to WASM error', { wasmError });
        fallbackUsed = true;
      }
    } else {
      logDebug('Falling back because WASM unavailable');
      fallbackUsed = true;
    }
  }

  const fallbackArtifact = await exportRasterLayerZip({
    models: options.models,
    printerProfile: options.printerProfile,
    materialProfile: options.materialProfile,
    filenameBase: options.filenameBase,
    outputMode: options.outputMode,
    abortSignal: options.abortSignal,
    onProgress: (done, total, phase) => {
      options.onProgress?.(done, total, `${phase} · ${format.displayName}`);
    },
  });

  const totalElapsedMs = performance.now() - orchestratorStartMs;

  logDebug('Export orchestrator completed with JS fallback', {
    totalElapsedMs,
    outputFormat: format.outputFormat,
    fallbackUsed,
    wasmError,
  });

  return {
    backend: 'js-raster-zip',
    outputFormat: format.outputFormat,
    wasmAvailable,
    fallbackUsed,
    wasmError,
    artifact: {
      blob: fallbackArtifact.blob,
      outputName: fallbackArtifact.outputName,
      mimeType: 'application/zip',
      byteSize: fallbackArtifact.blob.size,
    },
    benchmark: {
      totalElapsedMs,
      meshPrepMs: null,
      coreSlicingMs: null,
      totalLayers: null,
      layersPerSecond: null,
    },
  };
}
