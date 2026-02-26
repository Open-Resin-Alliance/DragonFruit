import type { PickableCategory, PickableRegistration } from './types';

type PickingCategoryCounts = Record<PickableCategory, number>;

export type PickingDiagnosticsSnapshot = {
  totalRegistrations: number;
  registrationsByCategory: PickingCategoryCounts;
  cachedPickObjects: number;
  visiblePickObjects: number;
  lastPickDurationMs: number;
  avgPickDurationMs: number;
  lastSyncDurationMs: number;
  avgSyncDurationMs: number;
  picksPerSecond: number;
  lastUpdatedAt: number;
  isPaused: boolean;
  isDragging: boolean;
  enabled: boolean;
};

const EMPTY_CATEGORY_COUNTS: PickingCategoryCounts = {
  model: 0,
  support: 0,
  joint: 0,
  knot: 0,
  segment: 0,
  raft: 0,
  gizmo: 0,
  none: 0,
};

let snapshot: PickingDiagnosticsSnapshot = {
  totalRegistrations: 0,
  registrationsByCategory: { ...EMPTY_CATEGORY_COUNTS },
  cachedPickObjects: 0,
  visiblePickObjects: 0,
  lastPickDurationMs: 0,
  avgPickDurationMs: 0,
  lastSyncDurationMs: 0,
  avgSyncDurationMs: 0,
  picksPerSecond: 0,
  lastUpdatedAt: 0,
  isPaused: false,
  isDragging: false,
  enabled: true,
};

let recentPickCount = 0;
let picksWindowStartMs = performance.now();

function bumpTimestamp() {
  snapshot = {
    ...snapshot,
    lastUpdatedAt: performance.now(),
  };
}

export function getPickingDiagnosticsSnapshot(): PickingDiagnosticsSnapshot {
  return snapshot;
}

export function reportPickingRegistrations(registrations: Map<number, PickableRegistration>) {
  const nextCounts: PickingCategoryCounts = { ...EMPTY_CATEGORY_COUNTS };
  for (const registration of registrations.values()) {
    nextCounts[registration.category] = (nextCounts[registration.category] ?? 0) + 1;
  }

  snapshot = {
    ...snapshot,
    totalRegistrations: registrations.size,
    registrationsByCategory: nextCounts,
  };
  bumpTimestamp();
}

export function reportPickingRuntimeState(state: { enabled: boolean; isPaused: boolean; isDragging: boolean }) {
  snapshot = {
    ...snapshot,
    enabled: state.enabled,
    isPaused: state.isPaused,
    isDragging: state.isDragging,
  };
  bumpTimestamp();
}

export function reportPickingRenderSample(sample: {
  pickDurationMs: number;
  syncDurationMs: number;
  cachedPickObjects: number;
  visiblePickObjects: number;
}) {
  const now = performance.now();
  recentPickCount += 1;

  const elapsedMs = now - picksWindowStartMs;
  let picksPerSecond = snapshot.picksPerSecond;
  if (elapsedMs >= 1000) {
    picksPerSecond = (recentPickCount * 1000) / Math.max(1, elapsedMs);
    picksWindowStartMs = now;
    recentPickCount = 0;
  }

  const smoothing = 0.18;
  const avgPickDurationMs = snapshot.avgPickDurationMs <= 0
    ? sample.pickDurationMs
    : (snapshot.avgPickDurationMs * (1 - smoothing)) + (sample.pickDurationMs * smoothing);
  const avgSyncDurationMs = snapshot.avgSyncDurationMs <= 0
    ? sample.syncDurationMs
    : (snapshot.avgSyncDurationMs * (1 - smoothing)) + (sample.syncDurationMs * smoothing);

  snapshot = {
    ...snapshot,
    lastPickDurationMs: sample.pickDurationMs,
    avgPickDurationMs,
    lastSyncDurationMs: sample.syncDurationMs,
    avgSyncDurationMs,
    cachedPickObjects: sample.cachedPickObjects,
    visiblePickObjects: sample.visiblePickObjects,
    picksPerSecond,
  };
  bumpTimestamp();
}
