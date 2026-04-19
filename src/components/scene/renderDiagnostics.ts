/**
 * In demand mode, useFrame only fires on actually-rendered frames, so a single
 * useFrame callback that calls recordFrame() is a perfect render-rate probe.
 * Production builds should not mount the probe — see RenderDiagnosticsOverlay.
 */

export interface RenderStats {
  totalRenders: number;
  rendersPerSec: number;
  windowStartedAt: number;
  invalidations: number;
}

interface State {
  totalRenders: number;
  windowRenders: number;
  windowStartedAt: number;
  cachedRate: number;
  lastEmitAt: number;
  invalidations: number;
}

type Listener = (stats: RenderStats) => void;

const WINDOW_MS = 1000;
const EMIT_THROTTLE_MS = 100;

function createInitialState(now: number): State {
  return {
    totalRenders: 0,
    windowRenders: 0,
    windowStartedAt: now,
    cachedRate: 0,
    lastEmitAt: 0,
    invalidations: 0,
  };
}

let state: State = createInitialState(0);
const listeners = new Set<Listener>();

function readStats(): RenderStats {
  return {
    totalRenders: state.totalRenders,
    rendersPerSec: state.cachedRate,
    windowStartedAt: state.windowStartedAt,
    invalidations: state.invalidations,
  };
}

function emit(now: number): void {
  if (now - state.lastEmitAt < EMIT_THROTTLE_MS) return;
  state.lastEmitAt = now;
  const snapshot = readStats();
  listeners.forEach((listener) => listener(snapshot));
}

/** Called from a useFrame hook mounted inside the Canvas. */
export function recordFrame(now: number = performance.now()): void {
  state.totalRenders++;
  state.windowRenders++;

  const windowAge = now - state.windowStartedAt;
  if (windowAge >= WINDOW_MS) {
    state.cachedRate = state.windowRenders / (windowAge / 1000);
    state.windowRenders = 0;
    state.windowStartedAt = now;
  }

  emit(now);
}

/** Called from a wrapped invalidate() to track request volume for GH #3186 monitoring. */
export function recordInvalidation(now: number = performance.now()): void {
  state.invalidations++;
  emit(now);
}

export function getRenderStats(): RenderStats {
  return readStats();
}

export function subscribeToRenderStats(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetRenderStats(now: number = performance.now()): void {
  state = createInitialState(now);
  const snapshot = readStats();
  listeners.forEach((listener) => listener(snapshot));
}
