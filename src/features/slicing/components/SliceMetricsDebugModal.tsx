import React from 'react';
import { Activity, Cpu, Layers3, Timer, X } from 'lucide-react';
import type { SliceExportResult } from '@/features/slicing/sliceExportOrchestrator';

type SliceMetricsDebugModalProps = {
  isOpen: boolean;
  onClose: () => void;
  benchmark: SliceExportResult['benchmark'] | null;
  outputName: string | null;
  outputSizeLabel: string;
};

function formatMs(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  return `${value.toFixed(digits)} ms`;
}

function formatNs(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${Math.round(value).toLocaleString()} ns`;
}

function formatRate(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value >= 100) return `${Math.round(value).toLocaleString()} layers/s`;
  return `${value.toFixed(2)} layers/s`;
}

function formatBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const bytes = Math.max(0, value);
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(1)}%`;
}

function ratioPercent(numerator: number | null | undefined, denominator: number | null | undefined): number | null {
  if (numerator == null || denominator == null) return null;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (denominator <= 0) return null;
  return (numerator / denominator) * 100;
}

export function SliceMetricsDebugModal({
  isOpen,
  onClose,
  benchmark,
  outputName,
  outputSizeLabel,
}: SliceMetricsDebugModalProps) {
  if (!isOpen || !benchmark) return null;

  const perf = benchmark.nativePerf.perf;
  const runtime = benchmark.nativePerf.runtime;

  const renderWallPct = ratioPercent(benchmark.nativePerf.renderWallMs, benchmark.nativePerf.totalMs);
  const indexPct = ratioPercent(benchmark.nativePerf.indexBuildMs, benchmark.nativePerf.totalMs);
  const archivePct = ratioPercent(benchmark.nativePerf.archiveEncodeMs, benchmark.nativePerf.totalMs);
  const knownWallPct = (indexPct ?? 0) + (renderWallPct ?? 0) + (archivePct ?? 0);
  const otherWallPct = Math.max(0, 100 - knownWallPct);
  const otherWallMs = benchmark.nativePerf.totalMs != null
    ? Math.max(0, benchmark.nativePerf.totalMs - ((benchmark.nativePerf.indexBuildMs ?? 0) + (benchmark.nativePerf.renderWallMs ?? 0) + (benchmark.nativePerf.archiveEncodeMs ?? 0)))
    : null;

  const wallVsNativePct = ratioPercent(benchmark.totalElapsedMs, benchmark.nativePerf.totalMs);
  const coreVsNativePct = ratioPercent(benchmark.coreSlicingMs, benchmark.nativePerf.totalMs);
  const workerCpuAggregateMs = ((benchmark.nativePerf.renderCpuMs ?? 0) + (benchmark.nativePerf.pngEncodeCpuMs ?? 0)) || null;
  const workerCpuVsRenderWallPct = ratioPercent(workerCpuAggregateMs, benchmark.nativePerf.renderWallMs);
  const meshPrepVsWallPct = ratioPercent(benchmark.meshPrepMs, benchmark.totalElapsedMs);
  const coreVsWallPct = ratioPercent(benchmark.coreSlicingMs, benchmark.totalElapsedMs);
  const trianglesPerLayer = benchmark.totalLayers && benchmark.totalLayers > 0
    ? benchmark.jobConfig.triangleFloatCount / 9 / benchmark.totalLayers
    : null;

  return (
    <div
      className="fixed inset-0 z-[140] flex items-center justify-center"
      style={{ background: 'rgba(0, 0, 0, 0.72)' }}
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-5xl max-h-[92vh] overflow-auto rounded-xl border shadow-2xl"
        style={{ background: 'var(--surface-0)', borderColor: 'var(--border-subtle)' }}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Slice performance metrics"
      >
        <div
          className="sticky top-0 z-10 flex items-center justify-between p-4 border-b"
          style={{ background: 'var(--surface-0)', borderColor: 'var(--border-subtle)' }}
        >
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="flex h-10 w-10 items-center justify-center rounded-lg border"
              style={{
                borderColor: 'var(--border-subtle)',
                background: 'color-mix(in srgb, var(--accent), var(--surface-1) 88%)',
              }}
            >
              <Activity className="h-5 w-5" style={{ color: 'var(--accent)' }} />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold truncate" style={{ color: 'var(--text-strong)' }}>
                Slice Performance Metrics (V3)
              </h2>
              <p className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                {outputName ?? 'Latest slicing run'} • {outputSizeLabel}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-lg border transition-colors hover:bg-red-500/10"
            style={{ borderColor: 'var(--border-subtle)' }}
            aria-label="Close slice metrics"
          >
            <X className="h-4 w-4" style={{ color: 'var(--text-muted)' }} />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MetricCard label="Total wall time" value={formatMs(benchmark.totalElapsedMs)} icon={<Timer className="h-4 w-4" />} />
            <MetricCard label="Core slicing" value={formatMs(benchmark.coreSlicingMs)} icon={<Cpu className="h-4 w-4" />} />
            <MetricCard label="Total layers" value={benchmark.totalLayers?.toLocaleString() ?? '—'} icon={<Layers3 className="h-4 w-4" />} />
            <MetricCard label="Throughput" value={formatRate(benchmark.layersPerSecond)} icon={<Activity className="h-4 w-4" />} />
          </div>

          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="text-sm font-semibold mb-2" style={{ color: 'var(--text-strong)' }}>V3 Runtime Configuration</div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
              <RuntimeStat label="Rayon pool threads" value={runtime ? String(runtime.poolThreads) : '—'} />
              <RuntimeStat label="Max concurrent workers" value={runtime ? String(runtime.maxConcurrent) : '—'} />
              <RuntimeStat label="Bounded queue buffer" value={runtime ? String(runtime.queueBuffer) : '—'} />
            </div>
          </div>

          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="text-sm font-semibold mb-2" style={{ color: 'var(--text-strong)' }}>Job Configuration</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-1 text-xs">
              <RuntimeStat label="Output format" value={`${benchmark.jobConfig.outputDisplayName} (${benchmark.jobConfig.outputFormat})`} />
              <RuntimeStat label="Source raster" value={`${benchmark.jobConfig.sourceWidthPx} × ${benchmark.jobConfig.sourceHeightPx}`} />
              <RuntimeStat label="Logical output" value={`${benchmark.jobConfig.widthPx} × ${benchmark.jobConfig.heightPx}`} />
              <RuntimeStat label="X packing mode" value={benchmark.jobConfig.xPackingMode} />
              <RuntimeStat label="Compute backend" value={benchmark.jobConfig.computeBackend} />
              <RuntimeStat label="PNG strategy" value={benchmark.jobConfig.pngCompressionStrategy} />
              <RuntimeStat label="Container compression" value={String(benchmark.jobConfig.containerCompressionLevel)} />
              <RuntimeStat label="BVH accel requested" value={benchmark.jobConfig.bvhAccelerationEnabled ? 'true' : 'false'} />
              <RuntimeStat label="AA level" value={benchmark.jobConfig.antiAliasingLevel} />
              <RuntimeStat label="AA on supports" value={benchmark.jobConfig.aaOnSupports ? 'true' : 'false'} />
              <RuntimeStat label="Layer height" value={`${benchmark.jobConfig.layerHeightMm.toFixed(4)} mm`} />
              <RuntimeStat label="Build area" value={`${benchmark.jobConfig.buildWidthMm.toFixed(2)} × ${benchmark.jobConfig.buildDepthMm.toFixed(2)} mm`} />
            </div>
          </div>

          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="text-sm font-semibold mb-2" style={{ color: 'var(--text-strong)' }}>Geometry / Payload</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-1 text-xs">
              <RuntimeStat label="Model triangles" value={benchmark.jobConfig.modelTriangleCount.toLocaleString()} />
              <RuntimeStat label="Triangle floats" value={benchmark.jobConfig.triangleFloatCount.toLocaleString()} />
              <RuntimeStat label="Triangles per layer" value={trianglesPerLayer != null ? trianglesPerLayer.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'} />
              <RuntimeStat label="Metadata JSON" value={formatBytes(benchmark.jobConfig.metadataJsonBytes)} />
              <RuntimeStat label="Thumbnail provided" value={benchmark.jobConfig.exportThumbnailProvided ? 'true' : 'false'} />
              <RuntimeStat label="Thumbnail bytes" value={formatBytes(benchmark.jobConfig.exportThumbnailBytes)} />
              <RuntimeStat label="Mesh payload bytes" value={formatBytes(benchmark.nativePerf.meshBytesLen)} />
              <RuntimeStat label="Bridge payload chars" value={benchmark.nativePerf.bridgePayloadChars != null ? benchmark.nativePerf.bridgePayloadChars.toLocaleString() : '—'} />
            </div>
          </div>

          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="text-sm font-semibold mb-2" style={{ color: 'var(--text-strong)' }}>Native Stage Breakdown (wall clock)</div>
            <div className="space-y-2">
              <StageRow name="Index build" ms={benchmark.nativePerf.indexBuildMs} pct={indexPct} />
              <StageRow name="Render pipeline" ms={benchmark.nativePerf.renderWallMs} pct={renderWallPct} />
              <StageRow name="Archive encode" ms={benchmark.nativePerf.archiveEncodeMs} pct={archivePct} />
              <StageRow name="Other / overhead" ms={otherWallMs} pct={otherWallPct} />
              <StageRow name="Native total" ms={benchmark.nativePerf.totalMs} pct={100} forceAccent />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
              <div className="text-sm font-semibold mb-2" style={{ color: 'var(--text-strong)' }}>Per-layer KPIs</div>
              <div className="space-y-1 text-xs">
                <RuntimeStat label="Render wall per layer" value={formatMs(benchmark.nativePerf.renderWallMsPerLayer, 3)} />
                <RuntimeStat label="Render CPU per layer" value={formatMs(benchmark.nativePerf.renderCpuMsPerLayer, 3)} />
                <RuntimeStat label="PNG CPU per layer" value={formatMs(benchmark.nativePerf.pngCpuMsPerLayer, 3)} />
                <RuntimeStat label="Native total per layer" value={formatMs(benchmark.nativePerf.totalMsPerLayer, 3)} />
              </div>
            </div>

            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
              <div className="text-sm font-semibold mb-2" style={{ color: 'var(--text-strong)' }}>Correlation / Overhead</div>
              <div className="space-y-1 text-xs">
                <RuntimeStat label="Wall vs native total" value={formatPercent(wallVsNativePct)} />
                <RuntimeStat label="Core vs native total" value={formatPercent(coreVsNativePct)} />
                <RuntimeStat label="Core vs app wall" value={formatPercent(coreVsWallPct)} />
                <RuntimeStat label="Mesh prep vs app wall" value={formatPercent(meshPrepVsWallPct)} />
                <RuntimeStat label="Transport overhead" value={formatMs(benchmark.nativePerf.transportOverheadMs, 2)} />
                <RuntimeStat label="Stage mesh IPC" value={formatMs(benchmark.nativePerf.stageMeshMs, 2)} />
                <RuntimeStat label="Bridge payload build" value={formatMs(benchmark.nativePerf.bridgePayloadBuildMs, 2)} />
                <RuntimeStat label="Bridge invoke roundtrip" value={formatMs(benchmark.nativePerf.bridgeInvokeRoundTripMs, 2)} />
                <RuntimeStat label="Bridge total" value={formatMs(benchmark.nativePerf.bridgeTotalMs, 2)} />
                <RuntimeStat label="Worker CPU aggregate" value={formatMs(workerCpuAggregateMs, 2)} />
                <RuntimeStat label="CPU agg vs render wall" value={formatPercent(workerCpuVsRenderWallPct)} />
                <RuntimeStat label="Mesh prep" value={formatMs(benchmark.meshPrepMs)} />
              </div>
            </div>
          </div>

          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="text-sm font-semibold mb-2" style={{ color: 'var(--text-strong)' }}>Raw Perf Counters</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-1 text-xs">
              <RuntimeStat label="bridgePayloadChars" value={benchmark.nativePerf.bridgePayloadChars != null ? benchmark.nativePerf.bridgePayloadChars.toLocaleString() : '—'} />
              <RuntimeStat label="triangleFloatCount" value={benchmark.nativePerf.triangleFloatCount != null ? benchmark.nativePerf.triangleFloatCount.toLocaleString() : '—'} />
              <RuntimeStat label="meshBytesLen" value={benchmark.nativePerf.meshBytesLen != null ? benchmark.nativePerf.meshBytesLen.toLocaleString() : '—'} />
              <RuntimeStat label="totalNs" value={formatNs(perf?.totalNs)} />
              <RuntimeStat label="indexBuildNs" value={formatNs(perf?.indexBuildNs)} />
              <RuntimeStat label="renderWallNs" value={formatNs(perf?.renderWallNs)} />
              <RuntimeStat label="renderNs" value={formatNs(perf?.renderNs)} />
              <RuntimeStat label="pngEncodeNs" value={formatNs(perf?.pngEncodeNs)} />
              <RuntimeStat label="archiveEncodeNs" value={formatNs(perf?.archiveEncodeNs)} />
              <RuntimeStat label="layers" value={perf?.layers != null ? `${perf.layers}` : '—'} />
            </div>
          </div>

          <div className="text-[11px] text-center" style={{ color: 'var(--text-muted)' }}>
            Toggle: Ctrl+Shift+A (desktop debug metrics)
          </div>
        </div>
      </div>
    </div>
  );
}

function MetricCard({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-1 text-sm font-semibold tabular-nums" style={{ color: 'var(--text-strong)' }}>{value}</div>
    </div>
  );
}

function RuntimeStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded border px-2 py-1" style={{ borderColor: 'var(--border-subtle)' }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span className="font-mono" style={{ color: 'var(--text-strong)' }}>{value}</span>
    </div>
  );
}

function StageRow({ name, ms, pct, forceAccent = false }: { name: string; ms: number | null; pct: number | null; forceAccent?: boolean }) {
  const width = Math.max(0, Math.min(100, pct ?? 0));
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span style={{ color: 'var(--text-strong)' }}>{name}</span>
        <span className="font-mono" style={{ color: 'var(--text-muted)' }}>
          {formatMs(ms, 3)} • {formatPercent(pct)}
        </span>
      </div>
      <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--surface-2)' }}>
        <div
          className="h-full"
          style={{
            width: `${width}%`,
            background: forceAccent
              ? 'linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent), white 18%))'
              : 'linear-gradient(90deg, color-mix(in srgb, var(--accent), #60a5fa 35%), color-mix(in srgb, var(--accent), #f472b6 35%))',
          }}
        />
      </div>
    </div>
  );
}

export default SliceMetricsDebugModal;
