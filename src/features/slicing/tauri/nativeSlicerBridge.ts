type TauriCoreModule = {
  invoke: <T>(cmd: string, args?: Record<string, unknown> | ArrayBuffer | Uint8Array, options?: { headers: HeadersInit }) => Promise<T>;
};

type TauriEventModule = {
  listen: <T>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>;
};

export type AntiAliasingLevel = 'Off' | `${number}x`;

export type NativeSolidSliceJobEnvelope = {
  outputFormat: string;
  formatVersion?: string | null;
  outputPath?: string | null;
  sourceWidthPx: number;
  sourceHeightPx: number;
  widthPx: number;
  heightPx: number;
  xPackingMode: 'none' | 'rgb8_div3' | 'gray3_div2';
  computeBackend?: 'auto' | 'cpu' | 'gpu';
  pngCompressionStrategy: 'fastest' | 'balanced' | 'smallest' | 'optimal';
  bvhAccelerationEnabled: boolean;
  antiAliasingLevel: AntiAliasingLevel;
  antiAliasingMode: 'Blur' | '3DAA' | 'Vertical2' | 'Coverage';
  blurBrushRadiusPx: number;
  blurBrushKernel?: 'box' | 'gaussian';
  blurBrushSigma?: number;
  blurBrushSigmaX?: number;
  blurBrushSigmaY?: number;
  zBlurRadiusLayers?: number;
  zBlurKernel?: 'box' | 'gaussian';
  zBlurSigma?: number;
  aaOnSupports: boolean;
  minimumAaAlphaPercent: number;
  mirrorX: boolean;
  mirrorY: boolean;
  zBlendLookBack?: number;
  zBlendFadePx?: number;
  zBlendAutoFade?: boolean;
  zBlendMinimumAlphaPercent?: number;
  zBlendMaxAlphaPercent?: number;
  zBlendCustomLut?: number[];
  zaaKernel?: 'perturb';
  zaaPattern?: 'uniform' | 'halton' | 'base2';
  zaaDuplicateZ?: boolean;
  modelTriangleCount: number;
  containerCompressionLevel?: number;
  buildWidthMm: number;
  buildDepthMm: number;
  layerHeightMm: number;
  totalLayers: number;
  exportThumbnailPngBase64?: string | null;
  trianglesXYZ: Float32Array;
  meshEncoding?: 'raw_f32' | 'quantized_u16';
  meshQuantization?: {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
  } | null;
  metadataJson: string;
  ditherEnabled?: boolean;
  ditherBitDepth?: number;
  ditherDeviceGamma?: number;
};

type NativeSolidSlicePayload = {
  output_format: string;
  format_version?: string | null;
  source_width_px: number;
  source_height_px: number;
  width_px: number;
  height_px: number;
  x_packing_mode: 'none' | 'rgb8_div3' | 'gray3_div2';
  compute_backend: 'auto' | 'cpu' | 'gpu';
  png_compression_strategy: 'fastest' | 'balanced' | 'smallest' | 'optimal';
  bvh_acceleration_enabled: boolean;
  anti_aliasing_level: AntiAliasingLevel;
  anti_aliasing_mode: 'Blur' | '3DAA' | 'Vertical2' | 'Coverage';
  blur_brush_radius_px: number;
  blur_brush_kernel: 'box' | 'gaussian';
  blur_brush_sigma_x: number;
  blur_brush_sigma_y: number;
  z_blur_radius_layers: number;
  z_blur_kernel: 'box' | 'gaussian';
  z_blur_sigma: number;
  aa_on_supports: boolean;
  minimum_aa_alpha_percent: number;
  mirror_x: boolean;
  mirror_y: boolean;
  z_blend_look_back?: number;
  z_blend_fade_px?: number;
  z_blend_auto_fade?: boolean;
  z_blend_minimum_alpha_percent?: number;
  z_blend_max_alpha_percent?: number;
  z_blend_custom_lut?: number[];
  zaa_kernel?: 'perturb';
  zaa_pattern?: 'uniform' | 'halton' | 'base2';
  zaa_duplicate_z?: boolean;
  model_triangle_count: number;
  container_compression_level: number;
  build_width_mm: number;
  build_depth_mm: number;
  layer_height_mm: number;
  total_layers: number;
  export_thumbnail_png_base64?: string | null;
  triangles_xyz: number[];
  mesh_encoding?: 'raw_f32' | 'quantized_u16';
  mesh_quantization?: {
    min_x: number;
    min_y: number;
    min_z: number;
    max_x: number;
    max_y: number;
    max_z: number;
  } | null;
  metadata_json: string;
  dither_enabled?: boolean;
  dither_bit_depth?: number | null;
  dither_device_gamma?: number;
};

