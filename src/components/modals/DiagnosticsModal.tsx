'use client';

import React from 'react';
import { X } from 'lucide-react';

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
};

const GRAPH_WINDOW_SECONDS = 120;
const SAMPLE_INTERVAL_MS = 250;
const MAX_GRAPH_POINTS = Math.floor((GRAPH_WINDOW_SECONDS * 1000) / SAMPLE_INTERVAL_MS);

function formatBytes(bytes: number | null): string {
  if (bytes == null || !Number.isFinite(bytes)) return 'N/A';
  const abs = Math.max(0, bytes);
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;

  if (abs >= GB) return `${(abs / GB).toFixed(2)} GB`;
  if (abs >= MB) return `${(abs / MB).toFixed(2)} MB`;
  if (abs >= KB) return `${(abs / KB).toFixed(1)} KB`;
  return `${abs.toFixed(0)} B`;
}

function formatPercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'N/A';
  return `${(value * 100).toFixed(1)}%`;
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
        });
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', onKeyDown);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const hardwareConcurrency = navigator.hardwareConcurrency;
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
              Runtime telemetry for Dragonfruit (toggle with Ctrl+Shift+D)
            </p>
          </div>
          <button
            onClick={onClose}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md border transition-colors"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'var(--surface-1)',
              color: 'var(--text-muted)',
            }}
            aria-label="Close diagnostics"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="max-h-[calc(88vh-58px)] overflow-y-auto p-4 space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>FPS</div>
              <div className="text-xl font-semibold" style={{ color: 'var(--text-strong)' }}>{stats.fps.toFixed(1)}</div>
            </div>
            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Frame Time</div>
              <div className="text-xl font-semibold" style={{ color: 'var(--text-strong)' }}>{stats.frameTimeMs.toFixed(2)} ms</div>
            </div>
            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Used JS Heap</div>
              <div className="text-xl font-semibold" style={{ color: 'var(--text-strong)' }}>{formatBytes(stats.usedJsHeapBytes)}</div>
            </div>
            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Heap Usage</div>
              <div className="text-xl font-semibold" style={{ color: 'var(--text-strong)' }}>{formatPercent(heapUsageRatio)}</div>
            </div>
            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>CPU Usage (est.)</div>
              <div className="text-xl font-semibold" style={{ color: 'var(--text-strong)' }}>{stats.cpuUsageEstimate.toFixed(0)}%</div>
            </div>
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
                <div>Total Polygons: <span style={{ color: 'var(--text-strong)' }}>{totalPolygons.toLocaleString()}</span></div>
                <div>Selected Polygons: <span style={{ color: 'var(--text-strong)' }}>{selectedPolygons.toLocaleString()}</span></div>
              </div>
            </div>

            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
              <div className="text-[12px] font-semibold mb-2" style={{ color: 'var(--text-strong)' }}>System</div>
              <div className="space-y-1 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                <div>Logical CPU Cores: <span style={{ color: 'var(--text-strong)' }}>{hardwareConcurrency ?? 'N/A'}</span></div>
                <div>Device Memory: <span style={{ color: 'var(--text-strong)' }}>{deviceMemory ? `${deviceMemory} GB` : 'N/A'}</span></div>
                <div>Total JS Heap: <span style={{ color: 'var(--text-strong)' }}>{formatBytes(stats.totalJsHeapBytes)}</span></div>
                <div>JS Heap Limit: <span style={{ color: 'var(--text-strong)' }}>{formatBytes(stats.heapLimitBytes)}</span></div>
                <div>User Agent: <span style={{ color: 'var(--text-strong)' }}>{navigator.userAgent}</span></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
