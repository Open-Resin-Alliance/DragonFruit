/**
 * pathfindingPerf — Lightweight performance diagnostics for support pathfinding.
 *
 * Tracks wall-clock timing for each phase of support placement and
 * automatically flags operations that exceed latency thresholds.
 *
 * Usage:
 *   import { perfMark, perfMeasure, getPerfReport } from './pathfindingPerf';
 *
 *   perfMark('trunk:build');
 *   // ... do work ...
 *   perfMeasure('trunk:build', 'buildTrunkData');
 *
 *   // At end of frame:
 *   const report = getPerfReport();
 *   if (report.hasSpikes) console.warn(report);
 */

// ---------- Types ----------

export interface PerfPhase {
    /** Phase label (e.g. 'trunk:build', 'branch:cone-search'). */
    label: string;
    /** Wall-clock duration in milliseconds. */
    durationMs: number;
    /** `performance.now()` when the phase started. */
    startTime: number;
}

export interface PerfSpike {
    phase: string;
    durationMs: number;
    thresholdMs: number;
    startTime: number;
}

export interface PerfFrame {
    /** Monotonic frame id. */
    frameId: number;
    /** All phases in this frame, ordered by start time. */
    phases: PerfPhase[];
    /** Total frame duration (first mark to last measure). */
    totalMs: number;
    /** Phases that exceeded their thresholds. */
    spikes: PerfSpike[];
    /** `performance.now()` at end of frame. */
    endTime: number;
}

export interface PerfReport {
    /** Current frame timing data. */
    current: PerfFrame | null;
    /** Rolling history of recent frames (most recent last). */
    history: PerfFrame[];
    /** True if the current frame has any lag spikes. */
    hasSpikes: boolean;
    /** Summary of the worst spike in the current frame. */
    worstSpike: PerfSpike | null;
    /** Total number of frames tracked. */
    totalFrames: number;
    /** Number of frames that had spikes. */
    spikeFrameCount: number;
}

// ---------- Configuration ----------

export interface PerfConfig {
    /** Maximum number of frames to keep in history. */
    maxHistoryFrames: number;
    /** Thresholds (ms) per phase label. Exceeding triggers a spike flag. */
    thresholds: Record<string, number>;
    /** Default threshold for phases without a specific entry. */
    defaultThresholdMs: number;
    /** When true, console.warn on any spike. */
    logSpikes: boolean;
}

const DEFAULT_CONFIG: PerfConfig = {
    maxHistoryFrames: 120,
    thresholds: {
        'trunk:build': 70,
        'trunk:v2-placement': 65,
        'trunk:v2-setup': 30,
        'trunk:build-from-placement': 10,
        'trunk:cone-rescue': 55,
        'trunk:cone-rescue:jointed': 50,
        'trunk:cone-rescue:seed': 20,
        'trunk:preflight': 5,
        'trunk:pre-a-star': 5,
        'trunk:astar': 25,
        'trunk:astar:wide': 25,
        'branch:build': 30,
        'branch:cone-search': 18,
        'branch:cavity-stick': 12,
        'branch:collision': 12,
        'grid:decision': 30,
        'grid:attachment-search': 15,
        'grid:collision-check': 10,
        'hover:total': 50,
    },
    defaultThresholdMs: 16, // one frame at 60fps
    logSpikes: false,
};

// ---------- State ----------

let config: PerfConfig = { ...DEFAULT_CONFIG };
let frameId = 0;
let currentPhases: PerfPhase[] = [];
let currentMarks = new Map<string, number>();
let history: PerfFrame[] = [];
let totalFrames = 0;
let spikeFrameCount = 0;

// ---------- API ----------

/** Start timing a phase. Call before the work. */
export function perfMark(label: string): void {
    currentMarks.set(label, performance.now());
}

/**
 * End timing a phase and record the duration.
 * @param markLabel — must match a previous `perfMark` call.
 * @param phaseLabel — human-readable name for the phase.
 */
export function perfMeasure(markLabel: string, phaseLabel: string): number {
    const startTime = currentMarks.get(markLabel);
    if (startTime === undefined) {
        return 0;
    }
    currentMarks.delete(markLabel);
    const durationMs = performance.now() - startTime;
    currentPhases.push({ label: phaseLabel, durationMs, startTime });
    return durationMs;
}