/** Metadata-only payload for the binary mesh staging path (no inline triangles). */
type NativeSolidSliceMetadataPayload = {
  output_format: string;
  format_version?: string | null;
  output_path?: string | null;
  source_width_px: number;
  source_height_px: number;
  width_px: number;
  height_px: number;
  x_packing_mode: 'none' | 'rgb8_div3' | 'gray3_div2';
  png_compression_strategy: 'fastest' | 'balanced' | 'smallest' | 'optimal';
  anti_aliasing_level: AntiAliasingLevel;
  anti_aliasing_mode: 'Blur' | '3DAA' | 'Vertical2' | 'Coverage';
  blur_brush_radius_px: number;
  blur_brush_kernel: 'box' | 'gaussian';
  blur_brush_sigma_x: number;
  blur_brush_sigma_y: number;
  z_blur_radius_layers: number;
  z_blur_kernel: 'box' | 'gaussian';
  z_blur_sigma: number;
  aa_on_supports: boolean;
  minimum_aa_alpha_percent: number;
  mirror_x: boolean;
  mirror_y: boolean;
  z_blend_look_back?: number;
  z_blend_fade_px?: number;
  z_blend_auto_fade?: boolean;
  z_blend_minimum_alpha_percent?: number;
  z_blend_max_alpha_percent?: number;
  z_blend_custom_lut?: number[];
  zaa_kernel?: 'perturb';
  zaa_pattern?: 'uniform' | 'halton' | 'base2';
  zaa_duplicate_z?: boolean;
  model_triangle_count: number;
  container_compression_level: number;
  build_width_mm: number;
  build_depth_mm: number;
  layer_height_mm: number;
  total_layers: number;
  export_thumbnail_png_base64?: string | null;
  mesh_encoding?: 'raw_f32' | 'quantized_u16';
  mesh_quantization?: {
    min_x: number;
    min_y: number;
    min_z: number;
    max_x: number;
    max_y: number;
    max_z: number;
  } | null;
  metadata_json: string;
  dither_enabled?: boolean;
  dither_bit_depth?: number | null;
  dither_device_gamma?: number;
};

type SliceProgressEvent = {
  done: number;
  total: number;
  phase?: string;
};

let tauriCorePromise: Promise<TauriCoreModule | null> | null = null;
let tauriEventPromise: Promise<TauriEventModule | null> | null = null;

function createAbortError(message = 'Slicing canceled by user.'): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException(message, 'AbortError');
  }

  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return '__TAURI_INTERNALS__' in window;
}

async function loadTauriCore(): Promise<TauriCoreModule | null> {
  if (!isTauriRuntime()) return null;
  if (!tauriCorePromise) {
    tauriCorePromise = import('@tauri-apps/api/core')
      .then((mod) => ({ invoke: mod.invoke }))
      .catch(() => null);
  }

  return tauriCorePromise;
}

async function loadTauriEvent(): Promise<TauriEventModule | null> {
  if (!isTauriRuntime()) return null;
  if (!tauriEventPromise) {
    tauriEventPromise = import('@tauri-apps/api/event')
      .then((mod) => ({ listen: mod.listen }))
      .catch(() => null);
  }

  return tauriEventPromise;
}

