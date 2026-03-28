export type View3DSettings = {
  enabled: boolean;
  widthMm: number;
  depthMm: number;
  maxZMm: number;
  originMode: 'center' | 'front_left';
  screenWidthPx: number;
  screenHeightPx: number;
  showViolationWarning: boolean;
  showModelBoundingBoxes: boolean;
  showSliceSatBoundingMesh: boolean;
  showSliceSatBoundingMeshForAllModels: boolean;
  sliceSatBoundingMeshMode: 'accurate_hull' | 'experimental_slice';
  experimentalSliceSatBoundingMeshRenderMode: 'shaded' | 'wireframe';
};

export const VIEW3D_SETTINGS_STORAGE_KEY = 'app-3d-view-settings';
const VIEW3D_SETTINGS_EVENT = 'app-3d-view-settings-changed';

export const DEFAULT_VIEW3D_SETTINGS: View3DSettings = {
  enabled: true,
  widthMm: 218,
  depthMm: 123,
  maxZMm: 250,
  originMode: 'center',
  screenWidthPx: 2560,
  screenHeightPx: 1440,
  showViolationWarning: true,
  showModelBoundingBoxes: false,
  showSliceSatBoundingMesh: false,
  showSliceSatBoundingMeshForAllModels: false,
  sliceSatBoundingMeshMode: 'accurate_hull',
  experimentalSliceSatBoundingMeshRenderMode: 'shaded',
};

function clampNumber(input: unknown, min: number, max: number, fallback: number): number {
  const value = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function clampInteger(input: unknown, min: number, max: number, fallback: number): number {
  return Math.round(clampNumber(input, min, max, fallback));
}

function clampBoolean(input: unknown, fallback: boolean): boolean {
  return typeof input === 'boolean' ? input : fallback;
}

function clampOriginMode(input: unknown, fallback: View3DSettings['originMode']): View3DSettings['originMode'] {
  return input === 'front_left' || input === 'center' ? input : fallback;
}

function clampSliceSatMode(
  input: unknown,
  fallback: View3DSettings['sliceSatBoundingMeshMode'],
): View3DSettings['sliceSatBoundingMeshMode'] {
  return input === 'accurate_hull' || input === 'experimental_slice' ? input : fallback;
}

function clampExperimentalSliceSatRenderMode(
  input: unknown,
  fallback: View3DSettings['experimentalSliceSatBoundingMeshRenderMode'],
): View3DSettings['experimentalSliceSatBoundingMeshRenderMode'] {
  return input === 'wireframe' || input === 'shaded' ? input : fallback;
}

export function normalizeView3DSettings(input: unknown): View3DSettings {
  if (!input || typeof input !== 'object') return DEFAULT_VIEW3D_SETTINGS;

  const candidate = input as Partial<View3DSettings> & {
    // Legacy field kept for migration from previous versions.
    sliceSatBoundingMeshRenderMode?: 'shaded' | 'wireframe' | 'hull';
  };

  const legacyRenderMode = candidate.sliceSatBoundingMeshRenderMode;
  const inferredModeFromLegacy: View3DSettings['sliceSatBoundingMeshMode'] | null =
    legacyRenderMode === 'hull'
      ? 'accurate_hull'
      : legacyRenderMode === 'shaded' || legacyRenderMode === 'wireframe'
        ? 'experimental_slice'
        : null;

  const inferredExperimentalRenderFromLegacy: View3DSettings['experimentalSliceSatBoundingMeshRenderMode'] | null =
    legacyRenderMode === 'shaded' || legacyRenderMode === 'wireframe'
      ? legacyRenderMode
      : null;

  return {
    enabled: clampBoolean(candidate.enabled, DEFAULT_VIEW3D_SETTINGS.enabled),
    widthMm: clampNumber(candidate.widthMm, 10, 2000, DEFAULT_VIEW3D_SETTINGS.widthMm),
    depthMm: clampNumber(candidate.depthMm, 10, 2000, DEFAULT_VIEW3D_SETTINGS.depthMm),
    maxZMm: clampNumber(candidate.maxZMm, 10, 3000, DEFAULT_VIEW3D_SETTINGS.maxZMm),
    originMode: clampOriginMode(candidate.originMode, DEFAULT_VIEW3D_SETTINGS.originMode),
    screenWidthPx: clampInteger(candidate.screenWidthPx, 320, 16384, DEFAULT_VIEW3D_SETTINGS.screenWidthPx),
    screenHeightPx: clampInteger(candidate.screenHeightPx, 200, 16384, DEFAULT_VIEW3D_SETTINGS.screenHeightPx),
    showViolationWarning: clampBoolean(candidate.showViolationWarning, DEFAULT_VIEW3D_SETTINGS.showViolationWarning),
    showModelBoundingBoxes: clampBoolean(candidate.showModelBoundingBoxes, DEFAULT_VIEW3D_SETTINGS.showModelBoundingBoxes),
    showSliceSatBoundingMesh: clampBoolean(candidate.showSliceSatBoundingMesh, DEFAULT_VIEW3D_SETTINGS.showSliceSatBoundingMesh),
    showSliceSatBoundingMeshForAllModels: clampBoolean(
      candidate.showSliceSatBoundingMeshForAllModels,
      DEFAULT_VIEW3D_SETTINGS.showSliceSatBoundingMeshForAllModels,
    ),
    sliceSatBoundingMeshMode: clampSliceSatMode(
      candidate.sliceSatBoundingMeshMode ?? inferredModeFromLegacy,
      DEFAULT_VIEW3D_SETTINGS.sliceSatBoundingMeshMode,
    ),
    experimentalSliceSatBoundingMeshRenderMode: clampExperimentalSliceSatRenderMode(
      candidate.experimentalSliceSatBoundingMeshRenderMode ?? inferredExperimentalRenderFromLegacy,
      DEFAULT_VIEW3D_SETTINGS.experimentalSliceSatBoundingMeshRenderMode,
    ),
  };
}

export function getSavedView3DSettings(): View3DSettings {
  if (typeof window === 'undefined') return DEFAULT_VIEW3D_SETTINGS;

  try {
    const raw = window.localStorage.getItem(VIEW3D_SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_VIEW3D_SETTINGS;
    return normalizeView3DSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_VIEW3D_SETTINGS;
  }
}

export function saveView3DSettings(settings: View3DSettings): void {
  if (typeof window === 'undefined') return;

  const normalized = normalizeView3DSettings(settings);

  try {
    window.localStorage.setItem(VIEW3D_SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // ignore storage failures
  }

  window.dispatchEvent(new CustomEvent(VIEW3D_SETTINGS_EVENT, { detail: normalized }));
}

export function subscribeToView3DSettings(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const onStorage = (event: StorageEvent) => {
    if (event.key && event.key !== VIEW3D_SETTINGS_STORAGE_KEY) return;
    listener();
  };

  const onCustom = () => listener();

  window.addEventListener('storage', onStorage);
  window.addEventListener(VIEW3D_SETTINGS_EVENT, onCustom as EventListener);

  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(VIEW3D_SETTINGS_EVENT, onCustom as EventListener);
  };
}
