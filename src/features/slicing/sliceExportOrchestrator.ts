import type { MaterialProfile, PrinterProfile } from '@/features/profiles/profileStore';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { exportRasterLayerZip, rasterizeLayersForWasm } from './rasterLayerZipExport';
import { resolveSlicingFormatDefinition } from './formats/registry';
import { encodeWithSlicerWasm, isSlicerWasmAvailable } from './wasm/slicerWasmBridge';

export type SliceExportOrchestratorOptions = {
  models: LoadedModel[];
  printerProfile: PrinterProfile;
  materialProfile: MaterialProfile;
  filenameBase: string;
  onProgress?: (done: number, total: number, phase: string) => void;
};

export type SliceExportResult = {
  backend: 'wasm-nanodlp' | 'js-raster-zip';
  outputFormat: string;
  wasmAvailable: boolean;
  fallbackUsed: boolean;
};

function safeFilenameBase(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'slice_export';
  const cleaned = trimmed.replace(/[^a-z0-9-_]+/gi, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'slice_export';
}

function triggerByteDownload(bytes: Uint8Array, filename: string, mimeType = 'application/octet-stream'): void {
  const normalized = Uint8Array.from(bytes);
  const blob = new Blob([normalized], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.click();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
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
  const format = resolveSlicingFormatDefinition({
    printerProfile: options.printerProfile,
    materialProfile: options.materialProfile,
  });

  let wasmAvailable = false;
  let fallbackUsed = false;

  if (format.outputFormat === '.nanodlp') {
    wasmAvailable = await isSlicerWasmAvailable();
    if (wasmAvailable) {
      try {
        const rasterized = await rasterizeLayersForWasm({
          models: options.models,
          printerProfile: options.printerProfile,
          materialProfile: options.materialProfile,
          filenameBase: options.filenameBase,
          onProgress: (done, total, phase) => {
            options.onProgress?.(done, total, `${phase} · ${format.displayName}`);
          },
        });

        options.onProgress?.(rasterized.totalLayers, rasterized.totalLayers, 'Encoding .nanodlp (WASM)');
        const encodedBytes = await encodeWithSlicerWasm(format, {
          outputFormat: format.outputFormat,
          widthPx: rasterized.widthPx,
          heightPx: rasterized.heightPx,
          layerHeightMm: rasterized.layerHeightMm,
          totalLayers: rasterized.totalLayers,
          layerPngs: rasterized.layerPngs,
          metadataJson: rasterized.metadataJson,
        });

        const outputName = `${safeFilenameBase(options.filenameBase)}.nanodlp`;
        triggerByteDownload(encodedBytes, outputName);
        return {
          backend: 'wasm-nanodlp',
          outputFormat: format.outputFormat,
          wasmAvailable,
          fallbackUsed: false,
        };
      } catch (error) {
        console.warn('[Slicing] WASM .nanodlp encode failed; falling back to ZIP prototype.', error);
        fallbackUsed = true;
      }
    } else {
      fallbackUsed = true;
    }
  }

  await exportRasterLayerZip({
    models: options.models,
    printerProfile: options.printerProfile,
    materialProfile: options.materialProfile,
    filenameBase: options.filenameBase,
    onProgress: (done, total, phase) => {
      options.onProgress?.(done, total, `${phase} · ${format.displayName}`);
    },
  });

  return {
    backend: 'js-raster-zip',
    outputFormat: format.outputFormat,
    wasmAvailable,
    fallbackUsed,
  };
}
