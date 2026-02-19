export const SPACEMOUSE_SETTINGS_STORAGE_KEY = 'lumenslicer:spacemouse:settings:v1';
export const SPACEMOUSE_SETTINGS_EVENT = 'lumenslicer:spacemouse-settings-changed';

export type SpaceMousePivotMode = 'auto' | 'camera-ray';

export type SpaceMouseSettings = {
  enabled: boolean;
  pivotMode: SpaceMousePivotMode;
  translationSensitivity: number;
  rotationSensitivity: number;
  zoomSensitivity: number;
  deadzone: number;
  dominantAxis: boolean;
  invertTx: boolean;
  invertTy: boolean;
  invertTz: boolean;
  invertRx: boolean;
  invertRy: boolean;
  invertRz: boolean;
};

export const DEFAULT_SPACEMOUSE_SETTINGS: SpaceMouseSettings = {
  enabled: false,
  pivotMode: 'auto',
  translationSensitivity: 1,
  rotationSensitivity: 1,
  zoomSensitivity: 1,
  deadzone: 0.08,
  dominantAxis: false,
  invertTx: false,
  invertTy: true,
  invertTz: false,
  invertRx: true,
  invertRy: true,
  invertRz: false,
};

let cachedRawSettings: string | null | undefined;
let cachedNormalizedSettings: SpaceMouseSettings = DEFAULT_SPACEMOUSE_SETTINGS;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeSpaceMouseSettings(value?: Partial<SpaceMouseSettings> | null): SpaceMouseSettings {
  const merged: SpaceMouseSettings = {
    ...DEFAULT_SPACEMOUSE_SETTINGS,
    ...(value ?? {}),
  };

  return {
    enabled: !!merged.enabled,
    pivotMode: merged.pivotMode === 'camera-ray' ? 'camera-ray' : 'auto',
    translationSensitivity: clamp(Number(merged.translationSensitivity ?? 1), 0.1, 4),
    rotationSensitivity: clamp(Number(merged.rotationSensitivity ?? 1), 0.1, 4),
    zoomSensitivity: clamp(Number(merged.zoomSensitivity ?? 1), 0.1, 4),
    deadzone: clamp(Number(merged.deadzone ?? 0.08), 0, 0.3),
    dominantAxis: !!merged.dominantAxis,
    invertTx: !!merged.invertTx,
    invertTy: !!merged.invertTy,
    invertTz: !!merged.invertTz,
    invertRx: !!merged.invertRx,
    invertRy: !!merged.invertRy,
    invertRz: !!merged.invertRz,
  };
}

export function getSavedSpaceMouseSettings(): SpaceMouseSettings {
  if (typeof window === 'undefined') return DEFAULT_SPACEMOUSE_SETTINGS;

  const raw = window.localStorage.getItem(SPACEMOUSE_SETTINGS_STORAGE_KEY);
  if (cachedRawSettings === raw && cachedNormalizedSettings) {
    return cachedNormalizedSettings;
  }

  if (!raw) {
    cachedRawSettings = raw;
    cachedNormalizedSettings = DEFAULT_SPACEMOUSE_SETTINGS;
    return cachedNormalizedSettings;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<SpaceMouseSettings>;
    cachedRawSettings = raw;
    cachedNormalizedSettings = normalizeSpaceMouseSettings(parsed);
    return cachedNormalizedSettings;
  } catch {
    cachedRawSettings = raw;
    cachedNormalizedSettings = DEFAULT_SPACEMOUSE_SETTINGS;
    return cachedNormalizedSettings;
  }
}

export function saveSpaceMouseSettings(value: Partial<SpaceMouseSettings>) {
  if (typeof window === 'undefined') return;

  const normalized = normalizeSpaceMouseSettings(value);
  const serialized = JSON.stringify(normalized);
  cachedRawSettings = serialized;
  cachedNormalizedSettings = normalized;
  window.localStorage.setItem(SPACEMOUSE_SETTINGS_STORAGE_KEY, serialized);
  window.dispatchEvent(new CustomEvent(SPACEMOUSE_SETTINGS_EVENT, { detail: normalized }));
}

export function subscribeToSpaceMouseSettings(listener: () => void) {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const handler = () => listener();
  const storageHandler = (event: StorageEvent) => {
    if (event.key !== null && event.key !== SPACEMOUSE_SETTINGS_STORAGE_KEY) return;
    listener();
  };
  window.addEventListener(SPACEMOUSE_SETTINGS_EVENT, handler as EventListener);
  window.addEventListener('storage', storageHandler);

  return () => {
    window.removeEventListener(SPACEMOUSE_SETTINGS_EVENT, handler as EventListener);
    window.removeEventListener('storage', storageHandler);
  };
}
