type TauriCoreModule = {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
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

let tauriCorePromise: Promise<TauriCoreModule | null> | null = null;

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

async function invokeWithAbort<T>(
  core: TauriCoreModule,
  command: string,
  args: Record<string, unknown>,
  abortSignal?: AbortSignal,
): Promise<T> {
  if (!abortSignal) {
    return core.invoke<T>(command, args);
  }

  if (abortSignal.aborted) {
    throw createAbortError();
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const finalize = () => {
      abortSignal.removeEventListener('abort', handleAbort);
    };

    const handleAbort = () => {
      if (settled) return;
      settled = true;
      finalize();
      reject(createAbortError());
    };

    abortSignal.addEventListener('abort', handleAbort, { once: true });

    core.invoke<T>(command, args)
      .then((result) => {
        if (settled) return;
        settled = true;
        finalize();
        resolve(result);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        finalize();
        reject(error);
      });
  });
}

export async function sliceSolidAndEncodeWithNativeSlicer(
  job: NativeSolidSliceJobEnvelope,
  abortSignal?: AbortSignal,
): Promise<Uint8Array> {
  const core = await loadTauriCore();
  if (!core) {
    throw new Error('Native slicer is only available in DragonFruit Desktop (Tauri runtime).');
  }

  const payload = JSON.stringify(toNativePayload(job));
  const result = await invokeWithAbort<number[]>(core, 'slice_solid_native', { jobJson: payload }, abortSignal);
  return Uint8Array.from(result);
}
