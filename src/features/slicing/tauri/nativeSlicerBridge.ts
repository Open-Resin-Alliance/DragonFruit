type TauriCoreModule = {
  invoke: <T>(cmd: string, args?: Record<string, unknown> | ArrayBuffer | Uint8Array, options?: { headers: HeadersInit }) => Promise<T>;
};

type TauriEventModule = {
  listen: <T>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>;
};

export type NativeSolidSliceJobEnvelope = {
  outputFormat: string;
  sourceWidthPx: number;
  sourceHeightPx: number;
  widthPx: number;
  heightPx: number;
  xPackingMode: 'none' | 'rgb8_div3' | 'gray3_div2';
  computeBackend?: 'auto' | 'cpu' | 'gpu';
  pngCompressionStrategy: 'fastest' | 'balanced' | 'smallest' | 'optimal';
  bvhAccelerationEnabled: boolean;
  antiAliasingLevel: 'Off' | '2x' | '4x' | '8x' | '16x';
  aaOnSupports: boolean;
  modelTriangleCount: number;
  containerCompressionLevel?: number;
  buildWidthMm: number;
  buildDepthMm: number;
  layerHeightMm: number;
  totalLayers: number;
  exportThumbnailPngBase64?: string | null;
  trianglesXYZ: Float32Array;
  metadataJson: string;
};

type NativeSolidSlicePayload = {
  output_format: string;
  source_width_px: number;
  source_height_px: number;
  width_px: number;
  height_px: number;
  x_packing_mode: 'none' | 'rgb8_div3' | 'gray3_div2';
  compute_backend: 'auto' | 'cpu' | 'gpu';
  png_compression_strategy: 'fastest' | 'balanced' | 'smallest' | 'optimal';
  bvh_acceleration_enabled: boolean;
  anti_aliasing_level: 'Off' | '2x' | '4x' | '8x' | '16x';
  aa_on_supports: boolean;
  model_triangle_count: number;
  container_compression_level: number;
  build_width_mm: number;
  build_depth_mm: number;
  layer_height_mm: number;
  total_layers: number;
  export_thumbnail_png_base64?: string | null;
  triangles_xyz: number[];
  metadata_json: string;
};

/** Metadata-only payload for the binary mesh staging path (no inline triangles). */
type NativeSolidSliceMetadataPayload = {
  output_format: string;
  source_width_px: number;
  source_height_px: number;
  width_px: number;
  height_px: number;
  png_compression_strategy: 'fastest' | 'balanced' | 'smallest' | 'optimal';
  anti_aliasing_level: 'Off' | '2x' | '4x' | '8x' | '16x';
  aa_on_supports: boolean;
  container_compression_level: number;
  build_width_mm: number;
  build_depth_mm: number;
  layer_height_mm: number;
  total_layers: number;
  export_thumbnail_png_base64?: string | null;
  metadata_json: string;
};

type SliceProgressEvent = {
  done: number;
  total: number;
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
    source_width_px: job.sourceWidthPx,
    source_height_px: job.sourceHeightPx,
    width_px: job.widthPx,
    height_px: job.heightPx,
    x_packing_mode: job.xPackingMode,
    compute_backend: job.computeBackend ?? 'auto',
    png_compression_strategy: job.pngCompressionStrategy,
    bvh_acceleration_enabled: job.bvhAccelerationEnabled,
    anti_aliasing_level: job.antiAliasingLevel,
    aa_on_supports: job.aaOnSupports,
    model_triangle_count: job.modelTriangleCount,
    container_compression_level: Math.max(0, Math.min(9, Math.round(job.containerCompressionLevel ?? 2))),
    build_width_mm: job.buildWidthMm,
    build_depth_mm: job.buildDepthMm,
    layer_height_mm: job.layerHeightMm,
    total_layers: job.totalLayers,
    export_thumbnail_png_base64: job.exportThumbnailPngBase64 ?? null,
    triangles_xyz: Array.from(job.trianglesXYZ),
    metadata_json: job.metadataJson,
  };
}

function toNativeMetadataPayload(job: NativeSolidSliceJobEnvelope): NativeSolidSliceMetadataPayload {
  return {
    output_format: job.outputFormat,
    source_width_px: job.sourceWidthPx,
    source_height_px: job.sourceHeightPx,
    width_px: job.widthPx,
    height_px: job.heightPx,
    png_compression_strategy: job.pngCompressionStrategy,
    anti_aliasing_level: job.antiAliasingLevel,
    aa_on_supports: job.aaOnSupports,
    container_compression_level: Math.max(0, Math.min(9, Math.round(job.containerCompressionLevel ?? 2))),
    build_width_mm: job.buildWidthMm,
    build_depth_mm: job.buildDepthMm,
    layer_height_mm: job.layerHeightMm,
    total_layers: job.totalLayers,
    export_thumbnail_png_base64: job.exportThumbnailPngBase64 ?? null,
    metadata_json: job.metadataJson,
  };
}

export async function isNativeSlicerAvailable(): Promise<boolean> {
  const core = await loadTauriCore();
  return Boolean(core);
}

export type SlicerProgressCallback = (done: number, total: number) => void;

export type NativeSliceTempPathArtifact = {
  tempPath: string;
  byteLen: number;
  perf: NativeSlicerPerfMetrics | null;
  runtime: NativeSlicerRuntimeMetrics | null;
  bridge: NativeSlicerBridgeMetrics;
};

export type NativeOpenDialogCategory = 'mesh' | 'scene';

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
  layers: number;
};

export type NativeSlicerRuntimeMetrics = {
  poolThreads: number;
  maxConcurrent: number;
  queueBuffer: number;
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
        onProgress(event.payload.done, event.payload.total);
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
        onProgress(event.payload.done, event.payload.total);
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
    // --- Step 1: Stage raw mesh bytes via binary IPC ---
    const payloadBuildStart = performance.now();
    // Zero-copy Uint8Array view of the underlying Float32Array buffer
    const meshBytes = new Uint8Array(
      job.trianglesXYZ.buffer,
      job.trianglesXYZ.byteOffset,
      job.trianglesXYZ.byteLength,
    );
    const meshBytesLen = meshBytes.byteLength;
    const metadataJson = JSON.stringify(toNativeMetadataPayload(job));
    const payloadBuildMs = performance.now() - payloadBuildStart;

    if (abortSignal?.aborted) {
      cleanup();
      throw createAbortError();
    }

    const stageStart = performance.now();
    await core.invoke<number>('stage_mesh_binary', meshBytes, {
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    const stageMeshMs = performance.now() - stageStart;

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
): Promise<Uint8Array> {
  const core = await loadTauriCore();
  if (!core) {
    throw new Error('Native slicer is only available in DragonFruit Desktop (Tauri runtime).');
  }

  const safeLayerNumber = Math.max(1, Math.floor(layerNumber));
  const result = await core.invoke<ArrayBuffer>('read_print_layer_png', {
    sourcePath,
    layerNumber: safeLayerNumber,
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
