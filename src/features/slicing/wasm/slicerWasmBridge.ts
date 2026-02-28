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

export type WasmSolidSliceJobEnvelope = {
  outputFormat: string;
  sourceWidthPx: number;
  sourceHeightPx: number;
  widthPx: number;
  heightPx: number;
  xPackingMode: 'none' | 'rgb8_div3' | 'gray3_div2';
  pngCompressionStrategy: 'fastest' | 'balanced' | 'smallest' | 'optimal';
  bvhAccelerationEnabled: boolean;
  antiAliasingLevel: 'Off' | '2x' | '4x' | '8x';
  aaOnSupports: boolean;
  modelTriangleCount: number;
  buildWidthMm: number;
  buildDepthMm: number;
  layerHeightMm: number;
  totalLayers: number;
  trianglesXYZ: Float32Array;
  metadataJson: string;
};

type DragonfruitSlicerWasmModule = {
  encode_slice_job: (jobJson: string) => Uint8Array;
  slice_solid_and_encode_job: (jobJson: string) => Uint8Array;
  slice_solid_and_encode_raw?: (
    outputFormat: string,
    sourceWidthPx: number,
    sourceHeightPx: number,
    widthPx: number,
    heightPx: number,
    xPackingMode: string,
    pngCompressionStrategy: string,
    bvhAccelerationEnabled: boolean,
    antiAliasingLevel: 'Off' | '2x' | '4x' | '8x',
    aaOnSupports: boolean,
    modelTriangleCount: number,
    buildWidthMm: number,
    buildDepthMm: number,
    layerHeightMm: number,
    totalLayers: number,
    trianglesXYZ: Float32Array,
    metadataJson: string,
  ) => Uint8Array;
  slice_solid_layers_chunk_raw?: (
    outputFormat: string,
    sourceWidthPx: number,
    sourceHeightPx: number,
    widthPx: number,
    heightPx: number,
    xPackingMode: string,
    pngCompressionStrategy: string,
    bvhAccelerationEnabled: boolean,
    antiAliasingLevel: 'Off' | '2x' | '4x' | '8x',
    aaOnSupports: boolean,
    modelTriangleCount: number,
    buildWidthMm: number,
    buildDepthMm: number,
    layerHeightMm: number,
    totalLayers: number,
    trianglesXYZ: Float32Array,
    metadataJson: string,
    startLayer: number,
    layerCount: number,
  ) => Uint8Array;
};

type DragonfruitSlicerWasmRuntimeModule = DragonfruitSlicerWasmModule & {
  default?: (moduleOrPath?: string | URL | Request | Response | BufferSource | WebAssembly.Module) => Promise<unknown>;
};

let wasmModulePromise: Promise<DragonfruitSlicerWasmModule> | null = null;

async function loadSlicerWasmModule(): Promise<DragonfruitSlicerWasmModule> {
  if (!wasmModulePromise) {
    wasmModulePromise = (async () => {
      // Loaded from public runtime asset to avoid compile-time module resolution errors
      // when the generated wasm-bindgen JS does not exist yet.
      const runtimeModuleUrl = '/wasm/dragonfruit_slicer_wasm.js';
      const mod = (await import(/* webpackIgnore: true */ runtimeModuleUrl)) as DragonfruitSlicerWasmRuntimeModule;

      // wasm-bindgen runtime requires explicit initialization before calling exported functions.
      if (typeof mod.default === 'function') {
        await mod.default();
      }

      return mod;
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

export async function sliceSolidAndEncodeWithSlicerWasm(
  format: SlicingFormatDefinition,
  job: WasmSolidSliceJobEnvelope,
): Promise<Uint8Array> {
  const wasm = await loadSlicerWasmModule();

  if (typeof wasm.slice_solid_and_encode_raw === 'function') {
    return wasm.slice_solid_and_encode_raw(
      job.outputFormat,
      job.sourceWidthPx,
      job.sourceHeightPx,
      job.widthPx,
      job.heightPx,
      job.xPackingMode,
      job.pngCompressionStrategy,
      job.bvhAccelerationEnabled,
      job.antiAliasingLevel,
      job.aaOnSupports,
      job.modelTriangleCount,
      job.buildWidthMm,
      job.buildDepthMm,
      job.layerHeightMm,
      job.totalLayers,
      job.trianglesXYZ,
      job.metadataJson,
    );
  }

  const payload = JSON.stringify({
    output_format: job.outputFormat,
    source_width_px: job.sourceWidthPx,
    source_height_px: job.sourceHeightPx,
    width_px: job.widthPx,
    height_px: job.heightPx,
    x_packing_mode: job.xPackingMode,
    png_compression_strategy: job.pngCompressionStrategy,
    bvh_acceleration_enabled: job.bvhAccelerationEnabled,
    anti_aliasing_level: job.antiAliasingLevel,
    aa_on_supports: job.aaOnSupports,
    model_triangle_count: job.modelTriangleCount,
    build_width_mm: job.buildWidthMm,
    build_depth_mm: job.buildDepthMm,
    layer_height_mm: job.layerHeightMm,
    total_layers: job.totalLayers,
    triangles_xyz: Array.from(job.trianglesXYZ),
    metadata_json: job.metadataJson,
    format_id: format.id,
  });

  return wasm.slice_solid_and_encode_job(payload);
}

export async function sliceSolidLayersChunkWithSlicerWasm(
  job: WasmSolidSliceJobEnvelope,
  startLayer: number,
  layerCount: number,
): Promise<Uint8Array> {
  const wasm = await loadSlicerWasmModule();

  if (typeof wasm.slice_solid_layers_chunk_raw !== 'function') {
    throw new Error('WASM runtime is missing chunked solid slicing export (slice_solid_layers_chunk_raw). Rebuild wasm artifacts.');
  }

  return wasm.slice_solid_layers_chunk_raw(
    job.outputFormat,
    job.sourceWidthPx,
    job.sourceHeightPx,
    job.widthPx,
    job.heightPx,
    job.xPackingMode,
    job.pngCompressionStrategy,
    job.bvhAccelerationEnabled,
    job.antiAliasingLevel,
    job.aaOnSupports,
    job.modelTriangleCount,
    job.buildWidthMm,
    job.buildDepthMm,
    job.layerHeightMm,
    job.totalLayers,
    job.trianglesXYZ,
    job.metadataJson,
    startLayer,
    layerCount,
  );
}