function toNativePayload(job: NativeSolidSliceJobEnvelope): NativeSolidSlicePayload {
  return {
    output_format: job.outputFormat,
    format_version: job.formatVersion ?? null,
    source_width_px: job.sourceWidthPx,
    source_height_px: job.sourceHeightPx,
    width_px: job.widthPx,
    height_px: job.heightPx,
    x_packing_mode: job.xPackingMode,
    compute_backend: job.computeBackend ?? 'auto',
    png_compression_strategy: job.pngCompressionStrategy,
    bvh_acceleration_enabled: job.bvhAccelerationEnabled,
    anti_aliasing_level: job.antiAliasingLevel,
    anti_aliasing_mode: job.antiAliasingMode,
    blur_brush_radius_px: Math.max(1, Math.round(job.blurBrushRadiusPx ?? 1)),
    blur_brush_kernel: job.blurBrushKernel ?? 'gaussian',
    blur_brush_sigma_x: Math.max(0.05, Math.min(16, Number(job.blurBrushSigmaX ?? job.blurBrushSigma ?? 0.5))),
    blur_brush_sigma_y: Math.max(0.05, Math.min(16, Number(job.blurBrushSigmaY ?? job.blurBrushSigma ?? 0.5))),
    z_blur_radius_layers: Math.max(0, Math.min(8, Math.round(job.zBlurRadiusLayers ?? 0))),
    z_blur_kernel: job.zBlurKernel ?? 'box',
    z_blur_sigma: Math.max(0.05, Math.min(16, Number(job.zBlurSigma ?? 0.5))),
    aa_on_supports: job.aaOnSupports,
    minimum_aa_alpha_percent: Math.max(0, Math.min(100, Number(job.minimumAaAlphaPercent) || 0)),
    mirror_x: job.mirrorX,
    mirror_y: job.mirrorY,
    z_blend_look_back: Math.max(1, Math.round(job.zBlendLookBack ?? 2)),
    z_blend_fade_px: Math.max(1, Math.round(job.zBlendFadePx ?? 20)),
    z_blend_auto_fade: job.zBlendAutoFade !== false,
    z_blend_minimum_alpha_percent: Math.max(0, Math.min(100, Number(job.zBlendMinimumAlphaPercent ?? 0))),
    z_blend_max_alpha_percent: Math.max(0, Math.min(100, Number(job.zBlendMaxAlphaPercent ?? 90))),
    z_blend_custom_lut: job.zBlendCustomLut,
    zaa_kernel: job.zaaKernel,
    zaa_pattern: job.zaaPattern,
    zaa_duplicate_z: job.zaaDuplicateZ,
    model_triangle_count: job.modelTriangleCount,
    container_compression_level: Math.max(0, Math.min(9, Math.round(job.containerCompressionLevel ?? 2))),
    build_width_mm: job.buildWidthMm,
    build_depth_mm: job.buildDepthMm,
    layer_height_mm: job.layerHeightMm,
    total_layers: job.totalLayers,
    export_thumbnail_png_base64: job.exportThumbnailPngBase64 ?? null,
    triangles_xyz: Array.from(job.trianglesXYZ),
    mesh_encoding: job.meshEncoding ?? 'raw_f32',
    mesh_quantization: job.meshQuantization
      ? {
          min_x: job.meshQuantization.minX,
          min_y: job.meshQuantization.minY,
          min_z: job.meshQuantization.minZ,
          max_x: job.meshQuantization.maxX,
          max_y: job.meshQuantization.maxY,
          max_z: job.meshQuantization.maxZ,
        }
      : null,
    metadata_json: job.metadataJson,
    dither_enabled: job.ditherEnabled ?? false,
    dither_bit_depth: job.ditherBitDepth ?? null,
    dither_device_gamma: job.ditherDeviceGamma ?? 3.0,
  };
}

