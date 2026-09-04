/**
 * Main-thread stall detector — the "slow query log" of the UI.
 *
 * A timer that should fire every {@link TICK_MS} measures how late it actually
 * woke up. The main thread is single-threaded: if the timer is 12 seconds late,
 * something held the thread for 12 seconds and the UI was frozen for exactly
 * that long.
 *
 * A late timer alone is not evidence: WebKit aligns and throttles timers when
 * the window loses focus, which reads from in here exactly like a blocked
 * thread and produced hundreds of phantom reports before this was corrected. So
 * a report needs two witnesses — the timer arrived late AND the animation frame
 * clock also stopped. Frames are not subject to that alignment, so if they kept
 * coming the thread was never blocked.
 *
 * What it CANNOT do is say which function was responsible — while the thread is
 * blocked no JavaScript runs, so there is nothing to sample from. What it does
 * give is the gesture that preceded the freeze, which is the part users can
 * never describe and the part needed to reproduce it. Take the report to
 * `sample <pid>` from there.
 *
 * Reports land in dragonfruit.log at WARN, so a user only has to send the log.
 */

import { attachHeartbeatContext, describeHeartbeatContext } from './heartbeatContext';

/** How often the heartbeat wakes up.
 *
 *  This is the measurement granularity, and it cuts twice: a stall is only
 *  noticed once a tick is `threshold` ms late, so a block starting right after
 *  a tick gets one free tick before the clock starts, and the reported duration
 *  understates the real block by up to one tick. Keeping it well below the
 *  threshold bounds both errors. A no-op timer at 10 Hz costs nothing. */
const TICK_MS = 100;

/** Default lateness before a tick is considered a stall. Analogous to MySQL's
 *  `long_query_time`: low enough to catch what a user notices, high enough that
 *  a legitimately heavy frame does not fill the log with noise. */
const DEFAULT_STALL_THRESHOLD_MS = 500;

const THRESHOLD_STORAGE_KEY = 'df.debug.stallThresholdMs';

/**
 * Gaps beyond this are the machine sleeping or the app being suspended, not a
 * stall. Nothing was running to be blocked, and no real freeze lasts minutes.
 */
const SUSPENSION_MS = 60_000;

function readThresholdMs(): number {
    try {
        const raw = window.localStorage.getItem(THRESHOLD_STORAGE_KEY);
        if (!raw) return DEFAULT_STALL_THRESHOLD_MS;
        const parsed = Number.parseInt(raw, 10);
        // Below one tick the detector would report its own scheduling jitter.
        if (!Number.isFinite(parsed) || parsed < TICK_MS) return DEFAULT_STALL_THRESHOLD_MS;
        return parsed;
    } catch {
        return DEFAULT_STALL_THRESHOLD_MS;
    }
}

type LogFn = (message: string) => void;

async function resolveWarn(): Promise<LogFn> {
    const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    if (!isTauri) return (message) => console.warn(message);

    try {
        const { warn } = await import('@tauri-apps/plugin-log');
        return (message) => {
            void warn(message);
        };
    } catch {
        return (message) => console.warn(message);
    }
}

/**
 * Starts the detector. Returns a stop function; calling it twice is safe.
 * A second call while already running is a no-op.
 */
export function startMainThreadHeartbeat(): () => void {
    if (typeof window === 'undefined') return () => { };

    const thresholdMs = readThresholdMs();
    let warn: LogFn = (message) => console.warn(message);
    void resolveWarn().then((fn) => { warn = fn; });

    let expectedAt = performance.now() + TICK_MS;

    // Second witness: frames keep arriving unless the thread is genuinely stuck.
    let lastFrameAt = performance.now();
    let frameHandle = 0;
    const onFrame = () => {
        lastFrameAt = performance.now();
        frameHandle = window.requestAnimationFrame(onFrame);
    };
    frameHandle = window.requestAnimationFrame(onFrame);

    // A hidden or minimised window has its timers throttled by the OS, which
    // looks identical to a stall from in here. Skip the tick that spans a
    // visibility change, and every tick while hidden.
    let skipNextTick = false;
    const handleVisibilityChange = () => { skipNextTick = true; };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    const detachContext = attachHeartbeatContext();

    const intervalId = window.setInterval(() => {
        const now = performance.now();
        const latenessMs = now - expectedAt;
        expectedAt = now + TICK_MS;

        const skip = skipNextTick || document.hidden;
        skipNextTick = false;
        if (skip) return;

        if (latenessMs < thresholdMs) return;

        // The frame clock is the arbiter, and it also measures the block better:
        // it counts from the last frame actually painted, not from when a timer
        // was scheduled.
        const frameGapMs = now - lastFrameAt;
        if (frameGapMs < thresholdMs) return;
        if (frameGapMs > SUSPENSION_MS) return;

        // Round: sub-millisecond precision on a multi-second freeze is noise.
        warn(
            `[stall] Main thread blocked for ${Math.round(frameGapMs)} ms `
            + `(threshold ${thresholdMs} ms) — ${describeHeartbeatContext()}`,
        );
    }, TICK_MS);

    return () => {
        window.cancelAnimationFrame(frameHandle);
        window.clearInterval(intervalId);
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        detachContext();
    };
}
