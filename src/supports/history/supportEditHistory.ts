import { pushHistory } from '@/history/historyStore';
import { SUPPORT_EDIT_REPLACE } from './actionTypes';
import { getSnapshot, type SupportState } from '../state';
import { getKickstandSnapshot, type KickstandState } from '../SupportTypes/Kickstand/kickstandStore';

export interface SupportEditHistorySnapshot {
  support: SupportState;
  kickstand: KickstandState;
}

export function captureSupportEditSnapshot(): SupportEditHistorySnapshot {
  return {
    support: getSnapshot(),
    kickstand: getKickstandSnapshot(),
  };
}

type SupportEditHistoryJob = {
  description: string;
  before: SupportEditHistorySnapshot;
  after: SupportEditHistorySnapshot;
};

const pendingJobs: SupportEditHistoryJob[] = [];
let flushScheduled = false;

function sanitizeSupportSnapshot(snapshot: SupportState): SupportState {
  const cloned = structuredClone(snapshot);
  cloned.selectedId = null;
  cloned.selectedCategory = null;
  cloned.hoveredId = null;
  cloned.hoveredCategory = 'none';
  return cloned;
}

function sanitizeKickstandSnapshot(snapshot: KickstandState): KickstandState {
  const cloned = structuredClone(snapshot);
  cloned.selectedId = null;
  return cloned;
}

function flushPendingJobs() {
  flushScheduled = false;

  const jobs = pendingJobs.splice(0, pendingJobs.length);
  for (const job of jobs) {
    pushHistory({
      type: SUPPORT_EDIT_REPLACE,
      description: job.description,
      payload: {
        before: sanitizeSupportSnapshot(job.before.support),
        after: sanitizeSupportSnapshot(job.after.support),
        kickstandBefore: sanitizeKickstandSnapshot(job.before.kickstand),
        kickstandAfter: sanitizeKickstandSnapshot(job.after.kickstand),
      },
    });
  }
}

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;

  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(() => flushPendingJobs(), { timeout: 250 });
  } else {
    setTimeout(flushPendingJobs, 0);
  }
}

export function pushSupportEditHistory(
  description: string,
  before: SupportEditHistorySnapshot,
  after: SupportEditHistorySnapshot,
) {
  pendingJobs.push({ description, before, after });
  scheduleFlush();
}