/**
 * End timing a phase and auto-flag if it exceeds its threshold.
 * Returns the duration in ms.
 */
export function perfMeasureWithSpike(markLabel: string, phaseLabel: string): number {
    const durationMs = perfMeasure(markLabel, phaseLabel);
    const threshold = config.thresholds[phaseLabel] ?? config.defaultThresholdMs;
    if (durationMs > threshold && config.logSpikes) {
        console.warn(
            `[pathfindingPerf] SPIKE: ${phaseLabel} took ${durationMs.toFixed(1)}ms (threshold: ${threshold}ms)`,
        );
    }
    return durationMs;
}

/**
 * End the current frame, compute spikes, and push to history.
 * Call once per hover/placement frame at the end.
 */
export function perfEndFrame(): PerfFrame | null {
    if (currentPhases.length === 0) {
        currentMarks.clear();
        return null;
    }

    frameId++;
    const endTime = performance.now();

    // Compute true total: span from earliest phase start to latest phase end.
    let earliestStart = endTime;
    let latestEnd = 0;
    for (const phase of currentPhases) {
        if (phase.startTime < earliestStart) earliestStart = phase.startTime;
        const phaseEnd = phase.startTime + phase.durationMs;
        if (phaseEnd > latestEnd) latestEnd = phaseEnd;
    }
    const totalMs = Math.max(0, latestEnd - earliestStart);

    const spikes: PerfSpike[] = [];
    for (const phase of currentPhases) {
        const threshold = config.thresholds[phase.label] ?? config.defaultThresholdMs;
        if (phase.durationMs > threshold) {
            spikes.push({
                phase: phase.label,
                durationMs: phase.durationMs,
                thresholdMs: threshold,
                startTime: phase.startTime,
            });
        }
    }

    const frame: PerfFrame = {
        frameId,
        phases: [...currentPhases],
        totalMs,
        spikes,
        endTime,
    };

    history.push(frame);
    if (history.length > config.maxHistoryFrames) {
        history.shift();
    }

    totalFrames++;
    if (spikes.length > 0) {
        spikeFrameCount++;
        if (config.logSpikes) {
            const spikeNames = spikes.map((s) => `${s.phase}(${s.durationMs.toFixed(1)}ms)`).join(', ');
            console.warn(
                `[pathfindingPerf] Frame #${frameId} — ${totalMs.toFixed(1)}ms total — SPIKES: ${spikeNames}`,
            );
        }
    }

    // Reset for next frame
    currentPhases = [];
    currentMarks.clear();

    return frame;
}

/** Discard the current in-progress frame without recording it. */
export function perfCancelFrame(): void {
    currentPhases = [];
    currentMarks.clear();
}

/** Get the full performance report. */
export function getPerfReport(): PerfReport {
    const current = history.length > 0 ? history[history.length - 1] : null;
    const hasSpikes = current !== null && current.spikes.length > 0;
    let worstSpike: PerfSpike | null = null;
    if (current) {
        for (const spike of current.spikes) {
            if (!worstSpike || spike.durationMs > worstSpike.durationMs) {
                worstSpike = spike;
            }
        }
    }

    return {
        current,
        history: [...history],
        hasSpikes,
        worstSpike,
        totalFrames,
        spikeFrameCount,
    };
}

/**
 * Get a plain-text summary of recent performance.
 * @param recentFrames — number of most recent frames to summarize (default 10).
 */
