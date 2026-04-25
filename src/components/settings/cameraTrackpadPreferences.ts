export type CameraTrackpadPrimaryAction = 'off' | 'pan' | 'orbit';
export type CameraTrackpadModifierKey = 'alt' | 'shift';

export type CameraTrackpadSettings = {
  primaryAction: CameraTrackpadPrimaryAction;
  modifierKey: CameraTrackpadModifierKey;
  panAcceleration: number;
  orbitAcceleration: number;
  zoomAcceleration: number;
};

export const CAMERA_TRACKPAD_SETTINGS_STORAGE_KEY = 'camera-trackpad-settings';
const CAMERA_TRACKPAD_SETTINGS_EVENT = 'camera-trackpad-settings-changed';

export const DEFAULT_CAMERA_TRACKPAD_SETTINGS: CameraTrackpadSettings = {
  primaryAction: 'pan',
  modifierKey: 'shift',
  panAcceleration: 2,
  orbitAcceleration: 2,
  zoomAcceleration: 2,
};

function normalizeAcceleration(input: unknown, fallback: number): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) return fallback;
  return Math.min(4, Math.max(0.4, input));
}

function normalizePrimaryAction(input: unknown): CameraTrackpadPrimaryAction {
  if (input === 'off' || input === 'orbit') return input;
  return 'pan';
}

function normalizeModifierKey(input: unknown): CameraTrackpadModifierKey {
  return input === 'shift' ? 'shift' : 'alt';
}

export function normalizeCameraTrackpadSettings(input: unknown): CameraTrackpadSettings {
  if (!input || typeof input !== 'object') return DEFAULT_CAMERA_TRACKPAD_SETTINGS;
  const candidate = input as Partial<CameraTrackpadSettings>;
  const primaryAction = normalizePrimaryAction(candidate.primaryAction);
  const modifierKey = normalizeModifierKey(candidate.modifierKey);
  const panAcceleration = normalizeAcceleration(candidate.panAcceleration, DEFAULT_CAMERA_TRACKPAD_SETTINGS.panAcceleration);
  const orbitAcceleration = normalizeAcceleration(candidate.orbitAcceleration, DEFAULT_CAMERA_TRACKPAD_SETTINGS.orbitAcceleration);
  const zoomAcceleration = normalizeAcceleration(candidate.zoomAcceleration, DEFAULT_CAMERA_TRACKPAD_SETTINGS.zoomAcceleration);

  // Defensive fallback: a persisted orbit+shift combo has caused startup instability
  // on some macOS trackpad setups. Keep orbit, but migrate modifier to Option.
  if (primaryAction === 'orbit' && modifierKey === 'shift') {
    return {
      primaryAction,
      modifierKey: 'alt',
      panAcceleration,
      orbitAcceleration,
      zoomAcceleration,
    };
  }

  return {
    primaryAction,
    modifierKey,
    panAcceleration,
    orbitAcceleration,
    zoomAcceleration,
  };
}

export function getSavedCameraTrackpadSettings(): CameraTrackpadSettings {
  if (typeof window === 'undefined') return DEFAULT_CAMERA_TRACKPAD_SETTINGS;

  try {
    const raw = window.localStorage.getItem(CAMERA_TRACKPAD_SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_CAMERA_TRACKPAD_SETTINGS;
    return normalizeCameraTrackpadSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_CAMERA_TRACKPAD_SETTINGS;
  }
}

export function saveCameraTrackpadSettings(settings: CameraTrackpadSettings): void {
  if (typeof window === 'undefined') return;

  const normalized = normalizeCameraTrackpadSettings(settings);

  try {
    window.localStorage.setItem(CAMERA_TRACKPAD_SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // ignore storage failures
  }

  window.dispatchEvent(new CustomEvent(CAMERA_TRACKPAD_SETTINGS_EVENT, { detail: normalized }));
}

export function subscribeToCameraTrackpadSettings(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const onStorage = (event: StorageEvent) => {
    if (event.key && event.key !== CAMERA_TRACKPAD_SETTINGS_STORAGE_KEY) return;
    listener();
  };

  const onCustom = () => listener();

  window.addEventListener('storage', onStorage);
  window.addEventListener(CAMERA_TRACKPAD_SETTINGS_EVENT, onCustom as EventListener);

  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(CAMERA_TRACKPAD_SETTINGS_EVENT, onCustom as EventListener);
  };
}