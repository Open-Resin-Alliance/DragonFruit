type TauriCoreModule = {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
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

type NativeSolidSlicePayload = {
  output_format: string;
  source_width_px: number;
  source_height_px: number;
  width_px: number;
  height_px: number;
  x_packing_mode: 'none' | 'rgb8_div3' | 'gray3_div2';
  png_compression_strategy: 'fastest' | 'balanced' | 'smallest' | 'optimal';
  bvh_acceleration_enabled: boolean;
  anti_aliasing_level: 'Off' | '2x' | '4x' | '8x';
  aa_on_supports: boolean;
  model_triangle_count: number;
  build_width_mm: number;
  build_depth_mm: number;
  layer_height_mm: number;
  total_layers: number;
  triangles_xyz: number[];
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
  };
}

export async function isNativeSlicerAvailable(): Promise<boolean> {
  const core = await loadTauriCore();
  return Boolean(core);
}

export type SlicerProgressCallback = (done: number, total: number) => void;

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