function toNativeMetadataPayload(job: NativeSolidSliceJobEnvelope): NativeSolidSliceMetadataPayload {
  return {
    output_format: job.outputFormat,
    format_version: job.formatVersion ?? null,
    output_path: job.outputPath?.trim() || null,
    source_width_px: job.sourceWidthPx,
    source_height_px: job.sourceHeightPx,
    width_px: job.widthPx,
    height_px: job.heightPx,
    x_packing_mode: job.xPackingMode,
    png_compression_strategy: job.pngCompressionStrategy,
    anti_aliasing_level: job.antiAliasingLevel,
    anti_aliasing_mode: job.antiAliasingMode,
    blur_brush_radius_px: Math.max(1, Math.round(job.blurBrushRadiusPx ?? 1)),
    blur_brush_kernel: job.blurBrushKernel ?? 'gaussian',
    blur_brush_sigma_x: Math.max(0.05, Math.min(16, Number(job.blurBrushSigmaX ?? job.blurBrushSigma ?? 0.5))),
    blur_brush_sigma_y: Math.max(0.05, Math.min(16, Number(job.blurBrushSigmaY ?? job.blurBrushSigma ?? 0.5))),
    z_blur_radius_layers: Math.max(0, Math.min(8, Math.round(job.zBlurRadiusLayers ?? 0))),
    z_blur_kernel: job.zBlurKernel ?? 'box',
    z_blur_sigma: Math.max(0.05, Math.min(16, Number(job.zBlurSigma ?? 0.5))),
    aa_on_supports: job.aaOnSupports,
    minimum_aa_alpha_percent: Math.max(0, Math.min(100, Number(job.minimumAaAlphaPercent) || 0)),
    mirror_x: job.mirrorX,
    mirror_y: job.mirrorY,
    z_blend_look_back: Math.max(1, Math.round(job.zBlendLookBack ?? 2)),
    z_blend_fade_px: Math.max(1, Math.round(job.zBlendFadePx ?? 20)),
    z_blend_auto_fade: job.zBlendAutoFade !== false,
    z_blend_minimum_alpha_percent: Math.max(0, Math.min(100, Number(job.zBlendMinimumAlphaPercent ?? 0))),
    z_blend_max_alpha_percent: Math.max(0, Math.min(100, Number(job.zBlendMaxAlphaPercent ?? 90))),
    z_blend_custom_lut: job.zBlendCustomLut,
    zaa_kernel: job.zaaKernel,
    zaa_pattern: job.zaaPattern,
    zaa_duplicate_z: job.zaaDuplicateZ,
    model_triangle_count: Math.max(0, Math.floor(job.modelTriangleCount ?? 0)),
    container_compression_level: Math.max(0, Math.min(9, Math.round(job.containerCompressionLevel ?? 2))),
    build_width_mm: job.buildWidthMm,
    build_depth_mm: job.buildDepthMm,
    layer_height_mm: job.layerHeightMm,
    total_layers: job.totalLayers,
    export_thumbnail_png_base64: job.exportThumbnailPngBase64 ?? null,
    mesh_encoding: job.meshEncoding ?? 'raw_f32',
    mesh_quantization: job.meshQuantization
      ? {
          min_x: job.meshQuantization.minX,
          min_y: job.meshQuantization.minY,
          min_z: job.meshQuantization.minZ,
          max_x: job.meshQuantization.maxX,
          max_y: job.meshQuantization.maxY,
          max_z: job.meshQuantization.maxZ,
        }
      : null,
    metadata_json: job.metadataJson,
    dither_enabled: job.ditherEnabled ?? false,
    dither_bit_depth: job.ditherBitDepth ?? null,
    dither_device_gamma: job.ditherDeviceGamma ?? 3.0,
  };
}

export async function isNativeSlicerAvailable(): Promise<boolean> {
  const core = await loadTauriCore();
  return Boolean(core);
}

export async function getSlicerEngineVersion(): Promise<string | null> {
  const core = await loadTauriCore();
  if (!core) return null;
  return core.invoke<string>('get_slicer_engine_version');
}

export type SlicerProgressCallback = (done: number, total: number, phase: string) => void;

export type NativeSliceTempPathArtifact = {
  tempPath: string;
  byteLen: number;
  perf: NativeSlicerPerfMetrics | null;
  runtime: NativeSlicerRuntimeMetrics | null;
  bridge: NativeSlicerBridgeMetrics;
};

export type NativeOpenDialogCategory = 'mesh' | 'scene' | 'bundle';

export type NativeSaveDialogFilter = {
  name: string;
  extensions: string[];
};

export type NativePickedOpenFile = {
  path: string;
  name: string;
};

