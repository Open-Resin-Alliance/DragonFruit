'use client';

export const SUPPORT_PLACEMENT_HELP_STORAGE_KEY = 'app-support-placement-help-enabled';

const SUPPORT_PLACEMENT_HELP_EVENT = 'app-support-placement-help-changed';

export const DEFAULT_SUPPORT_PLACEMENT_HELP_ENABLED = true;

export function getSupportPlacementHelpEnabled(): boolean {
  if (typeof window === 'undefined') return DEFAULT_SUPPORT_PLACEMENT_HELP_ENABLED;
  try {
    const raw = window.localStorage.getItem(SUPPORT_PLACEMENT_HELP_STORAGE_KEY);
    if (raw === null) return DEFAULT_SUPPORT_PLACEMENT_HELP_ENABLED;
    return raw === 'true';
  } catch {
    return DEFAULT_SUPPORT_PLACEMENT_HELP_ENABLED;
  }
}

export function setSupportPlacementHelpEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SUPPORT_PLACEMENT_HELP_STORAGE_KEY, String(enabled));
    window.dispatchEvent(new Event(SUPPORT_PLACEMENT_HELP_EVENT));
  } catch {
    // ignore storage errors
  }
}

export function subscribeSupportPlacementHelp(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = () => listener();
  window.addEventListener(SUPPORT_PLACEMENT_HELP_EVENT, handler);
  window.addEventListener('storage', handler);
  return () => {
    window.removeEventListener(SUPPORT_PLACEMENT_HELP_EVENT, handler);
    window.removeEventListener('storage', handler);
  };
}
