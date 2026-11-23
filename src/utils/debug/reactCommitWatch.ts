/**
 * Re-render storms: React committing far more often than anything on screen
 * changes.
 *
 * Production React does not call `<Profiler onRender>`, but it does report
 * every commit to the DevTools global hook when one is present, which is how
 * React DevTools works on production sites. {@link installReactCommitHook}
 * provides a minimal hook that only counts; it must run before react-dom is
 * evaluated, so it is called from `src/instrumentation-client.ts`. The scene's
 * react-three-fiber reconciler registers with the same hook, so DOM and scene
 * commits are counted apart.
 *
 * Once a second the counts go to a {@link CommitStormDetector}. A burst of
 * commits within one task is a synchronous update chain, the shape that ends
 * in React error #185; a sustained rate is a loop that never trips React's
 * limit but keeps the main thread busy. Either way one line is logged, with
 * the last gesture, and then nothing for a cooldown so a loop cannot fill the
 * log.
 *
 * Tasks, not animation frames, delimit a burst, and the rate is taken over the
 * time that actually passed: a hidden or minimised window stops animation
 * frames and throttles timers, and counting by either would add up minutes of
 * ordinary commits into one false storm.
 */

import { describeHeartbeatContext } from './heartbeatContext';
import type { PerfLogger } from './perfLog';
import { CommitStormDetector } from './perfStats';

interface RendererCounts {
    name: string;
    sinceLastCheck: number;
    thisTask: number;
    maxInOneTask: number;
}

const renderers = new Map<number, RendererCounts>();
let nextRendererId = 1;

interface DevToolsHook {
    supportsFiber?: boolean;
    isDisabled?: boolean;
    inject?: (internals: { rendererPackageName?: string }) => number;
    onCommitFiberRoot?: (...args: unknown[]) => void;
    onCommitFiberUnmount?: (...args: unknown[]) => void;
    onPostCommitFiberRoot?: (...args: unknown[]) => void;
    checkDCE?: () => void;
    renderers?: Map<number, unknown>;
}

// A message posted from inside a task is delivered once that task, and the
// microtasks it queued, have finished: the end of the synchronous stretch.
let taskEndChannel: MessageChannel | null = null;
let taskOpen = false;

function closeTask(): void {
    taskOpen = false;
    for (const counts of renderers.values()) {
        counts.maxInOneTask = Math.max(counts.maxInOneTask, counts.thisTask);
        counts.thisTask = 0;
    }
}

function countCommit(rendererId: unknown): void {
    const counts = typeof rendererId === 'number' ? renderers.get(rendererId) : undefined;
    if (!counts) return;
    counts.sinceLastCheck += 1;
    counts.thisTask += 1;
    if (taskOpen) return;
    if (!taskEndChannel) {
        taskEndChannel = new MessageChannel();
        taskEndChannel.port1.onmessage = closeTask;
    }
    taskOpen = true;
    taskEndChannel.port2.postMessage(null);
}

function registerRenderer(id: number, internals: { rendererPackageName?: string }): void {
    renderers.set(id, {
        name: internals.rendererPackageName ?? `renderer-${id}`,
        sinceLastCheck: 0,
        thisTask: 0,
        maxInOneTask: 0,
    });
}

/**
 * Installs the counting hook, or wraps the one React DevTools installed.
 * Safe to call more than once.
 */
export function installReactCommitHook(): void {
    if (typeof window === 'undefined') return;
    const scope = window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: DevToolsHook & { __dfCounting?: boolean } };
    const existing = scope.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (existing?.__dfCounting) return;

    if (existing && typeof existing.inject === 'function') {
        const inject = existing.inject.bind(existing);
        const onCommit = existing.onCommitFiberRoot?.bind(existing);
        existing.inject = (internals) => {
            const id = inject(internals);
            registerRenderer(id, internals);
            return id;
        };
        existing.onCommitFiberRoot = (...args: unknown[]) => {
            countCommit(args[0]);
            onCommit?.(...args);
        };
        existing.__dfCounting = true;
        return;
    }

    scope.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        __dfCounting: true,
        supportsFiber: true,
        renderers: new Map(),
        inject(internals) {
            const id = nextRendererId;
            nextRendererId += 1;
            registerRenderer(id, internals);
            return id;
        },
        onCommitFiberRoot(rendererId: unknown) {
            countCommit(rendererId);
        },
        onCommitFiberUnmount() { },
        onPostCommitFiberRoot() { },
        checkDCE() { },
    };
}

/** How long to stay quiet after a report. */
const COOLDOWN_MS = 10_000;
/** A check this late means throttled timers: the rate over it says nothing. */
const THROTTLED_CHECK_MS = 2_000;

export function startReactCommitWatch(logger: PerfLogger): () => void {
    if (typeof window === 'undefined') return () => { };

    const detectors = new Map<number, CommitStormDetector>();
    let quietUntil = 0;
    let lastCheckAt = performance.now();

    const intervalId = window.setInterval(() => {
        const now = performance.now();
        const elapsedMs = now - lastCheckAt;
        lastCheckAt = now;
        for (const [id, counts] of renderers) {
            const commits = counts.sinceLastCheck;
            const maxInOneTask = counts.maxInOneTask;
            counts.sinceLastCheck = 0;
            counts.maxInOneTask = 0;

            let detector = detectors.get(id);
            if (!detector) {
                detector = new CommitStormDetector();
                detectors.set(id, detector);
            }
            const perSecond = elapsedMs <= THROTTLED_CHECK_MS ? (commits * 1000) / elapsedMs : 0;
            const verdict = detector.evaluate(perSecond, maxInOneTask);
            if (!verdict.report || now < quietUntil || document.hidden) continue;

            quietUntil = now + COOLDOWN_MS;
            logger.warn(
                `[perf:commits] ${counts.name}: ${commits} commits in ${(elapsedMs / 1000).toFixed(1)} s, `
                + `up to ${maxInOneTask} in one task (${verdict.reason}) — `
                + describeHeartbeatContext(),
            );
        }
    }, 1000);

    return () => {
        window.clearInterval(intervalId);
    };
}
