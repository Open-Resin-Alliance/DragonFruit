import type { SupportMode } from '@/supports/types';
import type { CameraProjectionMode } from '@/components/settings/cameraProjectionPreferences';
import type { SelectionHighlightMode } from '@/components/selection';

export type CameraScopeMode = 'global' | 'workspace';
export type WorkspaceCameraDefaults = Record<SupportMode, CameraProjectionMode>;
export type WorkspaceSelectionHighlightDefaults = Record<SupportMode, SelectionHighlightMode>;

export type WorkspaceCameraSettings = {
  scope: CameraScopeMode;
  defaults: WorkspaceCameraDefaults;
  selectionHighlightDefaults: WorkspaceSelectionHighlightDefaults;
};

export const WORKSPACE_CAMERA_SETTINGS_STORAGE_KEY = 'workspace-camera-settings';
const WORKSPACE_CAMERA_SETTINGS_EVENT = 'workspace-camera-settings-changed';

export const DEFAULT_WORKSPACE_CAMERA_SETTINGS: WorkspaceCameraSettings = {
  scope: 'global',
  defaults: {
    prepare: 'orthographic',
    analysis: 'orthographic',
    support: 'orthographic',
    export: 'orthographic',
    printing: 'orthographic',
  },
  selectionHighlightDefaults: {
    prepare: 'tint',
    analysis: 'tint',
    support: 'tint',
    export: 'tint',
    printing: 'tint',
  },
};

let cachedWorkspaceCameraSettings: WorkspaceCameraSettings = DEFAULT_WORKSPACE_CAMERA_SETTINGS;
let hasHydratedWorkspaceCameraSettings = false;

if (typeof window !== 'undefined') {
  try {
    const raw = window.localStorage.getItem(WORKSPACE_CAMERA_SETTINGS_STORAGE_KEY);
    cachedWorkspaceCameraSettings = raw
      ? normalizeWorkspaceCameraSettings(JSON.parse(raw))
      : DEFAULT_WORKSPACE_CAMERA_SETTINGS;
  } catch {
    cachedWorkspaceCameraSettings = DEFAULT_WORKSPACE_CAMERA_SETTINGS;
  }

  hasHydratedWorkspaceCameraSettings = true;
}

function normalizeMode(input: unknown): CameraProjectionMode {
  return input === 'perspective' ? 'perspective' : 'orthographic';
}

function normalizeScope(input: unknown): CameraScopeMode {
  return input === 'global' ? 'global' : 'workspace';
}

function normalizeSelectionHighlightMode(input: unknown): SelectionHighlightMode {
  if (input === 'spotlight' || input === 'fresnel' || input === 'none') return input;
  return 'tint';
}

export function normalizeWorkspaceCameraSettings(input: unknown): WorkspaceCameraSettings {
  if (!input || typeof input !== 'object') return DEFAULT_WORKSPACE_CAMERA_SETTINGS;

  const candidate = input as Partial<WorkspaceCameraSettings> & {
    scope?: unknown;
    defaults?: Partial<Record<SupportMode, unknown>>;
    selectionHighlightDefaults?: Partial<Record<SupportMode, unknown>>;
  };

  const defaults: Partial<Record<SupportMode, unknown>> = candidate.defaults ?? {};
  const selectionHighlightDefaults: Partial<Record<SupportMode, unknown>> = candidate.selectionHighlightDefaults ?? {};

  return {
    scope: normalizeScope(candidate.scope),
    defaults: {
      prepare: normalizeMode(defaults.prepare),
      analysis: normalizeMode(defaults.analysis),
      support: normalizeMode(defaults.support),
      export: normalizeMode(defaults.export),
      printing: normalizeMode(defaults.printing),
    },
    selectionHighlightDefaults: {
      prepare: normalizeSelectionHighlightMode(selectionHighlightDefaults.prepare),
      analysis: normalizeSelectionHighlightMode(selectionHighlightDefaults.analysis),
      support: normalizeSelectionHighlightMode(selectionHighlightDefaults.support),
      export: normalizeSelectionHighlightMode(selectionHighlightDefaults.export),
      printing: normalizeSelectionHighlightMode(selectionHighlightDefaults.printing),
    },
  };
}

export function getSavedWorkspaceCameraSettings(): WorkspaceCameraSettings {
  if (typeof window === 'undefined') return DEFAULT_WORKSPACE_CAMERA_SETTINGS;

  try {
    const raw = window.localStorage.getItem(WORKSPACE_CAMERA_SETTINGS_STORAGE_KEY);
    if (!raw) {
      cachedWorkspaceCameraSettings = DEFAULT_WORKSPACE_CAMERA_SETTINGS;
      hasHydratedWorkspaceCameraSettings = true;
      return cachedWorkspaceCameraSettings;
    }
    cachedWorkspaceCameraSettings = normalizeWorkspaceCameraSettings(JSON.parse(raw));
    hasHydratedWorkspaceCameraSettings = true;
    return cachedWorkspaceCameraSettings;
  } catch {
    cachedWorkspaceCameraSettings = DEFAULT_WORKSPACE_CAMERA_SETTINGS;
    hasHydratedWorkspaceCameraSettings = true;
    return cachedWorkspaceCameraSettings;
  }
}

export function saveWorkspaceCameraSettings(settings: WorkspaceCameraSettings): void {
  if (typeof window === 'undefined') return;

  const normalized = normalizeWorkspaceCameraSettings(settings);
  cachedWorkspaceCameraSettings = normalized;
  hasHydratedWorkspaceCameraSettings = true;

  try {
    window.localStorage.setItem(WORKSPACE_CAMERA_SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // ignore storage failures
  }

  window.dispatchEvent(new CustomEvent(WORKSPACE_CAMERA_SETTINGS_EVENT, { detail: normalized }));
}

export function getWorkspaceCameraSettingsSnapshot(): WorkspaceCameraSettings {
  if (typeof window === 'undefined') return DEFAULT_WORKSPACE_CAMERA_SETTINGS;
  if (!hasHydratedWorkspaceCameraSettings) return getSavedWorkspaceCameraSettings();
  return cachedWorkspaceCameraSettings;
}

export function getWorkspaceCameraSettingsServerSnapshot(): WorkspaceCameraSettings {
  return DEFAULT_WORKSPACE_CAMERA_SETTINGS;
}

export function subscribeToWorkspaceCameraSettings(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const onStorage = (event: StorageEvent) => {
    if (event.key && event.key !== WORKSPACE_CAMERA_SETTINGS_STORAGE_KEY) return;
    cachedWorkspaceCameraSettings = getSavedWorkspaceCameraSettings();
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