export type NativeSlicerBridgeMetrics = {
  payloadBuildMs: number;
  invokeRoundTripMs: number;
  bridgeTotalMs: number;
  payloadChars: number;
  triangleFloatCount: number;
  /** Raw binary mesh size in bytes (Float32Array.byteLength). */
  meshBytesLen: number;
  /** Time to stage mesh binary via IPC (ms). */
  stageMeshMs: number;
};

export type NativeSlicerPerfMetrics = {
  totalNs: number;
  indexBuildNs: number;
  renderWallNs: number;
  renderNs: number;
  pngEncodeNs: number;
  archiveEncodeNs: number;
  zBlendBackwardNs: number;
  zBlendForwardNs: number;
  crossBlendNs: number;
  crossBlendTouchedPixels: number;
  crossBlendContributingLayers: number;
  postBlurNs: number;
  supportMergeNs: number;
  layers: number;
};

export type NativeSlicerRuntimeMetrics = {
  poolThreads: number;
  maxConcurrent: number;
  queueBuffer: number;
  daaPostThreads?: number;
  daaPostBufferDepth?: number;
  buildProfile?: 'debug' | 'release' | string;
  artifactDir?: string;
  meshStageDir?: string;
  metadataParseNs?: number;
  meshDecodeNs?: number;
  artifactMetadataNs?: number;
  wrapperTotalNs?: number;
  wrapperOverheadNs?: number;
};

/**
 * Invoke the native slicer with real per-layer progress events and cooperative cancellation.
 */
export async function sliceSolidAndEncodeWithNativeSlicer(
  job: NativeSolidSliceJobEnvelope,
  abortSignal?: AbortSignal,
  onProgress?: SlicerProgressCallback,
): Promise<Uint8Array> {
  const core = await loadTauriCore();
  if (!core) {
    throw new Error('Native slicer is only available in DragonFruit Desktop (Tauri runtime).');
  }

  if (abortSignal?.aborted) {
    throw createAbortError();
  }

  // Subscribe to real per-layer progress events from the Rust backend
  const eventModule = await loadTauriEvent();
  let unlistenProgress: (() => void) | null = null;

  if (eventModule && onProgress) {
    unlistenProgress = await eventModule.listen<SliceProgressEvent>(
      'slicer://progress',
      (event) => {
        onProgress(event.payload.done, event.payload.total, event.payload.phase ?? 'Slicing');
      },
    );
  }

  // Set up abort handler: sends cancel_slicing command to Rust then rejects
  let settled = false;
  const payload = JSON.stringify(toNativePayload(job));

  const cleanup = () => {
    if (unlistenProgress) {
      unlistenProgress();
      unlistenProgress = null;
    }
  };

  try {
    const resultPromise = core.invoke<ArrayBuffer>('slice_solid_native', { jobJson: payload });

    if (!abortSignal) {
      const result = await resultPromise;
      cleanup();
      return new Uint8Array(result);
    }

    // Race the invoke against the abort signal
    const result = await new Promise<ArrayBuffer>((resolve, reject) => {
      const handleAbort = () => {
        if (settled) return;
        settled = true;
        // Tell Rust to stop
        core.invoke('cancel_slicing').catch(() => {});
        reject(createAbortError());
      };

      abortSignal.addEventListener('abort', handleAbort, { once: true });

      resultPromise
        .then((res) => {
          if (settled) return;
          settled = true;
          abortSignal.removeEventListener('abort', handleAbort);
          resolve(res);
        })
        .catch((err) => {
          if (settled) return;
          settled = true;
          abortSignal.removeEventListener('abort', handleAbort);
          // Rust cancelled errors should map to AbortError
          if (typeof err === 'string' && err.includes('cancelled')) {
            reject(createAbortError());
          } else {
            reject(err);
          }
        });
    });

    cleanup();
    return new Uint8Array(result);
  } catch (error) {
    cleanup();
    throw error;
  }
}

/**
 * Invoke the native slicer and keep the encoded artifact on disk,
 * returning temp file metadata instead of the full byte buffer.
 *
 * Uses a two-step binary staging protocol:
 *   1. Stage raw mesh bytes via efficient binary IPC (no JSON serialization)
 *   2. Send tiny metadata JSON to kick off slicing
 */
