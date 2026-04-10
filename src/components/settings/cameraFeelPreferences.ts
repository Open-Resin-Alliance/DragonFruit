export type CameraFeelPreset = 'raw' | 'precise' | 'balanced' | 'fast';

export type CameraFeelSettings = {
  preset: CameraFeelPreset;
};

export const CAMERA_FEEL_STORAGE_KEY = 'camera-feel-settings';
const CAMERA_FEEL_EVENT = 'camera-feel-settings-changed';

export const DEFAULT_CAMERA_FEEL_SETTINGS: CameraFeelSettings = {
  preset: 'precise',
};

function normalizePreset(input: unknown): CameraFeelPreset {
  if (input === 'raw' || input === 'precise' || input === 'fast') return input;
  return 'precise';
}

export function normalizeCameraFeelSettings(input: unknown): CameraFeelSettings {
  if (!input || typeof input !== 'object') return DEFAULT_CAMERA_FEEL_SETTINGS;
  const candidate = input as Partial<CameraFeelSettings>;
  return {
    preset: normalizePreset(candidate.preset),
  };
}

export function getSavedCameraFeelSettings(): CameraFeelSettings {
  if (typeof window === 'undefined') return DEFAULT_CAMERA_FEEL_SETTINGS;

  try {
    const raw = window.localStorage.getItem(CAMERA_FEEL_STORAGE_KEY);
    if (!raw) return DEFAULT_CAMERA_FEEL_SETTINGS;
    return normalizeCameraFeelSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_CAMERA_FEEL_SETTINGS;
  }
}

export function saveCameraFeelSettings(settings: CameraFeelSettings): void {
  if (typeof window === 'undefined') return;

  const normalized = normalizeCameraFeelSettings(settings);

  try {
    window.localStorage.setItem(CAMERA_FEEL_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // ignore storage failures
  }

  window.dispatchEvent(new CustomEvent(CAMERA_FEEL_EVENT, { detail: normalized }));
}

export function subscribeToCameraFeelSettings(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const onStorage = (event: StorageEvent) => {
    if (event.key && event.key !== CAMERA_FEEL_STORAGE_KEY) return;
    listener();
  };

  const onCustom = () => listener();

  window.addEventListener('storage', onStorage);
  window.addEventListener(CAMERA_FEEL_EVENT, onCustom as EventListener);

  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(CAMERA_FEEL_EVENT, onCustom as EventListener);
  };
}
