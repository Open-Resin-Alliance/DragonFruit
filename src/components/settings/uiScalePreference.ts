// User-adjustable UI scale, applied via native webview zoom (Webview::setZoom).
// The base UI is a fixed reference density; this lets users magnify or compact
// the whole interface. Default 1 (100%) = the DPI-correct reference size.

// The scale is any factor within [MIN_UI_SCALE, MAX_UI_SCALE]; UI_SCALE_PRESETS
// are the quick-picks offered in the settings dropdown, and a "Custom" option
// lets users type any value in that range.
export type UiScaleValue = number;

export const UI_SCALE_STORAGE_KEY = 'ui-scale';
const UI_SCALE_EVENT = 'ui-scale-changed';

export const DEFAULT_UI_SCALE: UiScaleValue = 1;

export const MIN_UI_SCALE: UiScaleValue = 0.25;
export const MAX_UI_SCALE: UiScaleValue = 4;

export const UI_SCALE_PRESETS: readonly UiScaleValue[] = [0.75, 0.9, 1, 1.1, 1.25, 1.5];

export function normalizeUiScale(input: unknown): UiScaleValue {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return Math.max(MIN_UI_SCALE, Math.min(MAX_UI_SCALE, input));
  }
  return DEFAULT_UI_SCALE;
}

export function getSavedUiScale(): UiScaleValue {
  if (typeof window === 'undefined') return DEFAULT_UI_SCALE;

  try {
    const raw = window.localStorage.getItem(UI_SCALE_STORAGE_KEY);
    if (raw == null) return DEFAULT_UI_SCALE;
    return normalizeUiScale(JSON.parse(raw));
  } catch {
    return DEFAULT_UI_SCALE;
  }
}

export function saveUiScale(scale: UiScaleValue): void {
  if (typeof window === 'undefined') return;

  const normalized = normalizeUiScale(scale);

  try {
    window.localStorage.setItem(UI_SCALE_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // ignore storage failures
  }

  window.dispatchEvent(new CustomEvent(UI_SCALE_EVENT, { detail: normalized }));
}

export function subscribeToUiScale(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const onStorage = (event: StorageEvent) => {
    if (event.key && event.key !== UI_SCALE_STORAGE_KEY) return;
    listener();
  };

  const onCustom = () => listener();

  window.addEventListener('storage', onStorage);
  window.addEventListener(UI_SCALE_EVENT, onCustom as EventListener);

  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(UI_SCALE_EVENT, onCustom as EventListener);
  };
}
