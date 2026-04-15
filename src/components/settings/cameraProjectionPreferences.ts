export type CameraProjectionMode = 'orthographic' | 'perspective';

export type CameraProjectionSettings = {
  mode: CameraProjectionMode;
};

export const CAMERA_PROJECTION_STORAGE_KEY = 'camera-projection-settings';
const CAMERA_PROJECTION_EVENT = 'camera-projection-settings-changed';

const DEFAULT_CAMERA_PROJECTION_SETTINGS: CameraProjectionSettings = {
  //mode: 'orthographic',
  mode: 'perspective',
};

function normalizeMode(input: unknown): CameraProjectionMode {
  //return input === 'perspective' ? 'perspective' : 'orthographic';
  return 'perspective';
}

export function normalizeCameraProjectionSettings(input: unknown): CameraProjectionSettings {
  if (!input || typeof input !== 'object') return DEFAULT_CAMERA_PROJECTION_SETTINGS;
  const candidate = input as Partial<CameraProjectionSettings>;
  return {
    mode: normalizeMode(candidate.mode),
  };
}

export function getSavedCameraProjectionSettings(): CameraProjectionSettings {
  if (typeof window === 'undefined') return DEFAULT_CAMERA_PROJECTION_SETTINGS;

  try {
    const raw = window.localStorage.getItem(CAMERA_PROJECTION_STORAGE_KEY);
    if (!raw) return DEFAULT_CAMERA_PROJECTION_SETTINGS;
    return normalizeCameraProjectionSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_CAMERA_PROJECTION_SETTINGS;
  }
}

export function saveCameraProjectionSettings(settings: CameraProjectionSettings): void {
  if (typeof window === 'undefined') return;

  const normalized = normalizeCameraProjectionSettings(settings);

  try {
    window.localStorage.setItem(CAMERA_PROJECTION_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // ignore storage failures
  }

  window.dispatchEvent(new CustomEvent(CAMERA_PROJECTION_EVENT, { detail: normalized }));
}

export function subscribeToCameraProjectionSettings(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const onStorage = (event: StorageEvent) => {
    if (event.key && event.key !== CAMERA_PROJECTION_STORAGE_KEY) return;
    listener();
  };

  const onCustom = () => listener();

  window.addEventListener('storage', onStorage);
  window.addEventListener(CAMERA_PROJECTION_EVENT, onCustom as EventListener);

  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(CAMERA_PROJECTION_EVENT, onCustom as EventListener);
  };
}

export function toggleCameraProjectionMode(): CameraProjectionMode {
  const current = getSavedCameraProjectionSettings();
  const next: CameraProjectionMode = current.mode === 'orthographic' ? 'perspective' : 'orthographic';
  saveCameraProjectionSettings({ mode: next });
  return next;
}

export { DEFAULT_CAMERA_PROJECTION_SETTINGS };
