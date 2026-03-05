export type SlicingComputeBackendPreference = 'auto' | 'cpu' | 'gpu';
export type SlicingCpuProfile = 'balanced' | 'max';
export type PngCompressionStrategy = 'fastest' | 'balanced' | 'smallest' | 'optimal';

export type SlicingPerformanceSettings = {
  computeBackend: SlicingComputeBackendPreference;
  cpuProfile: SlicingCpuProfile;
  pngCompressionStrategy: PngCompressionStrategy;
  bvhAccelerationEnabled: boolean;
};

export const SLICING_PERFORMANCE_SETTINGS_STORAGE_KEY = 'app-slicing-performance-settings';
const SLICING_PERFORMANCE_SETTINGS_EVENT = 'app-slicing-performance-settings-changed';

export const DEFAULT_SLICING_PERFORMANCE_SETTINGS: SlicingPerformanceSettings = {
  computeBackend: 'auto',
  cpuProfile: 'max',
  pngCompressionStrategy: 'balanced',
  bvhAccelerationEnabled: true,
};

export function normalizeSlicingPerformanceSettings(input: unknown): SlicingPerformanceSettings {
  if (!input || typeof input !== 'object') return DEFAULT_SLICING_PERFORMANCE_SETTINGS;

  const candidate = input as Partial<SlicingPerformanceSettings>;

  const computeBackend: SlicingComputeBackendPreference =
    candidate.computeBackend === 'cpu' || candidate.computeBackend === 'gpu'
      ? candidate.computeBackend
      : 'auto';

  const cpuProfile: SlicingCpuProfile =
    candidate.cpuProfile === 'balanced' ? 'balanced' : 'max';

  const pngCompressionStrategy: PngCompressionStrategy =
    candidate.pngCompressionStrategy === 'fastest' ||
    candidate.pngCompressionStrategy === 'balanced' ||
    candidate.pngCompressionStrategy === 'smallest' ||
    candidate.pngCompressionStrategy === 'optimal'
      ? candidate.pngCompressionStrategy
      : 'balanced';

  const bvhAccelerationEnabled = candidate.bvhAccelerationEnabled !== false;

  return {
    computeBackend,
    cpuProfile,
    pngCompressionStrategy,
    bvhAccelerationEnabled,
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
