export type CameraOrbitPivot = 'view-center' | 'cursor';

export type CameraOrbitPivotSettings = {
  pivot: CameraOrbitPivot;
};

export const CAMERA_ORBIT_PIVOT_STORAGE_KEY = 'camera-orbit-pivot-settings';
const CAMERA_ORBIT_PIVOT_EVENT = 'camera-orbit-pivot-settings-changed';

export const DEFAULT_CAMERA_ORBIT_PIVOT_SETTINGS: CameraOrbitPivotSettings = {
  pivot: 'view-center',
};

function normalizePivot(input: unknown): CameraOrbitPivot {
  return input === 'cursor' ? 'cursor' : 'view-center';
}

export function normalizeCameraOrbitPivotSettings(input: unknown): CameraOrbitPivotSettings {
  if (!input || typeof input !== 'object') return DEFAULT_CAMERA_ORBIT_PIVOT_SETTINGS;
  const candidate = input as Partial<CameraOrbitPivotSettings>;
  return {
    pivot: normalizePivot(candidate.pivot),
  };
}

export function getSavedCameraOrbitPivotSettings(): CameraOrbitPivotSettings {
  if (typeof window === 'undefined') return DEFAULT_CAMERA_ORBIT_PIVOT_SETTINGS;

  try {
    const raw = window.localStorage.getItem(CAMERA_ORBIT_PIVOT_STORAGE_KEY);
    if (!raw) return DEFAULT_CAMERA_ORBIT_PIVOT_SETTINGS;
    return normalizeCameraOrbitPivotSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_CAMERA_ORBIT_PIVOT_SETTINGS;
  }
}

export function saveCameraOrbitPivotSettings(settings: CameraOrbitPivotSettings): void {
  if (typeof window === 'undefined') return;

  const normalized = normalizeCameraOrbitPivotSettings(settings);

  try {
    window.localStorage.setItem(CAMERA_ORBIT_PIVOT_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // ignore storage failures
  }

  window.dispatchEvent(new CustomEvent(CAMERA_ORBIT_PIVOT_EVENT, { detail: normalized }));
}

export function subscribeToCameraOrbitPivotSettings(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const onStorage = (event: StorageEvent) => {
    if (event.key && event.key !== CAMERA_ORBIT_PIVOT_STORAGE_KEY) return;
    listener();
  };

  const onCustom = () => listener();

  window.addEventListener('storage', onStorage);
  window.addEventListener(CAMERA_ORBIT_PIVOT_EVENT, onCustom as EventListener);

  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(CAMERA_ORBIT_PIVOT_EVENT, onCustom as EventListener);
  };
}
