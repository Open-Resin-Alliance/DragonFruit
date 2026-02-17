export type MeshSmoothingFalloff = 'linear' | 'smooth' | 'sharp';

export const MESH_SMOOTHING_BRUSH_SIZE_MM = {
  min: 0.1,
  max: 0.5,
  step: 0.01,
} as const;

export function clampMeshSmoothingBrushSizeMm(input: number): number {
  if (!Number.isFinite(input)) return MESH_SMOOTHING_BRUSH_SIZE_MM.min;
  return Math.max(MESH_SMOOTHING_BRUSH_SIZE_MM.min, Math.min(MESH_SMOOTHING_BRUSH_SIZE_MM.max, input));
}

export type MeshSmoothingSettings = {
  brushSizeMm: number;
  strength: number;
  highlightColor: string;
  falloff: MeshSmoothingFalloff;
  iterations: number;
};

export const DEFAULT_MESH_SMOOTHING_SETTINGS: MeshSmoothingSettings = {
  brushSizeMm: 0.5,
  strength: 0.5,
  highlightColor: '#269eff',
  falloff: 'smooth',
  iterations: 1,
};

const STORAGE_KEY = 'mesh-smoothing-settings';

type SettingsListener = () => void;

let currentSettings: MeshSmoothingSettings = { ...DEFAULT_MESH_SMOOTHING_SETTINGS };
const listeners = new Set<SettingsListener>();

function notify() {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch (err) {
      console.error('[MeshSmoothingSettings] listener error', err);
    }
  });
}

function clampSettings(input: MeshSmoothingSettings): MeshSmoothingSettings {
  const raw = typeof input.highlightColor === 'string' ? input.highlightColor.trim() : '';
  const m = raw.match(/^#?([0-9a-fA-F]{6})$/);
  const highlightColor = m ? `#${m[1].toLowerCase()}` : DEFAULT_MESH_SMOOTHING_SETTINGS.highlightColor;

  return {
    brushSizeMm: clampMeshSmoothingBrushSizeMm(input.brushSizeMm),
    strength: Math.max(0, Math.min(1, input.strength)),
    highlightColor,
    falloff: input.falloff,
    iterations: Math.max(1, Math.min(20, Math.round(input.iterations))),
  };
}

export function getMeshSmoothingSettings(): MeshSmoothingSettings {
  return currentSettings;
}

export function setMeshSmoothingSettings(settings: MeshSmoothingSettings): void {
  currentSettings = clampSettings(settings);
  notify();
}

export function updateMeshSmoothingSettings(partial: Partial<MeshSmoothingSettings>): void {
  setMeshSmoothingSettings({
    ...currentSettings,
    ...partial,
  });
}

export function subscribeToMeshSmoothingSettings(listener: SettingsListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function loadMeshSmoothingSettingsFromLocalStorage(): void {
  if (typeof window === 'undefined') return;

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<MeshSmoothingSettings>;

    setMeshSmoothingSettings({
      ...DEFAULT_MESH_SMOOTHING_SETTINGS,
      ...parsed,
    });
  } catch (err) {
    console.error('[MeshSmoothingSettings] Failed to load from localStorage', err);
  }
}

export function saveMeshSmoothingSettingsToLocalStorage(): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(currentSettings));
  } catch (err) {
    console.error('[MeshSmoothingSettings] Failed to save to localStorage', err);
  }
}
