export type UvToolsSettings = {
  enabled: boolean;
  customPath: string;
};

export const UVTOOLS_SETTINGS_STORAGE_KEY = 'app-uvtools-settings';
const UVTOOLS_SETTINGS_EVENT = 'app-uvtools-settings-changed';

export const DEFAULT_UVTOOLS_SETTINGS: UvToolsSettings = {
  enabled: false,
  customPath: '',
};

let cachedUvToolsSettingsRaw: string | null | undefined;
let cachedUvToolsSettingsSnapshot: UvToolsSettings = DEFAULT_UVTOOLS_SETTINGS;

export function normalizeUvToolsSettings(input: unknown): UvToolsSettings {
  if (!input || typeof input !== 'object') return DEFAULT_UVTOOLS_SETTINGS;

  const candidate = input as Partial<UvToolsSettings>;

  return {
    enabled: candidate.enabled === true,
    customPath: typeof candidate.customPath === 'string' ? candidate.customPath : '',
  };
}

export function getSavedUvToolsSettings(): UvToolsSettings {
  if (typeof window === 'undefined') return DEFAULT_UVTOOLS_SETTINGS;

  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(UVTOOLS_SETTINGS_STORAGE_KEY);
  } catch {
    return DEFAULT_UVTOOLS_SETTINGS;
  }

  if (cachedUvToolsSettingsRaw === raw) {
    return cachedUvToolsSettingsSnapshot;
  }

  if (!raw) {
    cachedUvToolsSettingsRaw = null;
    cachedUvToolsSettingsSnapshot = DEFAULT_UVTOOLS_SETTINGS;
    return cachedUvToolsSettingsSnapshot;
  }

  try {
    cachedUvToolsSettingsSnapshot = normalizeUvToolsSettings(JSON.parse(raw));
    cachedUvToolsSettingsRaw = raw;
    return cachedUvToolsSettingsSnapshot;
  } catch {
    cachedUvToolsSettingsRaw = raw;
    cachedUvToolsSettingsSnapshot = DEFAULT_UVTOOLS_SETTINGS;
    return cachedUvToolsSettingsSnapshot;
  }
}

export function saveUvToolsSettings(settings: UvToolsSettings): void {
  if (typeof window === 'undefined') return;

  const normalized = normalizeUvToolsSettings(settings);
  const serialized = JSON.stringify(normalized);
  cachedUvToolsSettingsRaw = serialized;
  cachedUvToolsSettingsSnapshot = normalized;

  try {
    window.localStorage.setItem(UVTOOLS_SETTINGS_STORAGE_KEY, serialized);
  } catch {
    // ignore storage failures
  }

  window.dispatchEvent(new CustomEvent(UVTOOLS_SETTINGS_EVENT, { detail: normalized }));
}

export function subscribeToUvToolsSettings(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const onStorage = (event: StorageEvent) => {
    if (event.key && event.key !== UVTOOLS_SETTINGS_STORAGE_KEY) return;
    listener();
  };

  const onCustom = () => listener();

  window.addEventListener('storage', onStorage);
  window.addEventListener(UVTOOLS_SETTINGS_EVENT, onCustom as EventListener);

  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(UVTOOLS_SETTINGS_EVENT, onCustom as EventListener);
  };
}

/**
 * Common installation paths to scan for UVTools on Windows.
 */
const UVTOOLS_CANDIDATE_PATHS: string[] = [
  'C:\\Program Files\\UVtools\\UVTools.exe',
  'C:\\Program Files (x86)\\UVtools\\UVTools.exe',
];

/**
 * Scan common install locations and PATH for UVTools.
 * Returns the first valid executable path found, or null if none found.
 *
 * Uses a Tauri command to check the filesystem; falls back silently in browser mode.
 */
export async function autoDiscoverUvToolsPath(): Promise<string | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<string | null>('discover_uvtools_path', {
      candidates: UVTOOLS_CANDIDATE_PATHS,
    });
    return result ?? null;
  } catch {
    // Not in Tauri runtime — auto-discovery is unavailable
    return null;
  }
}

/**
 * Resolve the effective UVTools executable path.
 * Returns the custom path if set, otherwise an empty string.
 */
export function resolveUvToolsExecutablePath(settings: UvToolsSettings): string {
  return settings.customPath.trim();
}
