export const FLOATING_LAYOUT_STORAGE_KEY = 'lumenslicer:floating-panel-layout:v4';
export const FLOATING_LAYOUT_PERSISTENCE_STORAGE_KEY = 'app-floating-layout-persistence';
export const FLOATING_LAYOUT_PERSISTENCE_EVENT = 'lumenslicer:floating-layout-persistence-changed';
export const FLOATING_LAYOUT_DEBUG_REQUEST_EVENT = 'lumenslicer:floating-layout-debug-request';
export const DEBUG_PRIMITIVES_PANEL_VISIBILITY_STORAGE_KEY = 'app-debug-primitives-panel-visible';
export const DEBUG_PRIMITIVES_PANEL_VISIBILITY_EVENT = 'lumenslicer:debug-primitives-panel-visibility-changed';

export type FloatingPanelPosition = {
  x: number;
  y: number;
};

export type FloatingLayoutDebugSnapshot = {
  version: 1;
  capturedAt: string;
  persistenceEnabled: boolean;
  storageKey: string;
  panelIds: string[];
  positions: Record<string, FloatingPanelPosition>;
};

export type FloatingLayoutDebugRequestDetail = {
  onResult?: (snapshot: FloatingLayoutDebugSnapshot) => void;
};

export function isFloatingLayoutPersistenceEnabled(): boolean {
  if (typeof window === 'undefined') return true;

  const raw = window.localStorage.getItem(FLOATING_LAYOUT_PERSISTENCE_STORAGE_KEY);
  if (raw == null) return true;
  return raw !== 'false';
}

export function setFloatingLayoutPersistenceEnabled(enabled: boolean) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(FLOATING_LAYOUT_PERSISTENCE_STORAGE_KEY, enabled ? 'true' : 'false');
  window.dispatchEvent(new CustomEvent(FLOATING_LAYOUT_PERSISTENCE_EVENT, { detail: { enabled } }));
}

export function clearSavedFloatingLayout() {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(FLOATING_LAYOUT_STORAGE_KEY);
}

export function isDebugPrimitivesPanelVisibleEnabled(): boolean {
  if (typeof window === 'undefined') return true;

  const raw = window.localStorage.getItem(DEBUG_PRIMITIVES_PANEL_VISIBILITY_STORAGE_KEY);
  if (raw == null) return true;
  return raw !== 'false';
}

export function setDebugPrimitivesPanelVisibleEnabled(enabled: boolean) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(DEBUG_PRIMITIVES_PANEL_VISIBILITY_STORAGE_KEY, enabled ? 'true' : 'false');
  window.dispatchEvent(new CustomEvent(DEBUG_PRIMITIVES_PANEL_VISIBILITY_EVENT, { detail: { enabled } }));
}
