import type { MessageDescriptor } from '@lingui/core';
import { pushSupportHistory } from '@/supports/history/supportHistory';
import { SUPPORT_EDIT_REPLACE } from './actionTypes';
import { SUPPORT_COLLECTION_KEYS } from '../supportTypeRegistry';
import { getSnapshot, type SupportState } from '../state';
import { clonePlainData } from '@/utils/plainDataClone';

export interface SupportEditHistorySnapshot {
  support: SupportState;
}

export function captureSupportEditSnapshot(): SupportEditHistorySnapshot {
  return { support: getSnapshot() };
}

type SupportEditHistoryJob = {
  description: MessageDescriptor;
  before: SupportState;
  after: SupportState;
};

const pendingJobs: SupportEditHistoryJob[] = [];
let flushScheduled = false;

/**
 * A snapshot without the interaction fields, so undo does not restore a stale
 * selection. Shallow: the store replaces its state rather than mutating it.
 */
function withoutInteractionState(snapshot: SupportState): SupportState {
  return {
    ...snapshot,
    selectedId: null,
    selectedCategory: null,
    hoveredId: null,
    hoveredCategory: 'none',
  };
}

/** Pushes every queued entry, oldest first. */
export function flushSupportEditHistory(): void {
  flushScheduled = false;
  if (pendingJobs.length === 0) return;

  const jobs = pendingJobs.splice(0, pendingJobs.length);
  for (const job of jobs) {
    pushSupportHistory({
      type: SUPPORT_EDIT_REPLACE,
      description: job.description,
      // Copied once here and owned from then on, so the store does not clone
      // two whole support states again on every push, undo and redo.
      payload: { before: clonePlainData(job.before), after: clonePlainData(job.after) },
    }, { payloadOwned: true });
  }
}

/** Drops queued entries, for a caller clearing the stacks they would land on. */
export function cancelPendingSupportEditHistory(): void {
  pendingJobs.length = 0;
  flushScheduled = false;
}

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;

  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(() => flushSupportEditHistory(), { timeout: 250 });
  } else {
    setTimeout(flushSupportEditHistory, 0);
  }
}

/**
 * Whether an edit changed anything worth an undo step. Collection identity
 * first, which `normaliseSupportState` keeps across a hover-only write.
 */
function changedAnything(before: SupportState, after: SupportState): boolean {
  const touched = SUPPORT_COLLECTION_KEYS.filter((key) => before[key] !== after[key]);
  if (touched.length === 0) return false;
  return touched.some((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

/**
 * Records a whole-state support edit, pushed when the main thread next idles:
 * each payload is cloned once at the flush, which is tens of milliseconds on a
 * large scene. An edit that changed nothing is dropped.
 */
export function pushSupportEditHistory(
  description: MessageDescriptor,
  before: SupportEditHistorySnapshot,
  after: SupportEditHistorySnapshot,
) {
  if (!changedAnything(before.support, after.support)) return;

  pendingJobs.push({
    description,
    before: withoutInteractionState(before.support),
    after: withoutInteractionState(after.support),
  });
  scheduleFlush();
}
