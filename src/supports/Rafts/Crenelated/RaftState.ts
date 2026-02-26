import { RaftSettings } from './RaftTypes';
import { DEFAULT_RAFT_SETTINGS } from './RaftDefaults';

let currentRaftSettings: RaftSettings = { ...DEFAULT_RAFT_SETTINGS };

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
  const next = { ...DEFAULT_RAFT_SETTINGS, ...settings };
  const normalized = normalizeRaftSettings(next);
  currentRaftSettings = {
    ...normalized,
    wallEnabled: normalized.bottomMode === 'off' ? false : normalized.wallEnabled,
  };
  notify();
}

export function updateRaftSettings(partial: Partial<RaftSettings>): void {
  const next = { ...DEFAULT_RAFT_SETTINGS, ...currentRaftSettings, ...partial };
  const normalized = normalizeRaftSettings(next);
  currentRaftSettings = {
    ...normalized,
    wallEnabled: normalized.bottomMode === 'off' ? false : normalized.wallEnabled,
  };
  notify();
}

export function subscribeToRaftStore(listener: RaftStoreListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
