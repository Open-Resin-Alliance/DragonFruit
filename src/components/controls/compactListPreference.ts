const COMPACT_LIST_STORAGE_KEY = 'model-list-compact';

export function getCompactListPreference(): boolean {
  if (typeof window === 'undefined') return false;

  try {
    const raw = window.localStorage.getItem(COMPACT_LIST_STORAGE_KEY);
    return raw === 'true';
  } catch {
    return false;
  }
}

export function saveCompactListPreference(compact: boolean): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(COMPACT_LIST_STORAGE_KEY, String(compact));
  } catch {
    // ignore storage failures
  }
}
