export type PngCompressionStrategy = 'auto' | 'fastest' | 'balanced' | 'smallest' | 'optimal';

export type SlicingPerformanceSettings = {
  pngCompressionStrategy: PngCompressionStrategy;
  bvhAccelerationEnabled: boolean;
  aaOnSupportsExperimental: boolean;
};

export const SLICING_PERFORMANCE_SETTINGS_STORAGE_KEY = 'app-slicing-performance-settings';
const SLICING_PERFORMANCE_SETTINGS_EVENT = 'app-slicing-performance-settings-changed';

export const DEFAULT_SLICING_PERFORMANCE_SETTINGS: SlicingPerformanceSettings = {
  pngCompressionStrategy: 'auto',
  bvhAccelerationEnabled: true,
  aaOnSupportsExperimental: false,
};

let cachedSlicingPerformanceSettingsRaw: string | null | undefined;
let cachedSlicingPerformanceSettingsSnapshot: SlicingPerformanceSettings = DEFAULT_SLICING_PERFORMANCE_SETTINGS;

export function normalizeSlicingPerformanceSettings(input: unknown): SlicingPerformanceSettings {
  if (!input || typeof input !== 'object') return DEFAULT_SLICING_PERFORMANCE_SETTINGS;

  const candidate = input as Partial<SlicingPerformanceSettings>;

  const pngCompressionStrategy: PngCompressionStrategy =
    candidate.pngCompressionStrategy === 'auto' ||
    candidate.pngCompressionStrategy === 'fastest' ||
    candidate.pngCompressionStrategy === 'balanced' ||
    candidate.pngCompressionStrategy === 'smallest' ||
    candidate.pngCompressionStrategy === 'optimal'
      ? candidate.pngCompressionStrategy
      : 'auto';

  const bvhAccelerationEnabled = candidate.bvhAccelerationEnabled !== false;
  const aaOnSupportsExperimental = candidate.aaOnSupportsExperimental === true;

  return {
    pngCompressionStrategy,
    bvhAccelerationEnabled,
    aaOnSupportsExperimental,
  };
}

export function getSavedSlicingPerformanceSettings(): SlicingPerformanceSettings {
  if (typeof window === 'undefined') return DEFAULT_SLICING_PERFORMANCE_SETTINGS;

  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(SLICING_PERFORMANCE_SETTINGS_STORAGE_KEY);
  } catch {
    return DEFAULT_SLICING_PERFORMANCE_SETTINGS;
  }

  if (cachedSlicingPerformanceSettingsRaw === raw) {
    return cachedSlicingPerformanceSettingsSnapshot;
  }

  if (!raw) {
    cachedSlicingPerformanceSettingsRaw = null;
    cachedSlicingPerformanceSettingsSnapshot = DEFAULT_SLICING_PERFORMANCE_SETTINGS;
    return cachedSlicingPerformanceSettingsSnapshot;
  }

  try {
    cachedSlicingPerformanceSettingsSnapshot = normalizeSlicingPerformanceSettings(JSON.parse(raw));
    cachedSlicingPerformanceSettingsRaw = raw;
    return cachedSlicingPerformanceSettingsSnapshot;
  } catch {
    cachedSlicingPerformanceSettingsRaw = raw;
    cachedSlicingPerformanceSettingsSnapshot = DEFAULT_SLICING_PERFORMANCE_SETTINGS;
    return cachedSlicingPerformanceSettingsSnapshot;
  }
}

export function saveSlicingPerformanceSettings(settings: SlicingPerformanceSettings): void {
  if (typeof window === 'undefined') return;

  const normalized = normalizeSlicingPerformanceSettings(settings);
  const serialized = JSON.stringify(normalized);
  cachedSlicingPerformanceSettingsRaw = serialized;
  cachedSlicingPerformanceSettingsSnapshot = normalized;

  try {
    window.localStorage.setItem(SLICING_PERFORMANCE_SETTINGS_STORAGE_KEY, serialized);
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
