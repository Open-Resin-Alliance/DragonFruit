'use client';

import React from 'react';
import { useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import { Button, Card, CardHeader, IconButton } from '@/components/atoms';
import {
  copyRenderProfileReport,
  getRenderProfilerSnapshot,
  logRenderProfileSummary,
  setRenderProfilerEnabled,
  setRenderProfilerPaused,
  startGpuSyncProbe,
  startRenderProfileRecording,
  stopRenderProfileRecording,
  subscribeRenderProfiler,
  toggleRenderProfilerEnabled,
  type RenderFrameSample,
  type RenderProfilerSnapshot,
  type ValueStats,
} from '@/utils/debug/renderProfiler';

const WINDOW_WIDTH = 432;
const WINDOW_MARGIN = 8;
const SPARKLINE_WIDTH = 380;
const SPARKLINE_HEIGHT = 44;
const SPARKLINE_FRAMES = 120;
const POSITION_STORAGE_KEY = 'df.debug.renderProfiler.position';

type WindowPosition = { x: number; y: number };

function sparklinePoints(values: number[], maxValue: number): string {
  if (values.length < 2) return '';
  const step = SPARKLINE_WIDTH / (values.length - 1);
  return values
    .map((value, index) => {
      const x = (index * step).toFixed(1);
      const y = (SPARKLINE_HEIGHT - Math.min(1, maxValue > 0 ? value / maxValue : 0) * SPARKLINE_HEIGHT).toFixed(1);
      return `${x},${y}`;
    })
    .join(' ');
}

function ms(value: number | undefined): string {
  return value == null || !Number.isFinite(value) ? 'n/a' : `${value.toFixed(2)} ms`;
}

function count(value: number | undefined): string {
  return value == null || !Number.isFinite(value) ? 'n/a' : Math.round(value).toString();
}

function triangles(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return Math.round(value).toString();
}

function p95(values: ValueStats | null, formatter: (value: number | undefined) => string): string {
  return values ? `p95 ${formatter(values.p95)}` : 'no samples';
}

function clampPosition(position: WindowPosition, height: number): WindowPosition {
  if (typeof window === 'undefined') return position;
  const maxX = Math.max(WINDOW_MARGIN, window.innerWidth - WINDOW_WIDTH - WINDOW_MARGIN);
  const maxY = Math.max(WINDOW_MARGIN, window.innerHeight - height - WINDOW_MARGIN);
  return {
    x: Math.min(maxX, Math.max(WINDOW_MARGIN, position.x)),
    y: Math.min(maxY, Math.max(WINDOW_MARGIN, position.y)),
  };
}

function readStoredPosition(): WindowPosition | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(POSITION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown };
    if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return null;
    if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return null;
    return { x: parsed.x, y: parsed.y };
  } catch {
    return null;
  }
}

function defaultPosition(): WindowPosition {
  if (typeof window === 'undefined') return { x: WINDOW_MARGIN, y: 64 };
  return {
    x: Math.max(WINDOW_MARGIN, window.innerWidth - WINDOW_WIDTH - 16),
    y: 64,
  };
}

