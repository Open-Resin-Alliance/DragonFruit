/**
 * Pure arithmetic behind the performance probes in this folder, kept apart so
 * it can be tested without a DOM or a clock.
 */

export interface FrameGapSummary {
    frames: number;
    fps: number;
    p50Ms: number;
    p95Ms: number;
    maxMs: number;
    /** Frames that took longer than 50 ms: a stutter anyone notices. */
    over50: number;
    /** Frames that took longer than 100 ms: the view visibly stops. */
    over100: number;
}

/** Nearest-rank percentile of an ascending array. */
function percentile(sorted: number[], fraction: number): number {
    if (sorted.length === 0) return 0;
    const rank = Math.ceil(fraction * sorted.length) - 1;
    return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

/** Summarises the gaps between consecutive animation frames, in ms. */
export function summarizeFrameGaps(gapsMs: readonly number[]): FrameGapSummary {
    const sorted = [...gapsMs].sort((a, b) => a - b);
    const total = sorted.reduce((sum, gap) => sum + gap, 0);
    return {
        frames: sorted.length,
        fps: total > 0 ? (sorted.length * 1000) / total : 0,
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        maxMs: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
        over50: sorted.filter((gap) => gap > 50).length,
        over100: sorted.filter((gap) => gap > 100).length,
    };
}

export interface CommitStormThresholds {
    /** Commits within one second that count as a storm second. */
    perSecond: number;
    /** Consecutive storm seconds before reporting. */
    sustainedSeconds: number;
    /** Commits within one task, reported at once. */
    perTask: number;
}

export const DEFAULT_COMMIT_STORM_THRESHOLDS: CommitStormThresholds = {
    perSecond: 30,
    sustainedSeconds: 2,
    perTask: 20,
};

export interface CommitStormVerdict {
    report: boolean;
    reason: 'sustained' | 'burst' | null;
}

/**
 * Decides, once per second, whether the commits counted in that second are a
 * storm. React aborts a synchronous chain at 50 nested updates (error #185);
 * a burst of `perTask` without yielding to the browser is that chain getting
 * close. A steady `perSecond` rate is a re-render loop that never trips
 * React's limit but still eats the main thread.
 */
export class CommitStormDetector {
    private stormSeconds = 0;

    constructor(private readonly thresholds: CommitStormThresholds = DEFAULT_COMMIT_STORM_THRESHOLDS) {}

    evaluate(commitsPerSecond: number, maxCommitsInOneTask: number): CommitStormVerdict {
        this.stormSeconds = commitsPerSecond >= this.thresholds.perSecond ? this.stormSeconds + 1 : 0;
        if (maxCommitsInOneTask >= this.thresholds.perTask) {
            return { report: true, reason: 'burst' };
        }
        if (this.stormSeconds >= this.thresholds.sustainedSeconds) {
            return { report: true, reason: 'sustained' };
        }
        return { report: false, reason: null };
    }
}
