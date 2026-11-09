'use client';

import React from 'react';
import { useEscapeToClose } from '@/hotkeys/useEscapeToClose';
import { X } from 'lucide-react';
import { IconButton } from '@/components/atoms';
import { SelectDropdown } from '@/components/ui/SelectDropdown';
import { getSnapshot as getSupportSnapshot } from '@/supports/state';
import { countSupportCollections, implicitSegmentCount, SUPPORT_COLLECTION_KEYS, SUPPORT_TYPES } from '@/supports/supportTypeRegistry';
import type { SupportCollectionKey } from '@/supports/supportTypeRegistry';
import type { Segment } from '@/supports/types';
import { getPickingDiagnosticsSnapshot } from '@/components/picking/pickingDiagnostics';
import {
  DIAGNOSTICS_BENCHMARK_PROGRESS_EVENT,
  DIAGNOSTICS_BENCHMARK_REQUEST_EVENT,
  type DiagnosticsBenchmarkProgressDetail,
  type DiagnosticsBenchmarkResult,
  type DiagnosticsBenchmarkStressProfile,
} from '@/components/modals/diagnosticsBenchmarkEvents';
import { useLocaleFormat } from '@/hooks/useLocaleFormat';
import type { UnitFormat } from '@/utils/unitFormatting';

type DiagnosticsModalProps = {
  isOpen: boolean;
  onClose: () => void;
  appMode: string;
  cameraProjectionMode: 'orthographic' | 'perspective';
  modelCount: number;
  visibleModelCount: number;
  selectedModelCount: number;
  totalPolygons: number;
  selectedPolygons: number;
};

type RuntimeStats = {
  fps: number;
  frameTimeMs: number;
  cpuUsageEstimate: number;
  fpsHistory: number[];
  frameTimeHistory: number[];
  usedJsHeapBytes: number | null;
  totalJsHeapBytes: number | null;
  heapLimitBytes: number | null;
  webglMode: string;
  supportStats: SupportDiagnosticsStats;
};

/**
 * Per-collection counts come from the registry, so a type added later is
 * reported without being listed here. Anchors were missing from the
 * hand-written list and always read zero.
 */
type SupportDiagnosticsStats = Record<SupportCollectionKey, number> & {
  segmentCount: number;
  jointCount: number;
  estimatedRenderablePrimitives: number;
  pickingRegisteredTotal: number;
  pickingRegisteredSupportRelated: number;
  pickingVisibleObjects: number;
  pickingCachedObjects: number;
  pickingAvgMs: number;
  pickingLastMs: number;
  pickingSyncAvgMs: number;
  pickingPicksPerSecond: number;
};

const EMPTY_SUPPORT_STATS: SupportDiagnosticsStats = {
  ...(Object.fromEntries(SUPPORT_COLLECTION_KEYS.map((key) => [key, 0])) as Record<SupportCollectionKey, number>),
  segmentCount: 0,
  jointCount: 0,
  estimatedRenderablePrimitives: 0,
  pickingRegisteredTotal: 0,
  pickingRegisteredSupportRelated: 0,
  pickingVisibleObjects: 0,
  pickingCachedObjects: 0,
  pickingAvgMs: 0,
  pickingLastMs: 0,
  pickingSyncAvgMs: 0,
  pickingPicksPerSecond: 0,
};

const GRAPH_WINDOW_SECONDS = 120;
const SAMPLE_INTERVAL_MS = 250;
const MAX_GRAPH_POINTS = Math.floor((GRAPH_WINDOW_SECONDS * 1000) / SAMPLE_INTERVAL_MS);

function formatBytes(bytes: number | null, fmt: UnitFormat): string {
  if (bytes == null || !Number.isFinite(bytes)) return 'N/A';
  const abs = Math.max(0, bytes);
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;

  if (abs >= GB) return fmt.quantity(abs / GB, 2, 'GB');
  if (abs >= MB) return fmt.quantity(abs / MB, 2, 'MB');
  if (abs >= KB) return fmt.quantity(abs / KB, 1, 'KB');
  return fmt.quantity(abs, 0, 'B');
}

