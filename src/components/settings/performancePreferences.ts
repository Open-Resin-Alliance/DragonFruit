export type SlicingComputeBackendPreference = 'auto' | 'cpu' | 'webgpu';
export type SlicingCpuProfile = 'balanced' | 'max';
export type SlicingProgressGranularity = 'balanced' | 'granular';

export type SlicingPerformanceSettings = {
  computeBackend: SlicingComputeBackendPreference;
  cpuProfile: SlicingCpuProfile;
  progressGranularity: SlicingProgressGranularity;
};

export const SLICING_PERFORMANCE_SETTINGS_STORAGE_KEY = 'app-slicing-performance-settings';
const SLICING_PERFORMANCE_SETTINGS_EVENT = 'app-slicing-performance-settings-changed';

export const DEFAULT_SLICING_PERFORMANCE_SETTINGS: SlicingPerformanceSettings = {
  computeBackend: 'auto',
  cpuProfile: 'max',
  progressGranularity: 'granular',
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

  return {
    computeBackend,
    cpuProfile,
    progressGranularity,
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

export async function isWebGpuSupported(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !(navigator as Navigator & { gpu?: unknown }).gpu) {
    return false;
  }

  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter?: () => Promise<unknown> } }).gpu;
    if (!gpu?.requestAdapter) return false;
    const adapter = await gpu.requestAdapter();
    return Boolean(adapter);
  } catch {
    return false;
  }
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
