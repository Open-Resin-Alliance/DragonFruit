// v5: layouts before this stored *derived* positions as well as moved ones, so a
// stale order could keep overriding the profile. Only moved panels are stored now,
// and the version bump drops the layouts written by the old code.
export const FLOATING_LAYOUT_STORAGE_KEY = 'lumenslicer:floating-panel-layout:v5';
export const FLOATING_LAYOUT_PERSISTENCE_STORAGE_KEY = 'app-floating-layout-persistence';
export const FLOATING_LAYOUT_PERSISTENCE_EVENT = 'lumenslicer:floating-layout-persistence-changed';
export const FLOATING_LAYOUT_DEBUG_REQUEST_EVENT = 'lumenslicer:floating-layout-debug-request';
export const DEBUG_PRIMITIVES_PANEL_VISIBILITY_STORAGE_KEY = 'app-debug-primitives-panel-visible';
export const DEBUG_PRIMITIVES_PANEL_VISIBILITY_EVENT = 'lumenslicer:debug-primitives-panel-visibility-changed';
export const MODELS_PANEL_VISIBILITY_STORAGE_KEY = 'app-models-panel-visible';
export const TOOL_LAYOUT_STORAGE_KEY = 'app-tool-layout';
export const TOOL_LAYOUT_EVENT = 'lumenslicer:tool-layout-changed';

/**
 * Where the tool entries live: a column down the left edge, or a bar centred
 * under the app bar. The horizontal form takes no room from the panel stack, so
 * the stack's left inset follows this.
 */
export type ToolLayout = 'vertical' | 'horizontal';

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
  if (typeof window === 'undefined') return false;

  const raw = window.localStorage.getItem(DEBUG_PRIMITIVES_PANEL_VISIBILITY_STORAGE_KEY);
  if (raw == null) return false;
  return raw !== 'false';
}

export function setDebugPrimitivesPanelVisibleEnabled(enabled: boolean) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(DEBUG_PRIMITIVES_PANEL_VISIBILITY_STORAGE_KEY, enabled ? 'true' : 'false');
  window.dispatchEvent(new CustomEvent(DEBUG_PRIMITIVES_PANEL_VISIBILITY_EVENT, { detail: { enabled } }));
}

/**
 * Whether the model list is shown. Unlike the debug panel it starts visible, so
 * an absent key means shown; hiding it is what gets remembered.
 */
export function isModelsPanelVisibleEnabled(): boolean {
  if (typeof window === 'undefined') return true;

  const raw = window.localStorage.getItem(MODELS_PANEL_VISIBILITY_STORAGE_KEY);
  if (raw == null) return true;
  return raw !== 'false';
}

export function setModelsPanelVisibleEnabled(enabled: boolean) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(MODELS_PANEL_VISIBILITY_STORAGE_KEY, enabled ? 'true' : 'false');
}

export function getToolLayout(): ToolLayout {
  if (typeof window === 'undefined') return 'vertical';

  return window.localStorage.getItem(TOOL_LAYOUT_STORAGE_KEY) === 'horizontal' ? 'horizontal' : 'vertical';
}

export function setToolLayout(layout: ToolLayout) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(TOOL_LAYOUT_STORAGE_KEY, layout);
  window.dispatchEvent(new CustomEvent(TOOL_LAYOUT_EVENT, { detail: { layout } }));
}