function Sparkline({
  values,
  maxValue,
  stroke,
  guide,
}: {
  values: number[];
  maxValue: number;
  stroke: string;
  guide?: number;
}) {
  const points = sparklinePoints(values, maxValue);
  const guideY = guide != null && maxValue > 0
    ? SPARKLINE_HEIGHT - Math.min(1, guide / maxValue) * SPARKLINE_HEIGHT
    : null;
  return (
    <svg
      width="100%"
      height={SPARKLINE_HEIGHT}
      viewBox={`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`}
      preserveAspectRatio="none"
      className="block"
      aria-hidden
    >
      {guideY != null && (
        <line
          x1={0}
          x2={SPARKLINE_WIDTH}
          y1={guideY}
          y2={guideY}
          stroke="var(--border-strong)"
          strokeWidth={1}
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {points && (
        <polyline
          points={points}
          fill="none"
          stroke={stroke}
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

function MetricCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div
      className="min-w-0 rounded-md border px-2.5 py-2"
      style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
    >
      <div className="truncate text-[10px]" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="truncate text-[16px] font-semibold leading-tight tabular-nums" style={{ color: 'var(--text-strong)' }}>{value}</div>
      <div className="truncate text-[10px] tabular-nums" style={{ color: 'var(--text-muted)' }}>{detail}</div>
    </div>
  );
}

function SectionTitle({ children, trailing }: { children: React.ReactNode; trailing?: React.ReactNode }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between">
      <div className="text-[11px] font-semibold" style={{ color: 'var(--text-strong)' }}>{children}</div>
      {trailing ? <div className="text-[10px] tabular-nums" style={{ color: 'var(--text-muted)' }}>{trailing}</div> : null}
    </div>
  );
}

// i18n-ignore-start: developer-only render profiler table, kept in English
function PassTable({ snapshot }: { snapshot: RenderProfilerSnapshot }) {
  if (snapshot.summary.passes.length === 0) {
    return <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>No render passes recorded yet.</div>;
  }
  return (
    <div className="overflow-hidden rounded-md border" style={{ borderColor: 'var(--border-subtle)' }}>
      <table className="w-full text-[11px] tabular-nums">
        <thead style={{ background: 'var(--surface-0)', color: 'var(--text-muted)' }}>
          <tr>
            <th className="px-2.5 py-1.5 text-left font-semibold">Pass</th>
            <th className="px-2 py-1.5 text-right font-semibold">×/frame</th>
            <th className="px-2 py-1.5 text-right font-semibold">CPU p50</th>
            <th className="px-2 py-1.5 text-right font-semibold">GPU p50</th>
            <th className="px-2 py-1.5 text-right font-semibold">Calls</th>
            <th className="px-2.5 py-1.5 text-right font-semibold">Triangles</th>
          </tr>
        </thead>
        <tbody>
          {snapshot.summary.passes.map((pass) => (
            <tr key={pass.scene} style={{ borderTop: '1px solid var(--border-subtle)', background: 'var(--surface-1)' }}>
              <td className="px-2.5 py-1.5" style={{ color: 'var(--text-strong)' }}>{pass.scene}</td>
              <td className="px-2 py-1.5 text-right" style={{ color: 'var(--text-muted)' }}>{pass.perFrame.toFixed(2)}</td>
              <td className="px-2 py-1.5 text-right" style={{ color: 'var(--text-strong)' }}>{ms(pass.cpuMs?.p50)}</td>
              <td className="px-2 py-1.5 text-right" style={{ color: 'var(--text-muted)' }}>{ms(pass.gpuMs?.p50)}</td>
              <td className="px-2 py-1.5 text-right" style={{ color: 'var(--text-strong)' }}>{count(pass.calls)}</td>
              <td className="px-2.5 py-1.5 text-right" style={{ color: 'var(--text-muted)' }}>{triangles(pass.triangles)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  // i18n-ignore-end
}

// i18n-ignore-start: developer-only render profiler table, kept in English
/**
 * The attribution the frame table cannot give: which frame was hot, which input
 * landed in it, and which script the browser blamed. Recording freezes the panel,
 * so this is read after the gesture (or from the copied report).
 */
function StallSection({ snapshot }: { snapshot: RenderProfilerSnapshot }) {
  const frames = snapshot.frames;
  if (frames.length === 0) return null;
  const origin = frames[0].atMs;
  const hottest = [...frames].sort((a, b) => b.frameMs - a.frameMs).slice(0, 4);
  const events = snapshot.events.slice(-8).reverse();
  const stalls = snapshot.stalls.slice(-4).reverse();
  const worstStall = snapshot.stalls.reduce((worst, stall) => (worst == null || stall.durationMs > worst.durationMs ? stall : worst), null as typeof snapshot.stalls[number] | null);

  return (
    <div className="mt-3">
      <SectionTitle trailing={worstStall ? `worst ${worstStall.durationMs.toFixed(1)} ms (${worstStall.kind})` : 'none recorded'}>
        Hot frames and input
      </SectionTitle>
      <div
        className="custom-scrollbar h-[196px] space-y-1.5 overflow-y-auto rounded-md border px-2.5 py-2 text-[11px]"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
      >
        <div className="text-[10px] font-semibold" style={{ color: 'var(--text-strong)' }}>Worst frames</div>
        {hottest.map((frame, index) => (
          <div key={`hot-${index}-${frame.atMs}`} className="flex items-baseline justify-between gap-2 tabular-nums">
            <span>
              <span style={{ color: frame.frameMs >= 20 ? 'var(--warning)' : 'var(--text-strong)' }}>{frame.frameMs.toFixed(1)} ms</span>
              {frame.stallMs ? <span> · stall {frame.stallMs.toFixed(1)} ms</span> : null}
              {frame.heapDeltaMb != null && frame.heapDeltaMb < -2 ? <span> · heap {frame.heapDeltaMb.toFixed(1)} MiB</span> : null}
            </span>
            <span className="truncate text-right" style={{ maxWidth: '62%' }}>
              +{Math.max(0, frame.atMs - origin).toFixed(0)} ms
              {frame.events?.length ? ` · ${frame.events.join(' > ')}` : ''}
            </span>
          </div>
        ))}

        <div className="pt-1 text-[10px] font-semibold" style={{ color: 'var(--text-strong)' }}>Browser long frames</div>
        {stalls.length === 0 ? (
          <div>None. A long frame with no entry here is not main-thread script or layout.</div>
        ) : stalls.map((stall, index) => (
          <div key={`stall-${index}-${stall.startMs}`} className="tabular-nums">
            <span style={{ color: 'var(--text-strong)' }}>{stall.durationMs.toFixed(1)} ms</span>
            {' '}{stall.kind}
            {stall.blockingMs ? ` · blocking ${stall.blockingMs.toFixed(1)} ms` : ''}
            {' '}· +{Math.max(0, stall.startMs - origin).toFixed(0)} ms
            {stall.scripts?.length ? ` · ${stall.scripts.map((script) => `${script.name} ${script.durationMs.toFixed(1)} ms`).join(', ')}` : ''}
          </div>
        ))}

        <div className="pt-1 text-[10px] font-semibold" style={{ color: 'var(--text-strong)' }}>Input</div>
        {events.length === 0 ? <div>No input recorded.</div> : events.map((event, index) => (
          <div key={`event-${index}-${event.atMs}`} className="tabular-nums">
            <span style={{ color: 'var(--text-strong)' }}>{event.name}</span>
            {event.detail ? ` ${event.detail}` : ''}
            {' '}· +{Math.max(0, event.atMs - origin).toFixed(0)} ms
          </div>
        ))}
      </div>
    </div>
  );
  // i18n-ignore-end
}

function seriesOf(frames: readonly RenderFrameSample[], pick: (frame: RenderFrameSample) => number): number[] {
  return frames.map(pick).filter((value) => Number.isFinite(value));
}

function frameMax(values: number[], minimum: number): number {
  let max = minimum;
  for (const value of values) if (value > max) max = value;
  return max;
}

/**
 * Draggable render profiler window.
 *
 * A DOM card rather than a drei `Html` label: it must keep its own React tree
 * out of the R3F reconciler, survive without a WebGL context, and stay readable
 * while the scene is throttled. The store notifies at 4 Hz, so the window's own
 * rendering cannot distort the numbers it reports.
 */
export function RenderProfilerOverlay() {
  const snapshot = useSyncExternalStore(
    subscribeRenderProfiler,
    getRenderProfilerSnapshot,
    getRenderProfilerSnapshot,
  );
  const [copyState, setCopyState] = React.useState<'idle' | 'copied' | 'failed'>('idle');
  const [mounted, setMounted] = React.useState(false);
  const [position, setPosition] = React.useState<WindowPosition>(() => readStoredPosition() ?? defaultPosition());
  const [dragging, setDragging] = React.useState(false);
  const dragRef = React.useRef<{
    pointerId: number;
    offsetX: number;
    offsetY: number;
    startX: number;
    startY: number;
  } | null>(null);
  const windowRef = React.useRef<HTMLDivElement | null>(null);
  const positionRef = React.useRef(position);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  React.useEffect(() => {
    positionRef.current = position;
  }, [position]);

  React.useEffect(() => {
    const handleResize = () => {
      const height = windowRef.current?.offsetHeight ?? 320;
      const next = clampPosition(positionRef.current, height);
      if (next.x !== positionRef.current.x || next.y !== positionRef.current.y) setPosition(next);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  React.useEffect(() => {
    if (!snapshot.enabled) return;
    const height = windowRef.current?.offsetHeight ?? 320;
    const next = clampPosition(positionRef.current, height);
    if (next.x !== positionRef.current.x || next.y !== positionRef.current.y) {
      positionRef.current = next;
      setPosition(next);
    }
  }, [snapshot.enabled]);

  if (!mounted || !snapshot.enabled) return null;

  const frames = snapshot.frames.slice(-SPARKLINE_FRAMES);
  const frameSeries = seriesOf(frames, (frame) => frame.frameMs);
  const callSeries = seriesOf(frames, (frame) => frame.calls);
  const frameScale = frameMax(frameSeries, 20);
  const callScale = frameMax(callSeries, 1);
  const summary = snapshot.summary;
  const lastFrame = frames[frames.length - 1];

  const handleDragStart = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest('button, a, input, select, textarea')) return;
    const rect = windowRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      startX: event.clientX,
      startY: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const handleDragMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!dragging && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 3) return;
    const height = windowRef.current?.offsetHeight ?? 320;
    const next = clampPosition({
      x: event.clientX - drag.offsetX,
      y: event.clientY - drag.offsetY,
    }, height);
    positionRef.current = next;
    setPosition(next);
  };

  const handleDragEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    try {
      window.localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(positionRef.current));
    } catch {
      // Position persistence is a convenience; a blocked storage is not an error.
    }
  };

  const handleCopy = async () => {
    const copied = await copyRenderProfileReport();
    setCopyState(copied ? 'copied' : 'failed');
    window.setTimeout(() => setCopyState('idle'), 1500);
  };

  // i18n-ignore-start: developer-only render profiler, kept in English
  return (
    <div
      ref={windowRef}
      className="fixed z-[80]"
      style={{ left: position.x, top: position.y, width: `min(${WINDOW_WIDTH}px, calc(100vw - 16px))` }}
    >
      <Card
        className="overflow-hidden shadow-2xl"
        style={{ background: 'var(--surface-0)' }}
      >
      <div
        onPointerDown={handleDragStart}
        onPointerMove={handleDragMove}
        onPointerUp={handleDragEnd}
        onPointerCancel={handleDragEnd}
        style={{ cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none', userSelect: 'none' }}
      >
        <CardHeader
          left={(
            <>
              <span className="text-[13px] font-semibold" style={{ color: 'var(--text-strong)' }}>Render profiler</span>
              <span
                className="rounded border px-1.5 py-0.5 text-[10px]"
                style={{
                  borderColor: 'var(--border-subtle)',
                  color: snapshot.gpuTiming === 'available' || snapshot.gpuTiming === 'sync-probe'
                    ? 'var(--success)'
                    : 'var(--text-muted)',
                }}
                title={
                  snapshot.gpuTiming === 'available'
                    ? 'EXT_disjoint_timer_query_webgl2 is available; GPU times come from timer queries.'
                    : snapshot.gpuTiming === 'sync-probe'
                      ? 'GPU figures come from an explicit gl.finish() probe; it stalls by design.'
                      : 'This WebGL context does not expose EXT_disjoint_timer_query_webgl2. Run GPU probe for a stalling measurement.'
                }
              >
                {snapshot.gpuTiming === 'available'
                  ? 'GPU timer'
                  : snapshot.gpuTiming === 'sync-probe'
                    ? 'GPU sync'
                    : 'CPU only'}
              </span>
            </>
          )}
          right={(
            <IconButton
              variant="ghost"
              size="sm"
              onClick={() => toggleRenderProfilerEnabled()}
              aria-label="Hide render profiler"
              title="Hide (Ctrl+Shift+P)"
            >
              <X className="h-4 w-4" />
            </IconButton>
          )}
        />
      </div>

      <div className="custom-scrollbar max-h-[calc(100vh-110px)] overflow-y-auto px-3 pb-3">
        <div className="mt-3 grid grid-cols-3 gap-2">
          <MetricCard label="FPS" value={summary.fps > 0 ? summary.fps.toFixed(1) : 'n/a'} detail={p95(summary.frameMs, ms)} />
          <MetricCard label="Frame time" value={ms(summary.frameMs?.p50)} detail={p95(summary.frameMs, ms)} />
          <MetricCard label="CPU render" value={ms(summary.cpuMs?.p50)} detail={p95(summary.cpuMs, ms)} />
          <MetricCard label="React commit" value={ms(summary.reactMs?.p50)} detail={p95(summary.reactMs, ms)} />
          <MetricCard label="GPU render" value={ms(summary.gpuMs?.p50)} detail={p95(summary.gpuMs, ms)} />
          <MetricCard label="Draw calls" value={count(summary.calls?.p50)} detail={`max ${count(summary.calls?.max)}`} />
          <MetricCard label="Triangles" value={triangles(summary.triangles?.p50)} detail={`max ${triangles(summary.triangles?.max)}`} />
        </div>

        <div className="mt-3">
          <SectionTitle trailing={summary.frameMs ? `${summary.frameMs.avg.toFixed(2)} ms avg` : 'n/a'}>
            Frame time
          </SectionTitle>
          <div className="rounded-md border px-2 py-1.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <Sparkline values={frameSeries} maxValue={frameScale} stroke="var(--accent)" guide={16.7} />
          </div>
        </div>

        <div className="mt-3">
          <SectionTitle trailing={summary.calls ? `${Math.round(summary.calls.avg)} avg` : 'n/a'}>
            Draw calls
          </SectionTitle>
          <div className="rounded-md border px-2 py-1.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <Sparkline values={callSeries} maxValue={callScale} stroke="var(--accent-secondary)" />
          </div>
        </div>

        <div className="mt-3">
          <SectionTitle trailing={`${summary.passesPerFrame.toFixed(2)} passes/frame`}>Render passes</SectionTitle>
          <PassTable snapshot={snapshot} />
        </div>

        <StallSection snapshot={snapshot} />

        {snapshot.sceneStats && (
          <div className="mt-3">
            <SectionTitle>Scene</SectionTitle>
            <div className="space-y-1 rounded-md border px-2.5 py-2 text-[11px]" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}>
              <div>
                <span style={{ color: 'var(--text-strong)' }}>{snapshot.sceneStats.objects}</span> objects ·{' '}
                <span style={{ color: 'var(--text-strong)' }}>{snapshot.sceneStats.meshes}</span> meshes ·{' '}
                <span style={{ color: 'var(--text-strong)' }}>{snapshot.sceneStats.instancedMeshes}</span> instanced (
                {snapshot.sceneStats.instances} instances) · {triangles(snapshot.sceneStats.triangles)} triangles
              </div>
              <div>
                {(['models', 'supports', 'rafts'] as const).map((group) => (
                  <span key={group} style={{ marginRight: 8 }}>
                    {group} <span style={{ color: 'var(--text-strong)' }}>{triangles(snapshot.sceneStats?.byGroup[group]?.triangles)}</span>
                  </span>
                ))}
              </div>
              <div>
                <span style={{ color: 'var(--text-strong)' }}>{count(lastFrame?.programs)}</span> programs ·{' '}
                <span style={{ color: 'var(--text-strong)' }}>{count(lastFrame?.geometries)}</span> geometries ·{' '}
                <span style={{ color: 'var(--text-strong)' }}>{count(lastFrame?.textures)}</span> textures
              </div>
            </div>
          </div>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant={snapshot.paused ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setRenderProfilerPaused(!snapshot.paused)}
            title="Stop sampling; the renderer is untouched"
          >
            {snapshot.paused ? 'Resume' : 'Pause'}
          </Button>
          <Button
            variant={snapshot.recording.active ? 'tinted-accent' : 'secondary'}
            size="sm"
            onClick={() => (snapshot.recording.active ? stopRenderProfileRecording() : startRenderProfileRecording())}
            title="Capture frames; the summary is written to dragonfruit.log when it fills"
          >
            {snapshot.recording.active ? 'Stop' : 'Record'}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => { void logRenderProfileSummary(); }} title="Write the current summary to dragonfruit.log">
            Write log
          </Button>
          <Button
            variant={snapshot.gpuProbeRemaining > 0 ? 'tinted-accent' : 'secondary'}
            size="sm"
            onClick={() => startGpuSyncProbe(90)}
            title="Measure GPU-inclusive frame cost for 90 frames; this stalls the main thread on purpose"
          >
            {snapshot.gpuProbeRemaining > 0 ? `Probing (${snapshot.gpuProbeRemaining})` : 'GPU probe'}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => { void handleCopy(); }} title="Copy the full report as JSON">
            {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy JSON'}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setRenderProfilerEnabled(false)} title="Turn the profiler off">
            Off
          </Button>
        </div>

        {snapshot.recording.active && (
          <div className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Recording {snapshot.recording.limit} frames; the panel is frozen so it does not cost a frame.
          </div>
        )}
        {snapshot.lastReport && !snapshot.recording.active && (
          <details className="mt-2">
            <summary className="cursor-pointer text-[11px]" style={{ color: 'var(--text-muted)' }}>Last report</summary>
            <div className="custom-scrollbar mt-1 max-h-[72px] overflow-y-auto text-[10px] leading-snug" style={{ color: 'var(--text-muted)' }}>
              {snapshot.lastReport}
            </div>
          </details>
        )}
        <div className="mt-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
          Ctrl+Shift+P toggles · drag the title bar to move · last 240 frames
        </div>
      </div>
      </Card>
    </div>
  );
  // i18n-ignore-end
}
