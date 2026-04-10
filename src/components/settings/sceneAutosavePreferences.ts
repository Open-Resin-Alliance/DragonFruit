'use client';

export type SceneAutosaveSettings = {
  enabled: boolean;
  recoveryPromptEnabled: boolean;
  debounceMs: number;
  capMs: number;
};

export const SCENE_AUTOSAVE_SETTINGS_STORAGE_KEY = 'dragonfruit-scene-autosave:settings-v1';
export const SCENE_AUTOSAVE_SETTINGS_CHANGE_EVENT = 'dragonfruit://scene-autosave-settings-changed';

export const DEFAULT_SCENE_AUTOSAVE_SETTINGS: SceneAutosaveSettings = {
  enabled: true,
  recoveryPromptEnabled: true,
  debounceMs: 30_000,
  capMs: 2 * 60_000,
};

let cachedRawSettingsValue: string | null | undefined;
let cachedSettingsSnapshot: SceneAutosaveSettings = DEFAULT_SCENE_AUTOSAVE_SETTINGS;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeSceneAutosaveSettings(
  value: Partial<SceneAutosaveSettings> | null | undefined,
): SceneAutosaveSettings {
  const rawDebounce = Number(value?.debounceMs);
  const rawCap = Number(value?.capMs);
  const debounceMs = Number.isFinite(rawDebounce)
    ? clamp(Math.round(rawDebounce), 15_000, 15 * 60_000)
    : DEFAULT_SCENE_AUTOSAVE_SETTINGS.debounceMs;
  const capMsCandidate = Number.isFinite(rawCap)
    ? clamp(Math.round(rawCap), 60_000, 60 * 60_000)
    : DEFAULT_SCENE_AUTOSAVE_SETTINGS.capMs;
  const capMs = Math.max(capMsCandidate, debounceMs);

  return {
    enabled: value?.enabled !== false,
    recoveryPromptEnabled: value?.recoveryPromptEnabled !== false,
    debounceMs,
    capMs,
  };
}

function areSceneAutosaveSettingsEqual(a: SceneAutosaveSettings, b: SceneAutosaveSettings): boolean {
  return a.enabled === b.enabled
    && a.recoveryPromptEnabled === b.recoveryPromptEnabled
    && a.debounceMs === b.debounceMs
    && a.capMs === b.capMs;
}

function cacheSceneAutosaveSettings(raw: string | null, next: SceneAutosaveSettings): SceneAutosaveSettings {
  cachedRawSettingsValue = raw;
  if (areSceneAutosaveSettingsEqual(cachedSettingsSnapshot, next)) {
    return cachedSettingsSnapshot;
  }
  cachedSettingsSnapshot = next;
  return cachedSettingsSnapshot;
}

export function getSceneAutosaveSettingsSnapshot(): SceneAutosaveSettings {
  if (typeof window === 'undefined') {
    return DEFAULT_SCENE_AUTOSAVE_SETTINGS;
  }

  try {
    const raw = window.localStorage.getItem(SCENE_AUTOSAVE_SETTINGS_STORAGE_KEY);
    if (raw === cachedRawSettingsValue) {
      return cachedSettingsSnapshot;
    }

    if (!raw) {
      return cacheSceneAutosaveSettings(raw, DEFAULT_SCENE_AUTOSAVE_SETTINGS);
    }

    const parsed = JSON.parse(raw) as Partial<SceneAutosaveSettings>;
    return cacheSceneAutosaveSettings(raw, normalizeSceneAutosaveSettings(parsed));
  } catch {
    return cacheSceneAutosaveSettings(null, DEFAULT_SCENE_AUTOSAVE_SETTINGS);
  }
}

export function getSceneAutosaveSettingsServerSnapshot(): SceneAutosaveSettings {
  return DEFAULT_SCENE_AUTOSAVE_SETTINGS;
}

export function saveSceneAutosaveSettings(next: Partial<SceneAutosaveSettings>): SceneAutosaveSettings {
  const merged = normalizeSceneAutosaveSettings({
    ...getSceneAutosaveSettingsSnapshot(),
    ...next,
  });
  const mergedRaw = JSON.stringify(merged);

  if (typeof window !== 'undefined') {
    try {
      const currentRaw = window.localStorage.getItem(SCENE_AUTOSAVE_SETTINGS_STORAGE_KEY);
      cacheSceneAutosaveSettings(currentRaw, merged);

      if (currentRaw !== mergedRaw) {
        window.localStorage.setItem(SCENE_AUTOSAVE_SETTINGS_STORAGE_KEY, mergedRaw);
        cacheSceneAutosaveSettings(mergedRaw, merged);
        window.dispatchEvent(new CustomEvent(SCENE_AUTOSAVE_SETTINGS_CHANGE_EVENT));
      }
    } catch {
      // Ignore localStorage write failures.
    }
  }

  return merged;
}

export function subscribeToSceneAutosaveSettings(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const onSettingsChanged = () => listener();
  const onStorage = (event: StorageEvent) => {
    if (event.key === SCENE_AUTOSAVE_SETTINGS_STORAGE_KEY) {
      listener();
    }
  };

  window.addEventListener(SCENE_AUTOSAVE_SETTINGS_CHANGE_EVENT, onSettingsChanged as EventListener);
  window.addEventListener('storage', onStorage);

  return () => {
    window.removeEventListener(SCENE_AUTOSAVE_SETTINGS_CHANGE_EVENT, onSettingsChanged as EventListener);
    window.removeEventListener('storage', onStorage);
  };
}
