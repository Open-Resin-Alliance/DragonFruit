import type { SupportMode } from '@/supports/types';
import type { CameraProjectionMode } from '@/components/settings/cameraProjectionPreferences';

export type WorkspaceCameraDefaults = Record<SupportMode, CameraProjectionMode>;

export type WorkspaceCameraSettings = {
  defaults: WorkspaceCameraDefaults;
};

export const WORKSPACE_CAMERA_SETTINGS_STORAGE_KEY = 'workspace-camera-settings';
const WORKSPACE_CAMERA_SETTINGS_EVENT = 'workspace-camera-settings-changed';

export const DEFAULT_WORKSPACE_CAMERA_SETTINGS: WorkspaceCameraSettings = {
  defaults: {
    prepare: 'orthographic',
    analysis: 'orthographic',
    support: 'perspective',
    export: 'orthographic',
  },
};

function normalizeMode(input: unknown): CameraProjectionMode {
  return input === 'perspective' ? 'perspective' : 'orthographic';
}

export function normalizeWorkspaceCameraSettings(input: unknown): WorkspaceCameraSettings {
  if (!input || typeof input !== 'object') return DEFAULT_WORKSPACE_CAMERA_SETTINGS;

  const candidate = input as Partial<WorkspaceCameraSettings> & {
    defaults?: Partial<Record<SupportMode, unknown>>;
  };

  const defaults: Partial<Record<SupportMode, unknown>> = candidate.defaults ?? {};

  return {
    defaults: {
      prepare: normalizeMode(defaults.prepare),
      analysis: normalizeMode(defaults.analysis),
      support: normalizeMode(defaults.support),
      export: normalizeMode(defaults.export),
    },
  };
}

export function getSavedWorkspaceCameraSettings(): WorkspaceCameraSettings {
  if (typeof window === 'undefined') return DEFAULT_WORKSPACE_CAMERA_SETTINGS;

  try {
    const raw = window.localStorage.getItem(WORKSPACE_CAMERA_SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_WORKSPACE_CAMERA_SETTINGS;
    return normalizeWorkspaceCameraSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_WORKSPACE_CAMERA_SETTINGS;
  }
}

export function saveWorkspaceCameraSettings(settings: WorkspaceCameraSettings): void {
  if (typeof window === 'undefined') return;

  const normalized = normalizeWorkspaceCameraSettings(settings);

  try {
    window.localStorage.setItem(WORKSPACE_CAMERA_SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // ignore storage failures
  }

  window.dispatchEvent(new CustomEvent(WORKSPACE_CAMERA_SETTINGS_EVENT, { detail: normalized }));
}

export function subscribeToWorkspaceCameraSettings(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const onStorage = (event: StorageEvent) => {
    if (event.key && event.key !== WORKSPACE_CAMERA_SETTINGS_STORAGE_KEY) return;
    listener();
  };

  const onCustom = () => listener();

  window.addEventListener('storage', onStorage);
  window.addEventListener(WORKSPACE_CAMERA_SETTINGS_EVENT, onCustom as EventListener);

  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(WORKSPACE_CAMERA_SETTINGS_EVENT, onCustom as EventListener);
  };
}