export async function sliceSolidAndEncodeWithNativeSlicerToTempPath(
  job: NativeSolidSliceJobEnvelope,
  abortSignal?: AbortSignal,
  onProgress?: SlicerProgressCallback,
): Promise<NativeSliceTempPathArtifact> {
  const bridgeStart = performance.now();
  const core = await loadTauriCore();
  if (!core) {
    throw new Error('Native slicer is only available in DragonFruit Desktop (Tauri runtime).');
  }

  if (abortSignal?.aborted) {
    throw createAbortError();
  }

  const eventModule = await loadTauriEvent();
  let unlistenProgress: (() => void) | null = null;

  if (eventModule && onProgress) {
    unlistenProgress = await eventModule.listen<SliceProgressEvent>(
      'slicer://progress',
      (event) => {
        onProgress(event.payload.done, event.payload.total, event.payload.phase ?? 'Slicing');
      },
    );
  }

  const triangleFloatCount = job.trianglesXYZ.length;

  const cleanup = () => {
    if (unlistenProgress) {
      unlistenProgress();
      unlistenProgress = null;
    }
  };

  try {
    // --- Step 1: Compute Payload Stats ---
    const payloadBuildStart = performance.now();
    const metadataJson = JSON.stringify(toNativeMetadataPayload(job));

    const meshBytesLen = job.trianglesXYZ.byteLength;
    const stageMeshMs = 0; // Handled concurrently by Orchestrator now!

    // Release the JS-side empty array 
    job.trianglesXYZ = new Float32Array(0);

    const payloadBuildMs = performance.now() - payloadBuildStart;

    if (abortSignal?.aborted) {
      cleanup();
      throw createAbortError();
    }

    // --- Step 2: Send tiny metadata JSON to kick off slicing ---

    if (abortSignal?.aborted) {
      cleanup();
      throw createAbortError();
    }

    let settled = false;
    const invokeStart = performance.now();
    const resultPromise = core.invoke<{
      tempPath: string;
      byteLen: number;
      perf?: NativeSlicerPerfMetrics | null;
      runtime?: NativeSlicerRuntimeMetrics | null;
    }>('slice_solid_native_to_temp_path', { jobJson: metadataJson });

    const buildResult = (result: {
      tempPath: string;
      byteLen: number;
      perf?: NativeSlicerPerfMetrics | null;
      runtime?: NativeSlicerRuntimeMetrics | null;
    }): NativeSliceTempPathArtifact => ({
      tempPath: result.tempPath,
      byteLen: Number.isFinite(result.byteLen) ? result.byteLen : 0,
      perf: result.perf ?? null,
      runtime: result.runtime ?? null,
      bridge: {
        payloadBuildMs,
        invokeRoundTripMs: performance.now() - invokeStart,
        bridgeTotalMs: performance.now() - bridgeStart,
        payloadChars: metadataJson.length,
        triangleFloatCount,
        meshBytesLen,
        stageMeshMs,
      },
    });

    if (!abortSignal) {
      const result = await resultPromise;
      cleanup();
      return buildResult(result);
    }

    const result = await new Promise<{
      tempPath: string;
      byteLen: number;
      perf?: NativeSlicerPerfMetrics | null;
      runtime?: NativeSlicerRuntimeMetrics | null;
    }>((resolve, reject) => {
      const handleAbort = () => {
        if (settled) return;
        settled = true;
        core.invoke('cancel_slicing').catch(() => {});
        reject(createAbortError());
      };

      abortSignal.addEventListener('abort', handleAbort, { once: true });

      resultPromise
        .then((res) => {
          if (settled) return;
          settled = true;
          abortSignal.removeEventListener('abort', handleAbort);
          resolve(res);
        })
        .catch((err) => {
          if (settled) return;
          settled = true;
          abortSignal.removeEventListener('abort', handleAbort);
          if (typeof err === 'string' && err.includes('cancelled')) {
            reject(createAbortError());
          } else {
            reject(err);
          }
        });
    });

    cleanup();
    return buildResult(result);
  } catch (error) {
    cleanup();
    throw error;
  }
}

