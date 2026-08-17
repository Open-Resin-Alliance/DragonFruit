import { warn as logWarn } from '@tauri-apps/plugin-log';

/**
 * A main-thread stall detector. A steady interval that should fire every
 * {@link TICK_MS} is scheduled; whenever the *actual* gap between fires exceeds
 * {@link STALL_THRESHOLD_MS}, the main thread was blocked (a long synchronous
 * task starved the event loop) and we log how long, plus whatever phase marker
 * was active at the time.
 *
 * This exists to localize an autosave-correlated UI freeze without guessing
 * which span is to blame: arm it once, set a phase marker around each suspect
 * span, reproduce once, and the log names the culprit and its duration.
 *
 * DIAGNOSTIC — remove once the freeze is localized and fixed.
 */

const TICK_MS = 100;
const STALL_THRESHOLD_MS = 150;

let timer: ReturnType<typeof setInterval> | null = null;
let lastTickAt = 0;
let currentPhase = 'idle';
/** The phase that was active when the *previous* tick ran — the span that spanned the gap. */
let phaseAtLastTick = 'idle';

const nowMs = (): number => globalThis.performance?.now?.() ?? Date.now();

/**
 * Marks the span the app is currently in. The stall log reports the phase that
 * was active across the blocked interval, so a freeze inside this span is
 * attributed to it by name. Returns the previous phase so callers can restore
 * it, but most callers just set 'idle' when done.
 */
export function setStallPhase(phase: string): string {
  const prev = currentPhase;
  currentPhase = phase;
  return prev;
}

/** Runs `fn`, tagging any stall inside it with `phase`, and always restores. */
export async function withStallPhase<T>(phase: string, fn: () => Promise<T>): Promise<T> {
  const prev = setStallPhase(phase);
  try {
    return await fn();
  } finally {
    setStallPhase(prev);
  }
}

export function armStallWatch(): void {
  if (timer !== null) return;
  if (typeof window === 'undefined') return;
  lastTickAt = nowMs();
  phaseAtLastTick = currentPhase;
  timer = setInterval(() => {
    const now = nowMs();
    const gap = now - lastTickAt;
    const drift = gap - TICK_MS;
    if (drift >= STALL_THRESHOLD_MS) {
      // `phaseAtLastTick` is the phase active going INTO the gap — i.e. the span
      // that actually blocked. `currentPhase` is where we are now (often the
      // same, or already moved on if the span finished during the stall).
      void logWarn(
        `[StallWatch] main thread blocked ${drift.toFixed(0)}ms`
        + ` | phase=${phaseAtLastTick}`
        + (currentPhase !== phaseAtLastTick ? ` → ${currentPhase}` : ''),
      ).catch(() => {});
    }
    lastTickAt = now;
    phaseAtLastTick = currentPhase;
  }, TICK_MS);
}

export function disarmStallWatch(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}
