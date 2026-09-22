import { RaftSettings } from './RaftTypes';
import { DEFAULT_RAFT_SETTINGS } from './RaftDefaults';

let currentRaftSettings: RaftSettings = { ...DEFAULT_RAFT_SETTINGS };

/** Tracks per-model raft settings overrides */
const perModelRaftSettings: Map<string, RaftSettings> = new Map();

/** Flag indicating raft settings were manually changed in the current session */
let wasManuallyModifiedInSession = false;

const FOOTPRINT_BORDER_MARGIN_MAX_MM = 0.05;

function normalizeRaftSettings(settings: RaftSettings): RaftSettings {
  return {
    ...settings,
    footprintBorderMargin: Math.min(
      FOOTPRINT_BORDER_MARGIN_MAX_MM,
      Math.max(0, settings.footprintBorderMargin ?? DEFAULT_RAFT_SETTINGS.footprintBorderMargin),
    ),
  };
}

/**
 * The `wallEnabled` last chosen while the bottom mode was solid.
 *
 * A line base has no perimeter to wall, so its effective `wallEnabled` is
 * forced off. Without this, that forced value becomes indistinguishable from a
 * user choice and the mode round-trip Solid → Line → Solid silently comes back
 * with the wall off. Mode switches carry no `wallEnabled` in their patch, so
 * they restore from here; an explicit `wallEnabled` (the Wall toggle, a full
 * settings load) replaces it.
 */
let rememberedSolidWallEnabled = DEFAULT_RAFT_SETTINGS.wallEnabled;

/**
 * Resolve the effective settings for a write. `wallIsExplicit` says whether the
 * caller supplied a `wallEnabled` of its own; when it did not, the last solid
 * choice is restored instead of whatever the forced value happened to be.
 */
function resolveRaftSettings(next: RaftSettings, wallIsExplicit: boolean): RaftSettings {
  const normalized = normalizeRaftSettings(next);
  if (normalized.bottomMode !== 'solid') {
    return { ...normalized, wallEnabled: false };
  }
  const wallEnabled = wallIsExplicit ? normalized.wallEnabled : rememberedSolidWallEnabled;
  rememberedSolidWallEnabled = wallEnabled;
  return { ...normalized, wallEnabled };
}

type RaftStoreListener = () => void;
const listeners = new Set<RaftStoreListener>();

function notify() {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch (err) {
      console.error('[RaftStore] listener error', err);
    }
  });
}

export function getRaftSettings(): RaftSettings {
  return currentRaftSettings;
}

export function setRaftSettings(settings: RaftSettings): void {
  currentRaftSettings = resolveRaftSettings({ ...DEFAULT_RAFT_SETTINGS, ...settings }, true);
  wasManuallyModifiedInSession = true;
  notify();
}

export function updateRaftSettings(partial: Partial<RaftSettings>): void {
  const next = { ...DEFAULT_RAFT_SETTINGS, ...currentRaftSettings, ...partial };
  // A mode switch does not name a wall, so the mode round-trip keeps the last
  // solid choice rather than the off value the line mode forced.
  currentRaftSettings = resolveRaftSettings(
    next,
    Object.prototype.hasOwnProperty.call(partial, 'wallEnabled'),
  );
  wasManuallyModifiedInSession = true;
  notify();
}

/**
 * Apply raft settings from import defaults without marking as manually modified.
 * This allows import defaults to be overridden by subsequent manual changes.
 */
export function applyImportDefaultRaftSettings(settings: RaftSettings): void {
  currentRaftSettings = resolveRaftSettings({ ...DEFAULT_RAFT_SETTINGS, ...settings }, true);
  // Don't set wasManuallyModifiedInSession = true here to allow manual changes to take priority
  notify();
}

export function subscribeToRaftStore(listener: RaftStoreListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Query whether raft settings have been manually modified in this session.
 * Returns true if user explicitly changed raft settings (not just from import defaults).
 */
export function wasRaftSettingsManuallyModified(): boolean {
  return wasManuallyModifiedInSession;
}

/**
 * Reset the session modification flag (typically after loading a new scene).
 */
export function resetRaftSessionModificationFlag(): void {
  wasManuallyModifiedInSession = false;
}

/**
 * Get raft settings for a specific model, falling back to global settings.
 */
export function getRaftSettingsForModel(modelId: string | null | undefined): RaftSettings {
  if (!modelId) return getRaftSettings();
  return perModelRaftSettings.get(modelId) ?? getRaftSettings();
}

/**
 * Set per-model raft settings override.
 */
export function setRaftSettingsForModel(modelId: string, settings: RaftSettings): void {
  const normalized = normalizeRaftSettings(settings);
  perModelRaftSettings.set(modelId, {
    ...normalized,
    wallEnabled: normalized.bottomMode === 'solid' ? normalized.wallEnabled : false,
  });
  notify();
}

/**
 * Remove per-model raft settings override (revert to global).
 */
export function clearRaftSettingsForModel(modelId: string): void {
  perModelRaftSettings.delete(modelId);
  notify();
}

/**
 * Get all per-model raft settings overrides.
 */
export function getAllPerModelRaftSettings(): Map<string, RaftSettings> {
  return new Map(perModelRaftSettings);
}