function formatPercent(value: number | null, fmt: UnitFormat): string {
  if (value == null || !Number.isFinite(value)) return 'N/A';
  return fmt.quantity(value * 100, 1, 'percent');
}

function formatMs(value: number | null | undefined, fmt: UnitFormat, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return 'N/A';
  return fmt.quantity(value, digits, 'ms');
}

function formatFps(value: number | null | undefined, fmt: UnitFormat, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return 'N/A';
  return fmt.quantity(value, digits, 'fps');
}

function computeSupportDiagnostics(): SupportDiagnosticsStats {
  const supportState = getSupportSnapshot();
  const picking = getPickingDiagnosticsSnapshot();

  // Every type's segments and joints. A brace has no segments but draws one
  // shaft, so it counts as one each.
  const uniqueJointIds = new Set<string>();
  let segmentCount = 0;

  for (const descriptor of SUPPORT_TYPES) {
    const collection = supportState[descriptor.location.key] as unknown as Record<string, { segments?: Segment[] }>;

    for (const entity of Object.values(collection ?? {})) {
      if (!descriptor.hasSegments) {
        segmentCount += implicitSegmentCount(descriptor);
        continue;
      }
      for (const segment of entity.segments ?? []) {
        segmentCount += 1;
        if (segment.topJoint?.id) uniqueJointIds.add(segment.topJoint.id);
        if (segment.bottomJoint?.id) uniqueJointIds.add(segment.bottomJoint.id);
      }
    }
  }

  const estimatedRenderablePrimitives =
    segmentCount
    + uniqueJointIds.size
    + Object.keys(supportState.knots).length
    + Object.keys(supportState.roots).length
    + Object.keys(supportState.leaves).length
    + Object.keys(supportState.braces).length;

  const supportRelatedPickers =
    picking.registrationsByCategory.support
    + picking.registrationsByCategory.segment
    + picking.registrationsByCategory.joint
    + picking.registrationsByCategory.knot
    + picking.registrationsByCategory.raft;

  return {
    ...(countSupportCollections(supportState) as Record<SupportCollectionKey, number>),
    segmentCount,
    jointCount: uniqueJointIds.size,
    estimatedRenderablePrimitives,
    pickingRegisteredTotal: picking.totalRegistrations,
    pickingRegisteredSupportRelated: supportRelatedPickers,
    pickingVisibleObjects: picking.visiblePickObjects,
    pickingCachedObjects: picking.cachedPickObjects,
    pickingAvgMs: picking.avgPickDurationMs,
    pickingLastMs: picking.lastPickDurationMs,
    pickingSyncAvgMs: picking.avgSyncDurationMs,
    pickingPicksPerSecond: picking.picksPerSecond,
  };
}

