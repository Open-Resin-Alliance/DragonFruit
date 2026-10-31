/**
 * Temporary probe: opt-in timing marks, read with
 * `performance.getEntriesByType('measure')`. Costs a branch per call when off.
 *
 * The flag is `__dfPerfMarks`, deliberately not `__dfPerf`: the support
 * pathfinding module installs `window.__dfPerf` as its own console API, so
 * testing that name made every mark run in production.
 */
export function perfEnabled(): boolean {
  return typeof window !== 'undefined'
    && (window as unknown as { __dfPerfMarks?: boolean }).__dfPerfMarks === true;
}

/**
 * The start of a measured span, or 0 when the probe is off.
 *
 * The label belongs to `perfMeasure`; a mark only needs the timestamp, so this
 * takes none and the call sites read `perfMark()` / `perfMeasure('x', start)`.
 */
export function perfMark(): number {
  return perfEnabled() ? performance.now() : 0;
}

export function perfMeasure(label: string, start: number): void {
  if (!perfEnabled() || start === 0) return;
  performance.measure(`[df] ${label}`, { start, end: performance.now() });
}

/**
 * Temporary bisect switch: `window.__dfLayers = { merged: false }` drops one
 * layer from the scene so a commit's cost can be attributed to it.
 */
export function perfLayerEnabled(name: 'merged' | 'proxy' | 'mergedMesh' | 'shapes' | 'rafts' | 'overlay'): boolean {
  if (typeof window === 'undefined') return true;
  const layers = (window as unknown as { __dfLayers?: Partial<Record<'merged' | 'proxy' | 'mergedMesh' | 'shapes' | 'rafts' | 'overlay', boolean>> }).__dfLayers;
  return layers?.[name] !== false;
}

/**
 * Temporary handle on the in-app render profiler, so a CDP session can turn it
 * on, force GPU sync probes and read the per-pass samples without a debug UI.
 *
 * The profiler module is imported on first use, so a session that never asks
 * pays nothing.
 */
export function installPerfProfilerHandle(): void {
  if (typeof window === 'undefined') return;
  const target = window as unknown as { __dfProfiler?: unknown };
  if (target.__dfProfiler) return;
  const profiler = () => import('@/utils/debug/renderProfiler');
  target.__dfProfiler = {
    enable: async () => { (await profiler()).setRenderProfilerEnabled(true); },
    disable: async () => { (await profiler()).setRenderProfilerEnabled(false); },
    probe: async (frames = 30) => { (await profiler()).startGpuSyncProbe(frames); },
    snapshot: async () => (await profiler()).getRenderProfilerSnapshot(),
    log: async () => (await profiler()).logRenderProfileSummary(),
  };
}
