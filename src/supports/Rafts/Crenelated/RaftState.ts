import { RaftSettings } from './RaftTypes';
import { DEFAULT_RAFT_SETTINGS } from './RaftDefaults';

let currentRaftSettings: RaftSettings = { ...DEFAULT_RAFT_SETTINGS };

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
  currentRaftSettings = settings;
  notify();
}

export function subscribeToRaftStore(listener: RaftStoreListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
