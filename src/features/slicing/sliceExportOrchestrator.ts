import type { MaterialProfile, PrinterProfile } from '@/features/profiles/profileStore';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { exportRasterLayerZip } from './rasterLayerZipExport';
import { resolveSlicingFormatDefinition } from './formats/registry';

export type SliceExportOrchestratorOptions = {
  models: LoadedModel[];
  printerProfile: PrinterProfile;
  materialProfile: MaterialProfile;
  filenameBase: string;
  onProgress?: (done: number, total: number, phase: string) => void;
};

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
export async function runSliceExportOrchestrator(options: SliceExportOrchestratorOptions): Promise<void> {
  const format = resolveSlicingFormatDefinition({
    printerProfile: options.printerProfile,
    materialProfile: options.materialProfile,
  });

  await exportRasterLayerZip({
    models: options.models,
    printerProfile: options.printerProfile,
    materialProfile: options.materialProfile,
    filenameBase: options.filenameBase,
    onProgress: (done, total, phase) => {
      options.onProgress?.(done, total, `${phase} · ${format.displayName}`);
    },
  });
}
