export type CameraFovSettings = {
  /** Perspective camera vertical field of view in degrees. */
  fov: number;
};

export const CAMERA_FOV_STORAGE_KEY = 'camera-fov-settings';
const CAMERA_FOV_EVENT = 'camera-fov-settings-changed';

export const DEFAULT_FOV_DEG = 50;
export const FOV_MIN = 15;
export const FOV_MAX = 120;

export const DEFAULT_CAMERA_FOV_SETTINGS: CameraFovSettings = {
  fov: DEFAULT_FOV_DEG,
};

function clampFov(value: number): number {
  return Math.round(Math.max(FOV_MIN, Math.min(FOV_MAX, value)));
}

function normalizeFov(input: unknown): number {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return clampFov(input);
  }
  return DEFAULT_FOV_DEG;
}

export function normalizeCameraFovSettings(input: unknown): CameraFovSettings {
  if (!input || typeof input !== 'object') return DEFAULT_CAMERA_FOV_SETTINGS;
  const candidate = input as Partial<CameraFovSettings>;
  return {
    fov: normalizeFov(candidate.fov),
  };
}

export function getSavedCameraFovSettings(): CameraFovSettings {
  if (typeof window === 'undefined') return DEFAULT_CAMERA_FOV_SETTINGS;

  try {
    const raw = window.localStorage.getItem(CAMERA_FOV_STORAGE_KEY);
    if (!raw) return DEFAULT_CAMERA_FOV_SETTINGS;
    return normalizeCameraFovSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_CAMERA_FOV_SETTINGS;
  }
}

export function saveCameraFovSettings(settings: CameraFovSettings): void {
  if (typeof window === 'undefined') return;

  const normalized = normalizeCameraFovSettings(settings);

  try {
    window.localStorage.setItem(CAMERA_FOV_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // ignore storage failures
  }

  window.dispatchEvent(new CustomEvent(CAMERA_FOV_EVENT, { detail: normalized }));
}

export function subscribeToCameraFovSettings(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const onStorage = (event: StorageEvent) => {
    if (event.key && event.key !== CAMERA_FOV_STORAGE_KEY) return;
    listener();
  };

  const onCustom = () => listener();

  window.addEventListener('storage', onStorage);
  window.addEventListener(CAMERA_FOV_EVENT, onCustom as EventListener);

  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(CAMERA_FOV_EVENT, onCustom as EventListener);
  };
}