function Sparkline({
  values,
  min,
  max,
  stroke,
}: {
  values: number[];
  min: number;
  max: number;
  stroke: string;
}) {
  const width = 380;
  const height = 88;
  const yRange = Math.max(1e-6, max - min);

  const points = values
    .map((value, index) => {
      const x = (index / Math.max(1, values.length - 1)) * width;
      const y = height - ((value - min) / yRange) * height;
      return `${x.toFixed(2)},${Math.max(0, Math.min(height, y)).toFixed(2)}`;
    })
    .join(' ');

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-24" preserveAspectRatio="none" aria-hidden>
      <rect x={0} y={0} width={width} height={height} fill="transparent" />
      {points.length > 0 && (
        <polyline
          fill="none"
          stroke={stroke}
          strokeWidth={2}
          points={points}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

export function DiagnosticsModal({
  isOpen,
  onClose,
  appMode,
  cameraProjectionMode,
  modelCount,
  visibleModelCount,
  selectedModelCount,
  totalPolygons,
  selectedPolygons,
}: DiagnosticsModalProps) {
  const fmt = useLocaleFormat();
  useEscapeToClose(isOpen, onClose);

  const [stats, setStats] = React.useState<RuntimeStats>({
    fps: 0,
    frameTimeMs: 0,
    cpuUsageEstimate: 0,
    fpsHistory: [],
    frameTimeHistory: [],
    usedJsHeapBytes: null,
    totalJsHeapBytes: null,
    heapLimitBytes: null,
    webglMode: 'Unknown',
    supportStats: EMPTY_SUPPORT_STATS,
  });
  const [benchmarkResult, setBenchmarkResult] = React.useState<DiagnosticsBenchmarkResult | null>(null);
  const [benchmarkStressProfile, setBenchmarkStressProfile] = React.useState<DiagnosticsBenchmarkStressProfile>('standard');
  const [benchmarkRunState, setBenchmarkRunState] = React.useState<{
    isRunning: boolean;
    requestId: string | null;
    phaseLabel: string;
    message: string;
    error: string | null;
  }>({
    isRunning: false,
    requestId: null,
    phaseLabel: '',
    message: '',
    error: null,
  });

  React.useEffect(() => {
    if (!isOpen) return;

    let rafId = 0;
    let frameCounter = 0;
    let fpsWindowStart = performance.now();
    let lastFrameTime = performance.now();

    const fpsHistory: number[] = [];
    const frameTimeHistory: number[] = [];

    const tick = (now: number) => {
      const frameDelta = Math.max(0, now - lastFrameTime);
      lastFrameTime = now;
      frameCounter += 1;
      frameTimeHistory.push(frameDelta);
      if (frameTimeHistory.length > MAX_GRAPH_POINTS) frameTimeHistory.shift();

      if (now - fpsWindowStart >= SAMPLE_INTERVAL_MS) {
        const elapsed = Math.max(1, now - fpsWindowStart);
        const fps = (frameCounter * 1000) / elapsed;
        const avgFrameTimeMs = frameCounter > 0 ? (elapsed / frameCounter) : 0;
        const cpuUsageEstimate = Math.min(100, Math.max(0, (avgFrameTimeMs / 16.67) * 100));
        frameCounter = 0;
        fpsWindowStart = now;

        fpsHistory.push(fps);
        if (fpsHistory.length > MAX_GRAPH_POINTS) fpsHistory.shift();

        const canvas = document.querySelector('canvas');
        let webglMode = 'Unknown';
        if (canvas) {
          if ((canvas as HTMLCanvasElement).getContext('webgl2')) webglMode = 'WebGL2';
          else if ((canvas as HTMLCanvasElement).getContext('webgl')) webglMode = 'WebGL1';
        }

        const perfMemory = (performance as Performance & {
          memory?: {
            usedJSHeapSize?: number;
            totalJSHeapSize?: number;
            jsHeapSizeLimit?: number;
          };
        }).memory;

        setStats({
          fps,
          frameTimeMs: avgFrameTimeMs,
          cpuUsageEstimate,
          fpsHistory: [...fpsHistory],
          frameTimeHistory: [...frameTimeHistory],
          usedJsHeapBytes: perfMemory?.usedJSHeapSize ?? null,
          totalJsHeapBytes: perfMemory?.totalJSHeapSize ?? null,
          heapLimitBytes: perfMemory?.jsHeapSizeLimit ?? null,
          webglMode,
          supportStats: computeSupportDiagnostics(),
        });
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [isOpen, onClose]);

  React.useEffect(() => {
    if (!isOpen) return;

    const handleBenchmarkProgress = (event: Event) => {
      const customEvent = event as CustomEvent<DiagnosticsBenchmarkProgressDetail>;
      const detail = customEvent.detail;
      if (!detail?.requestId) return;

      if (detail.status === 'started') {
        setBenchmarkRunState({
          isRunning: true,
          requestId: detail.requestId,
          phaseLabel: 'Starting',
          message: detail.message ?? 'Starting benchmark…',
          error: null,
        });
        return;
      }

      setBenchmarkRunState((prev) => {
        if (prev.requestId && prev.requestId !== detail.requestId) return prev;

        if (detail.status === 'phase-complete') {
          return {
            ...prev,
            isRunning: true,
            requestId: detail.requestId,
            phaseLabel: detail.phase ? `${detail.phase.toUpperCase()} complete` : prev.phaseLabel,
            message: detail.message ?? prev.message,
            error: null,
          };
        }

        if (detail.status === 'completed') {
          if (detail.result) {
            setBenchmarkResult(detail.result);
          }
          return {
            isRunning: false,
            requestId: detail.requestId,
            phaseLabel: 'Done',
            message: detail.message ?? 'Benchmark complete.',
            error: null,
          };
        }

        if (detail.status === 'error') {
          return {
            isRunning: false,
            requestId: detail.requestId,
            phaseLabel: 'Failed',
            message: detail.message ?? 'Benchmark failed.',
            error: detail.message ?? 'Benchmark failed.',
          };
        }

        return prev;
      });
    };

    window.addEventListener(DIAGNOSTICS_BENCHMARK_PROGRESS_EVENT, handleBenchmarkProgress as EventListener);
    return () => {
      window.removeEventListener(DIAGNOSTICS_BENCHMARK_PROGRESS_EVENT, handleBenchmarkProgress as EventListener);
    };
  }, [isOpen]);

  const handleRunBenchmark = React.useCallback(() => {
    if (!isOpen) return;
    if (benchmarkRunState.isRunning) return;

    const requestId = `benchmark-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setBenchmarkRunState({
      isRunning: true,
      requestId,
      phaseLabel: 'Queued',
      message: 'Requesting benchmark run…',
      error: null,
    });

    window.dispatchEvent(new CustomEvent(DIAGNOSTICS_BENCHMARK_REQUEST_EVENT, {
      detail: { requestId, stressProfile: benchmarkStressProfile },
    }));
  }, [benchmarkRunState.isRunning, benchmarkStressProfile, isOpen]);

  if (!isOpen) return null;

  const deviceMemory = typeof navigator !== 'undefined' ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory : undefined;
  const hardwareConcurrency = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined;
  const heapUsageRatio = stats.usedJsHeapBytes != null && stats.totalJsHeapBytes
    ? stats.usedJsHeapBytes / Math.max(1, stats.totalJsHeapBytes)
    : null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-5xl max-h-[88vh] overflow-hidden rounded-xl border shadow-2xl"
        style={{
          background: 'var(--surface-0)',
          borderColor: 'var(--border-subtle)',
          boxShadow: '0 28px 64px rgba(0,0,0,0.48)',
        }}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <div>
            <h2 className="text-base font-semibold" style={{ color: 'var(--text-strong)' }}>Diagnostics</h2>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Runtime telemetry for DragonFruit (toggle with Ctrl+Shift+D)
            </p>
          </div>
          <IconButton
            variant="surface"
            size="sm"
            onClick={onClose}
            aria-label="Close diagnostics"
          >
            <X className="w-4 h-4" />
          </IconButton>
        </div>

        <div className="max-h-[calc(88vh-58px)] overflow-y-auto custom-scrollbar p-4 space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>FPS</div>
              <div className="text-xl font-semibold" style={{ color: 'var(--text-strong)' }}>{fmt.fixed(stats.fps, 1)}</div>
            </div>
            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Frame Time</div>
              <div className="text-xl font-semibold" style={{ color: 'var(--text-strong)' }}>{fmt.quantity(stats.frameTimeMs, 2, 'ms')}</div>
            </div>
            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Used JS Heap</div>
              <div className="text-xl font-semibold" style={{ color: 'var(--text-strong)' }}>{formatBytes(stats.usedJsHeapBytes, fmt)}</div>
            </div>
            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Heap Usage</div>
              <div className="text-xl font-semibold" style={{ color: 'var(--text-strong)' }}>{formatPercent(heapUsageRatio, fmt)}</div>
            </div>
            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>CPU Usage (est.)</div>
              <div className="text-xl font-semibold" style={{ color: 'var(--text-strong)' }}>{fmt.quantity(stats.cpuUsageEstimate, 0, 'percent')}</div>
            </div>
            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Support Segments</div>
              <div className="text-xl font-semibold" style={{ color: 'var(--text-strong)' }}>{fmt.number(stats.supportStats.segmentCount)}</div>
            </div>
            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Support Pickers</div>
              <div className="text-xl font-semibold" style={{ color: 'var(--text-strong)' }}>{fmt.number(stats.supportStats.pickingRegisteredSupportRelated)}</div>
            </div>
            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Picking Avg</div>
              <div className="text-xl font-semibold" style={{ color: 'var(--text-strong)' }}>{fmt.quantity(stats.supportStats.pickingAvgMs, 3, 'ms')}</div>
            </div>
          </div>

          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-[12px] font-semibold" style={{ color: 'var(--text-strong)' }}>Automated Orbit Benchmark</div>
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  Runs slow, medium, and fast full 3D sweep passes around the current model and records frame timing.
                </div>
              </div>
              <div className="flex items-center gap-2">
                <SelectDropdown
                  value={benchmarkStressProfile}
                  onChange={(nextValue) => setBenchmarkStressProfile(nextValue as DiagnosticsBenchmarkStressProfile)}
                  disabled={benchmarkRunState.isRunning}
                  ariaLabel="Benchmark stress profile"
                  options={[
                    { value: 'quick', label: 'Quick' },
                    { value: 'standard', label: 'Standard' },
                    { value: 'torture', label: 'Torture' },
                  ]}
                  className="space-y-0"
                  selectClassName="!h-9 min-w-[118px] text-[12px]"
                  selectStyle={{
                    borderColor: 'var(--border-subtle)',
                    background: 'var(--surface-0)',
                    color: 'var(--text-strong)',
                  }}
                />
                <button
                  type="button"
                  onClick={handleRunBenchmark}
                  disabled={benchmarkRunState.isRunning}
                  className="h-9 rounded-md border px-3 text-[12px] font-semibold transition-colors disabled:opacity-45"
                  style={benchmarkRunState.isRunning
                    ? {
                        borderColor: 'var(--border-subtle)',
                        background: 'var(--surface-2)',
                        color: 'var(--text-muted)',
                      }
                    : {
                        borderColor: 'color-mix(in srgb, var(--accent), white 10%)',
                        background: 'color-mix(in srgb, var(--accent), var(--surface-0) 76%)',
                        color: 'var(--accent-contrast)',
                      }}
                >
                  {benchmarkRunState.isRunning ? 'Running…' : 'Run Benchmark'}
                </button>
              </div>
            </div>

            <div className="mt-2 text-[11px]" style={{ color: benchmarkRunState.error ? 'var(--danger)' : 'var(--text-muted)' }}>
              {benchmarkRunState.error
                ? benchmarkRunState.error
                : benchmarkRunState.message || 'No benchmark run yet.'}
              {benchmarkRunState.phaseLabel ? ` • ${benchmarkRunState.phaseLabel}` : ''}
            </div>

            {benchmarkResult && (
              <div className="mt-3 space-y-2">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                  <div className="rounded-md border px-2.5 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
                    <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Overall Avg</div>
                    <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                      {formatFps(benchmarkResult.overall.fpsAvg, fmt)}
                    </div>
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{formatMs(benchmarkResult.overall.frameTimeAvgMs, fmt)}</div>
                  </div>
                  <div className="rounded-md border px-2.5 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
                    <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Overall P95</div>
                    <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                      {formatMs(benchmarkResult.overall.frameTimeP95Ms, fmt)}
                    </div>
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Projection: {benchmarkResult.projectionMode}</div>
                  </div>
                  <div className="rounded-md border px-2.5 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
                    <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Run Duration</div>
                    <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                      {fmt.quantity(benchmarkResult.totalDurationMs / 1000, 2, 's')}
                    </div>
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      Camera feel: {benchmarkResult.cameraFeelPreset} • Stress: {benchmarkResult.stressProfile}
                    </div>
                  </div>
                </div>

                <div className="rounded-md border overflow-hidden" style={{ borderColor: 'var(--border-subtle)' }}>
                  <table className="w-full text-[11px]">
                    <thead style={{ background: 'var(--surface-0)', color: 'var(--text-muted)' }}>
                      <tr>
                        <th className="text-left px-2 py-1.5 font-semibold">Phase</th>
                        <th className="text-right px-2 py-1.5 font-semibold">Avg FPS</th>
                        <th className="text-right px-2 py-1.5 font-semibold">Min FPS</th>
                        <th className="text-right px-2 py-1.5 font-semibold">Avg FT</th>
                        <th className="text-right px-2 py-1.5 font-semibold">P95 FT</th>
                        <th className="text-right px-2 py-1.5 font-semibold">Max FT</th>
                      </tr>
                    </thead>
                    <tbody>
                      {benchmarkResult.phases.map((phase) => (
                        <tr key={phase.phase} style={{ borderTop: '1px solid var(--border-subtle)', background: 'var(--surface-1)' }}>
                          <td className="px-2 py-1.5" style={{ color: 'var(--text-strong)' }}>{phase.phase}</td>
                          <td className="px-2 py-1.5 text-right" style={{ color: 'var(--text-strong)' }}>{fmt.fixed(phase.stats.fpsAvg, 1)}</td>
                          <td className="px-2 py-1.5 text-right" style={{ color: 'var(--text-muted)' }}>{fmt.fixed(phase.stats.fpsMin, 1)}</td>
                          <td className="px-2 py-1.5 text-right" style={{ color: 'var(--text-strong)' }}>{fmt.quantity(phase.stats.frameTimeAvgMs, 2, 'ms')}</td>
                          <td className="px-2 py-1.5 text-right" style={{ color: 'var(--text-muted)' }}>{fmt.quantity(phase.stats.frameTimeP95Ms, 2, 'ms')}</td>
                          <td className="px-2 py-1.5 text-right" style={{ color: 'var(--text-muted)' }}>{fmt.quantity(phase.stats.frameTimeMaxMs, 2, 'ms')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
              <div className="text-[12px] font-semibold mb-2" style={{ color: 'var(--text-strong)' }}>FPS History</div>
              <Sparkline values={stats.fpsHistory} min={0} max={Math.max(60, ...stats.fpsHistory, 1)} stroke="var(--accent)" />
              <div className="mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                Last {GRAPH_WINDOW_SECONDS}s ({SAMPLE_INTERVAL_MS}ms samples)
              </div>
            </div>
            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
              <div className="text-[12px] font-semibold mb-2" style={{ color: 'var(--text-strong)' }}>Frame Time History (ms)</div>
              <Sparkline values={stats.frameTimeHistory} min={0} max={Math.max(24, ...stats.frameTimeHistory, 1)} stroke="var(--accent-secondary)" />
              <div className="mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                Last {GRAPH_WINDOW_SECONDS}s frame time
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
              <div className="text-[12px] font-semibold mb-2" style={{ color: 'var(--text-strong)' }}>Scene Stats</div>
              <div className="space-y-1 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                <div>Mode: <span style={{ color: 'var(--text-strong)' }}>{appMode}</span></div>
                <div>Rendering Mode: <span style={{ color: 'var(--text-strong)' }}>{cameraProjectionMode}</span></div>
                <div>Graphics API: <span style={{ color: 'var(--text-strong)' }}>{stats.webglMode}</span></div>
                <div>Models: <span style={{ color: 'var(--text-strong)' }}>{modelCount}</span></div>
                <div>Visible Models: <span style={{ color: 'var(--text-strong)' }}>{visibleModelCount}</span></div>
                <div>Selected Models: <span style={{ color: 'var(--text-strong)' }}>{selectedModelCount}</span></div>
                <div>Total Triangles: <span style={{ color: 'var(--text-strong)' }}>{fmt.number(totalPolygons)}</span></div>
                <div>Selected Triangles: <span style={{ color: 'var(--text-strong)' }}>{fmt.number(selectedPolygons)}</span></div>
              </div>
            </div>

            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
              <div className="text-[12px] font-semibold mb-2" style={{ color: 'var(--text-strong)' }}>System</div>
              <div className="space-y-1 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                <div>Logical CPU Cores: <span style={{ color: 'var(--text-strong)' }}>{hardwareConcurrency ?? 'N/A'}</span></div>
                <div>Device Memory: <span style={{ color: 'var(--text-strong)' }}>{deviceMemory ? `${deviceMemory} GB` : 'N/A'}</span></div>
                <div>Total JS Heap: <span style={{ color: 'var(--text-strong)' }}>{formatBytes(stats.totalJsHeapBytes, fmt)}</span></div>
                <div>JS Heap Limit: <span style={{ color: 'var(--text-strong)' }}>{formatBytes(stats.heapLimitBytes, fmt)}</span></div>
                <div>User Agent: <span style={{ color: 'var(--text-strong)' }}>{navigator.userAgent}</span></div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
              <div className="text-[12px] font-semibold mb-2" style={{ color: 'var(--text-strong)' }}>Support Stats</div>
              <div className="space-y-1 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                {SUPPORT_COLLECTION_KEYS.map((key) => (
                  <div key={key}>{key.charAt(0).toUpperCase()}{key.slice(1)}: <span style={{ color: 'var(--text-strong)' }}>{fmt.number(stats.supportStats[key])}</span></div>
                ))}
                <div>Segments: <span style={{ color: 'var(--text-strong)' }}>{fmt.number(stats.supportStats.segmentCount)}</span></div>
                <div>Joints: <span style={{ color: 'var(--text-strong)' }}>{fmt.number(stats.supportStats.jointCount)}</span></div>
                <div>Estimated Render Primitives: <span style={{ color: 'var(--text-strong)' }}>{fmt.number(stats.supportStats.estimatedRenderablePrimitives)}</span></div>
              </div>
            </div>

            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
              <div className="text-[12px] font-semibold mb-2" style={{ color: 'var(--text-strong)' }}>GPU Picking Stats</div>
              <div className="space-y-1 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                <div>Total Registered: <span style={{ color: 'var(--text-strong)' }}>{fmt.number(stats.supportStats.pickingRegisteredTotal)}</span></div>
                <div>Support Registered: <span style={{ color: 'var(--text-strong)' }}>{fmt.number(stats.supportStats.pickingRegisteredSupportRelated)}</span></div>
                <div>Visible Pick Objects: <span style={{ color: 'var(--text-strong)' }}>{fmt.number(stats.supportStats.pickingVisibleObjects)}</span></div>
                <div>Cached Pick Objects: <span style={{ color: 'var(--text-strong)' }}>{fmt.number(stats.supportStats.pickingCachedObjects)}</span></div>
                <div>Pick Avg: <span style={{ color: 'var(--text-strong)' }}>{fmt.quantity(stats.supportStats.pickingAvgMs, 3, 'ms')}</span></div>
                <div>Pick Last: <span style={{ color: 'var(--text-strong)' }}>{fmt.quantity(stats.supportStats.pickingLastMs, 3, 'ms')}</span></div>
                <div>Sync Cache Avg: <span style={{ color: 'var(--text-strong)' }}>{fmt.quantity(stats.supportStats.pickingSyncAvgMs, 3, 'ms')}</span></div>
                <div>Pick Rate: <span style={{ color: 'var(--text-strong)' }}>{fmt.quantity(stats.supportStats.pickingPicksPerSecond, 1, 'perSecond')}</span></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