export function getPerfSummary(recentFrames = 10): string {
    const report = getPerfReport();
    const recent = report.history.slice(-recentFrames);

    if (recent.length === 0) return '[pathfindingPerf] No frames recorded.';

    const avgTotal = recent.reduce((s, f) => s + f.totalMs, 0) / recent.length;
    const maxTotal = Math.max(...recent.map((f) => f.totalMs));
    const spikeFrames = recent.filter((f) => f.spikes.length > 0);

    // Aggregate phase stats
    const phaseStats = new Map<string, { count: number; totalMs: number; maxMs: number }>();
    for (const frame of recent) {
        for (const phase of frame.phases) {
            const stat = phaseStats.get(phase.label);
            if (stat) {
                stat.count++;
                stat.totalMs += phase.durationMs;
                if (phase.durationMs > stat.maxMs) stat.maxMs = phase.durationMs;
            } else {
                phaseStats.set(phase.label, { count: 1, totalMs: phase.durationMs, maxMs: phase.durationMs });
            }
        }
    }

    const lines: string[] = [
        `[pathfindingPerf] Last ${recent.length} frames:`,
        `  avg total: ${avgTotal.toFixed(1)}ms | max total: ${maxTotal.toFixed(1)}ms`,
        `  spike frames: ${spikeFrames.length}/${recent.length} (${report.spikeFrameCount}/${report.totalFrames} overall)`,
        `  phases:`,
    ];

    const sortedPhases = [...phaseStats.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs);
    for (const [label, stat] of sortedPhases) {
        const avgMs = stat.totalMs / stat.count;
        const threshold = config.thresholds[label] ?? config.defaultThresholdMs;
        const flag = stat.maxMs > threshold ? ' ⚠' : '';
        lines.push(`    ${label}: avg ${avgMs.toFixed(1)}ms / max ${stat.maxMs.toFixed(1)}ms / n=${stat.count}${flag}`);
    }

    return lines.join('\n');
}

/** Update the perf configuration at runtime. */
export function configurePerf(partial: Partial<PerfConfig>): void {
    config = { ...config, ...partial, thresholds: { ...config.thresholds, ...partial.thresholds } };
}

/** Reset all accumulated history and counters. */
export function resetPerf(): void {
    frameId = 0;
    currentPhases = [];
    currentMarks.clear();
    history = [];
    totalFrames = 0;
    spikeFrameCount = 0;
}

// Re-export for convenience from pathfindingDebugState
export { configurePerf as setPathfindingPerfConfig };

// ---------- Global console API (no DevTools needed) ----------

/**
 * Attach `__dfPerf` to `window` so users can inspect performance
 * from the browser console without opening DevTools:
 *
 *   __dfPerf.summary()       // print last 10 frames
 *   __dfPerf.summary(30)     // print last 30 frames
 *   __dfPerf.report()        // full PerfReport object
 *   __dfPerf.spikes(false)   // mute spike warnings
 *   __dfPerf.spikes(true)    // re-enable spike warnings
 *   __dfPerf.threshold('trunk:astar', 50)  // raise threshold
 *   __dfPerf.reset()         // clear history
 */
export function installPerfConsoleAPI(): void {
    if (typeof window === 'undefined') return;
    (window as any).__dfPerf = {
        summary: (recentFrames?: number) => {
            console.log(getPerfSummary(recentFrames));
        },
        report: () => {
            const r = getPerfReport();
            console.log(r);
            return r;
        },
        dump: () => {
            const r = getPerfReport();
            if (!r.current) { console.log('[dfPerf] No frames recorded.'); return; }
            const f = r.current;
            console.log(`[dfPerf] Frame #${f.frameId} — ${f.totalMs.toFixed(1)}ms total${f.spikes.length ? ' ⚠' : ''}`);
            for (const p of f.phases) {
                const t = config.thresholds[p.label] ?? config.defaultThresholdMs;
                const flag = p.durationMs > t ? ' ⚠ SPIKE' : '';
                const pct = f.totalMs > 0 ? ((p.durationMs / f.totalMs) * 100).toFixed(0) : '0';
                console.log(`  ${p.label}: ${p.durationMs.toFixed(1)}ms (${pct}%)${flag}`);
            }
        },
        spikes: (on: boolean) => {
            configurePerf({ logSpikes: on });
            console.log(`[dfPerf] Spike logging: ${on ? 'ON' : 'OFF'}`);
        },
        threshold: (phase: string, ms: number) => {
            configurePerf({ thresholds: { [phase]: ms } });
            console.log(`[dfPerf] Threshold for "${phase}" set to ${ms}ms`);
        },
        reset: () => {
            resetPerf();
            console.log('[dfPerf] History cleared.');
        },
    };
}

// Auto-install the console API on first import — no DevTools needed.
// The `installPerfConsoleAPI` guard handles SSR (window === undefined).
installPerfConsoleAPI();