export async function savePrintArtifactWithNativeDialog(
  bytes: Uint8Array,
  defaultFilename: string,
): Promise<string> {
  const core = await loadTauriCore();
  if (!core) {
    throw new Error('Native save dialog is only available in DragonFruit Desktop (Tauri runtime).');
  }

  const path = await core.invoke<string>('save_print_file', {
    args: {
      defaultFilename,
      bytes: Uint8Array.from(bytes),
    },
  });

  return path;
}

export async function savePrintArtifactPathWithNativeDialog(
  sourcePath: string,
  defaultFilename: string,
): Promise<string> {
  const core = await loadTauriCore();
  if (!core) {
    throw new Error('Native save dialog is only available in DragonFruit Desktop (Tauri runtime).');
  }

  const path = await core.invoke<string>('save_print_file_from_path', {
    args: {
      defaultFilename,
      sourcePath,
    },
  });

  return path;
}

export async function pickSavePathWithNativeDialog(defaultFilename: string): Promise<string> {
  const core = await loadTauriCore();
  if (!core) {
    throw new Error('Native save dialog is only available in DragonFruit Desktop (Tauri runtime).');
  }

  return core.invoke<string>('pick_save_path', {
    args: {
      defaultFilename,
    },
  });
}

export async function pickSavePathWithNativeDialogOptions(
  defaultFilename: string,
  options?: {
    filters?: NativeSaveDialogFilter[];
  },
): Promise<string> {
  const core = await loadTauriCore();
  if (!core) {
    throw new Error('Native save dialog is only available in DragonFruit Desktop (Tauri runtime).');
  }

  return core.invoke<string>('pick_save_path', {
    args: {
      defaultFilename,
      filters: options?.filters,
    },
  });
}

export async function pickDirectoryWithNativeDialog(currentPath?: string): Promise<string> {
  const core = await loadTauriCore();
  if (!core) {
    throw new Error('Native folder picker is only available in DragonFruit Desktop (Tauri runtime).');
  }

  return core.invoke<string>('local_backup_pick_directory', {
    currentPath: currentPath?.trim() || undefined,
  });
}

export async function pickOpenFilesWithNativeDialog(
  category: NativeOpenDialogCategory,
  multiple = false,
): Promise<NativePickedOpenFile[]> {
  const core = await loadTauriCore();
  if (!core) {
    throw new Error('Native open dialog is only available in DragonFruit Desktop (Tauri runtime).');
  }

  return core.invoke<NativePickedOpenFile[]>('pick_open_files', {
    args: {
      category,
      multiple,
    },
  });
}

export async function writeBytesToNativePath(
  destinationPath: string,
  bytes: Uint8Array,
): Promise<string> {
  const core = await loadTauriCore();
  if (!core) {
    throw new Error('Native file writing is only available in DragonFruit Desktop (Tauri runtime).');
  }

  return core.invoke<string>('write_bytes_to_path', {
    args: {
      destinationPath,
      bytes: Uint8Array.from(bytes),
    },
  });
}

/**
 * Writes `bytes` to `destinationPath` using the raw-binary `append_mesh_stage_chunk` IPC command,
 * sending the data in chunks to avoid JSON-encoding the entire buffer over IPC.
 * Each call sequences through chunks of `chunkSize` bytes (default 4 MB).
 * The first chunk truncates/creates the file; subsequent chunks append to it.
 */
export async function writeChunkedToNativePath(
  destinationPath: string,
  bytes: Uint8Array,
  chunkSize = 4 * 1024 * 1024,
): Promise<void> {
  const core = await loadTauriCore();
  if (!core) {
    throw new Error('Chunked file writing is only available in DragonFruit Desktop (Tauri runtime).');
  }

  try {
    let offset = 0;
    while (offset < bytes.length) {
      const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
      await core.invoke<number>('append_mesh_stage_chunk', chunk, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'x-mesh-stage-path': destinationPath,
          'x-mesh-stage-offset': String(offset),
        },
      });
      offset += chunk.length;
    }
  } finally {
    // Always close the backend writer for this path so the destination file
    // handle is released immediately (important for Explorer thumbnail reads).
    try {
      await core.invoke<number>('finish_mesh_stage_write', {
        path: destinationPath,
      });
    } catch (error) {
      console.warn('[nativeSlicerBridge] Failed finishing chunked write appender.', error);
    }
  }
}

