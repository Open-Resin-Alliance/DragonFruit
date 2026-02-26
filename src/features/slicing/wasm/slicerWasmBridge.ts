import type { SlicingFormatDefinition } from '@/features/slicing/formats/types';

export type WasmSliceJobEnvelope = {
  outputFormat: string;
  widthPx: number;
  heightPx: number;
  layerHeightMm: number;
  totalLayers: number;
  layerPngs: Uint8Array[];
  metadataJson: string;
};

type DragonfruitSlicerWasmModule = {
  encode_slice_job: (jobJson: string) => Uint8Array;
};

let wasmModulePromise: Promise<DragonfruitSlicerWasmModule> | null = null;

async function loadSlicerWasmModule(): Promise<DragonfruitSlicerWasmModule> {
  if (!wasmModulePromise) {
    wasmModulePromise = (async () => {
      // Loaded from public runtime asset to avoid compile-time module resolution errors
      // when the generated wasm-bindgen JS does not exist yet.
      const runtimeModuleUrl = '/wasm/dragonfruit_slicer_wasm.js';
      const mod = await import(/* webpackIgnore: true */ runtimeModuleUrl);
      return mod as DragonfruitSlicerWasmModule;
    })().catch((error) => {
      wasmModulePromise = null;
      throw error;
    });
  }
  return wasmModulePromise;
}

export async function isSlicerWasmAvailable(): Promise<boolean> {
  try {
    await loadSlicerWasmModule();
    return true;
  } catch {
    return false;
  }
}

/**
 * Bridge contract for the upcoming Rust/WASM module.
 *
 * This intentionally does not import the generated wasm pkg yet, so the
 * scaffold can land before the wasm build pipeline is wired.
 */
export async function encodeWithSlicerWasm(
  format: SlicingFormatDefinition,
  job: WasmSliceJobEnvelope,
): Promise<Uint8Array> {
  const wasm = await loadSlicerWasmModule();

  const payload = JSON.stringify({
    output_format: job.outputFormat,
    width_px: job.widthPx,
    height_px: job.heightPx,
    layer_height_mm: job.layerHeightMm,
    total_layers: job.totalLayers,
    layer_pngs: job.layerPngs.map((bytes) => Array.from(bytes)),
    metadata_json: job.metadataJson,
    format_id: format.id,
  });

  return wasm.encode_slice_job(payload);
}
