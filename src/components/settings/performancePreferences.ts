export type SlicingComputeBackendPreference = 'auto' | 'cpu' | 'webgpu';
export type SlicingCpuProfile = 'balanced' | 'max';
export type SlicingProgressGranularity = 'balanced' | 'granular';
export type SlicingDebugForceBackend = 'none' | 'cpu' | 'webgpu';

export type SlicingPerformanceSettings = {
  computeBackend: SlicingComputeBackendPreference;
  cpuProfile: SlicingCpuProfile;
  progressGranularity: SlicingProgressGranularity;
  debugMode: boolean;
  debugForceBackend: SlicingDebugForceBackend;
  benchmarkingMode: boolean;
};

export type WebGpuSupportDetails = {
  supported: boolean;
  message: string;
};

export const SLICING_PERFORMANCE_SETTINGS_STORAGE_KEY = 'app-slicing-performance-settings';
const SLICING_PERFORMANCE_SETTINGS_EVENT = 'app-slicing-performance-settings-changed';

export const DEFAULT_SLICING_PERFORMANCE_SETTINGS: SlicingPerformanceSettings = {
  computeBackend: 'auto',
  cpuProfile: 'max',
  progressGranularity: 'granular',
  debugMode: false,
  debugForceBackend: 'none',
  benchmarkingMode: false,
};

export function normalizeSlicingPerformanceSettings(input: unknown): SlicingPerformanceSettings {
  if (!input || typeof input !== 'object') return DEFAULT_SLICING_PERFORMANCE_SETTINGS;

  const candidate = input as Partial<SlicingPerformanceSettings>;

  const computeBackend: SlicingComputeBackendPreference =
    candidate.computeBackend === 'cpu' || candidate.computeBackend === 'webgpu'
      ? candidate.computeBackend
      : 'auto';

  const cpuProfile: SlicingCpuProfile =
    candidate.cpuProfile === 'balanced' ? 'balanced' : 'max';

  const progressGranularity: SlicingProgressGranularity =
    candidate.progressGranularity === 'balanced' ? 'balanced' : 'granular';

  const debugForceBackend: SlicingDebugForceBackend =
    candidate.debugForceBackend === 'cpu' || candidate.debugForceBackend === 'webgpu'
      ? candidate.debugForceBackend
      : 'none';

  const debugMode = candidate.debugMode === true;
  const benchmarkingMode = candidate.benchmarkingMode === true;

  return {
    computeBackend,
    cpuProfile,
    progressGranularity,
    debugMode,
    debugForceBackend,
    benchmarkingMode,
  };
}

export function getSavedSlicingPerformanceSettings(): SlicingPerformanceSettings {
  if (typeof window === 'undefined') return DEFAULT_SLICING_PERFORMANCE_SETTINGS;

  try {
    const raw = window.localStorage.getItem(SLICING_PERFORMANCE_SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_SLICING_PERFORMANCE_SETTINGS;
    return normalizeSlicingPerformanceSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_SLICING_PERFORMANCE_SETTINGS;
  }
}

export function saveSlicingPerformanceSettings(settings: SlicingPerformanceSettings): void {
  if (typeof window === 'undefined') return;

  const normalized = normalizeSlicingPerformanceSettings(settings);
  try {
    window.localStorage.setItem(SLICING_PERFORMANCE_SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // ignore storage failures
  }

  window.dispatchEvent(new CustomEvent(SLICING_PERFORMANCE_SETTINGS_EVENT, { detail: normalized }));
}

export async function getWebGpuSupportDetails(): Promise<WebGpuSupportDetails> {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return {
      supported: false,
      message: 'WebGPU check requires a browser runtime.',
    };
  }

  if (window.isSecureContext === false) {
    const host = window.location.hostname || 'unknown-host';
    const protocol = window.location.protocol || 'unknown-protocol';
    const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1';

    return {
      supported: false,
      message: isLocalhost
        ? `This runtime is treating ${protocol}//${host} as non-secure (likely embedded WebView/Electron policy). WebGPU requires a secure context.`
        : `Current origin is ${protocol}//${host}. WebGPU requires HTTPS (or localhost treated as secure).`,
    };
  }

  const nav = navigator as Navigator & { gpu?: { requestAdapter?: (options?: unknown) => Promise<unknown> } };
  if (!nav.gpu) {
    const ua = navigator.userAgent || '';
    const inElectron = /Electron/i.test(ua);
    return {
      supported: false,
      message: inElectron
        ? 'GPU API is not exposed in this Electron/WebView runtime.'
        : 'Navigator GPU API is not available in this browser.',
    };
  }

  if (typeof nav.gpu.requestAdapter !== 'function') {
    return {
      supported: false,
      message: 'WebGPU API exists but adapter request is unavailable.',
    };
  }

  try {
    const adapter = await nav.gpu.requestAdapter({ powerPreference: 'high-performance' } as unknown);
    if (!adapter) {
      return {
        supported: false,
        message: 'No compatible GPU adapter was returned by the browser.',
      };
    }

    return {
      supported: true,
      message: 'Detected and ready.',
    };
  } catch (error) {
    const base = error instanceof Error ? error.message : String(error);
    return {
      supported: false,
      message: `Adapter request failed: ${base}`,
    };
  }
}

export async function isWebGpuSupported(): Promise<boolean> {
  const details = await getWebGpuSupportDetails();
  return details.supported;
}

export function subscribeToSlicingPerformanceSettings(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const onStorage = (event: StorageEvent) => {
    if (event.key && event.key !== SLICING_PERFORMANCE_SETTINGS_STORAGE_KEY) return;
    listener();
  };

  const onCustom = () => listener();

  window.addEventListener('storage', onStorage);
  window.addEventListener(SLICING_PERFORMANCE_SETTINGS_EVENT, onCustom as EventListener);

  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(SLICING_PERFORMANCE_SETTINGS_EVENT, onCustom as EventListener);
  };
}