/**
 * Asks the Rust backend to allocate a unique temporary staging file path.
 * The returned path lives in the system temp directory.
 */
export async function allocateMeshStagePath(): Promise<string> {
  const core = await loadTauriCore();
  if (!core) {
    throw new Error('allocateMeshStagePath is only available in DragonFruit Desktop (Tauri runtime).');
  }
  return core.invoke<string>('allocate_mesh_stage_path');
}

/**
 * Exports staged raw geometry to a properly formatted mesh file (STL / 3MF).
 *
 * The staging file must contain raw triangle vertex data: 9 × f32 (LE) per
 * triangle (v0xyz, v1xyz, v2xyz), written via `writeChunkedToNativePath`.
 *
 * For 3MF, Rust uses the `zip` crate with DEFLATE compression — XML text
 * compresses ~10–20× so the output is compact (often smaller than STL).
 *
 * @returns The destination path on success.
 */
export async function exportMeshFile(
  stagingPath: string,
  destPath: string,
  format: 'stl' | '3mf',
): Promise<string> {
  const core = await loadTauriCore();
  if (!core) {
    throw new Error('exportMeshFile is only available in DragonFruit Desktop (Tauri runtime).');
  }
  return core.invoke<string>('export_mesh_file', {
    stagingPath,
    destPath,
    format,
  });
}

export async function readPrintArtifactBytesFromPath(sourcePath: string): Promise<Uint8Array> {
  const core = await loadTauriCore();
  if (!core) {
    throw new Error('Native slicer is only available in DragonFruit Desktop (Tauri runtime).');
  }

  const result = await core.invoke<ArrayBuffer>('read_print_file_bytes', {
    sourcePath,
  });

  return new Uint8Array(result);
}

export async function readPrintLayerPreviewPngFromPath(
  sourcePath: string,
  layerNumber: number,
  formatHint: string,
): Promise<Uint8Array> {
  const core = await loadTauriCore();
  if (!core) {
    throw new Error('Native slicer is only available in DragonFruit Desktop (Tauri runtime).');
  }

  const safeLayerNumber = Math.max(1, Math.floor(layerNumber));
  const result = await core.invoke<ArrayBuffer>('read_print_layer_png', {
    sourcePath,
    layerNumber: safeLayerNumber,
    formatHint,
  });

  return new Uint8Array(result);
}

export async function deletePrintTempArtifactPath(sourcePath: string): Promise<boolean> {
  const core = await loadTauriCore();
  if (!core) {
    return false;
  }

  return core.invoke<boolean>('delete_print_temp_file', {
    sourcePath,
  });
}

export async function cleanupStalePrintTempArtifacts(maxAgeSeconds: number): Promise<number> {
  const core = await loadTauriCore();
  if (!core) {
    return 0;
  }

  const safeAge = Math.max(60, Math.floor(maxAgeSeconds));
  return core.invoke<number>('cleanup_stale_print_temp_files', {
    maxAgeSeconds: safeAge,
  });
}

export async function cleanupAllPrintTempArtifacts(): Promise<number> {
  const core = await loadTauriCore();
  if (!core) {
    return 0;
  }

  return core.invoke<number>('cleanup_all_print_temp_files');
}

/**
 * Launch an external executable with a file path argument (e.g., UVTools).
 * This is a fire-and-forget spawn — the UI does not wait for the process to exit.
 */
export async function launchExternalProcess(exePath: string, fileArg: string): Promise<void> {
  const core = await loadTauriCore();
  if (!core) {
    console.warn('[launchExternalProcess] Not available outside Tauri runtime.');
    return;
  }

  await core.invoke<void>('launch_external_process', {
    exePath,
    fileArg,
  });
}
