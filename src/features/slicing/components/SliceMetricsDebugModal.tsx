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

function formatMiBPerSec(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(2)} MiB/s`;
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

type PipelineSlice = {
  name: string;
  ms: number | null;
  pct: number;
  color: string;
};

export function SliceMetricsDebugModal({
  isOpen,
  onClose,
  benchmark,
  outputName,
  outputSizeLabel,
}: SliceMetricsDebugModalProps) {
  const [copyState, setCopyState] = React.useState<'idle' | 'copied' | 'error'>('idle');

  const copyPayload = React.useMemo(() => {
    if (!benchmark) return '';

    const payload = {
      copiedAt: new Date().toISOString(),
      outputName: outputName ?? null,
      outputSizeLabel,
      benchmark,
    };

    return JSON.stringify(payload, null, 2);
  }, [benchmark, outputName, outputSizeLabel]);

  const handleCopyMetrics = React.useCallback(async () => {
    if (!copyPayload) return;

    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
        throw new Error('Clipboard API unavailable');
      }

      await navigator.clipboard.writeText(copyPayload);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
  }, [copyPayload]);

  React.useEffect(() => {
    if (copyState === 'idle') return;
    const id = window.setTimeout(() => setCopyState('idle'), 1800);
    return () => window.clearTimeout(id);
  }, [copyState]);

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
  const nativeVsWallPct = ratioPercent(benchmark.nativePerf.totalMs, benchmark.totalElapsedMs);
  const hasNativeBreakdown = benchmark.nativePerf.totalMs != null && Number.isFinite(benchmark.nativePerf.totalMs) && benchmark.nativePerf.totalMs > 0;
  const pipelineSlices: PipelineSlice[] = [
    {
      name: 'Index build',
      ms: benchmark.nativePerf.indexBuildMs,
      pct: hasNativeBreakdown ? Math.max(0, indexPct ?? 0) : 0,
      color: 'color-mix(in srgb, #60a5fa, var(--surface-1) 20%)',
    },
    {
      name: 'Render pipeline',
      ms: benchmark.nativePerf.renderWallMs,
      pct: hasNativeBreakdown ? Math.max(0, renderWallPct ?? 0) : 0,
      color: 'color-mix(in srgb, var(--accent), #f472b6 28%)',
    },
    {
      name: 'Archive encode',
      ms: benchmark.nativePerf.archiveEncodeMs,
      pct: hasNativeBreakdown ? Math.max(0, archivePct ?? 0) : 0,
      color: 'color-mix(in srgb, #f59e0b, var(--surface-1) 14%)',
    },
    {
      name: 'Other / overhead',
      ms: otherWallMs,
      pct: hasNativeBreakdown ? Math.max(0, otherWallPct) : 0,
      color: 'color-mix(in srgb, #94a3b8, var(--surface-1) 18%)',
    },
  ];
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
        className="relative w-[min(94vw,1500px)] max-h-[92vh] overflow-auto custom-scrollbar rounded-xl border shadow-2xl"
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

          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                void handleCopyMetrics();
              }}
              className="inline-flex h-9 items-center justify-center rounded-lg border px-3 text-xs font-medium transition-colors"
              style={{
                borderColor: 'var(--border-subtle)',
                background: copyState === 'copied'
                  ? 'color-mix(in srgb, var(--accent), var(--surface-1) 88%)'
                  : 'var(--surface-1)',
                color: copyState === 'copied' ? 'var(--text-strong)' : 'var(--text-muted)',
              }}
              aria-label="Copy slice metrics"
              title="Copy all slice metrics as JSON"
            >
              {copyState === 'copied' ? 'Copied!' : copyState === 'error' ? 'Copy failed' : 'Copy'}
            </button>

            <button
              onClick={onClose}
              className="flex h-9 w-9 items-center justify-center rounded-lg border transition-colors hover:bg-red-500/10"
              style={{ borderColor: 'var(--border-subtle)' }}
              aria-label="Close slice metrics"
            >
              <X className="h-4 w-4" style={{ color: 'var(--text-muted)' }} />
            </button>
          </div>
        </div>

        <div className="p-4 md:p-5 space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
            <MetricCard label="Total wall time" value={formatMs(benchmark.totalElapsedMs)} icon={<Timer className="h-4 w-4" />} />
            <MetricCard label="Core slicing" value={formatMs(benchmark.coreSlicingMs)} icon={<Cpu className="h-4 w-4" />} />
            <MetricCard label="Native total" value={formatMs(benchmark.nativePerf.totalMs)} icon={<Activity className="h-4 w-4" />} />
            <MetricCard label="Throughput" value={formatRate(benchmark.layersPerSecond)} icon={<Activity className="h-4 w-4" />} />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <MetricCard compact label="Total layers" value={benchmark.totalLayers?.toLocaleString() ?? '—'} icon={<Layers3 className="h-4 w-4" />} />
            <MetricCard compact label="Render wall share" value={formatPercent(renderWallPct)} icon={<Activity className="h-4 w-4" />} />
            <MetricCard compact label="Native vs wall" value={formatPercent(nativeVsWallPct)} icon={<Activity className="h-4 w-4" />} />
            <MetricCard compact label="Core vs native" value={formatPercent(coreVsNativePct)} icon={<Activity className="h-4 w-4" />} />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-12 gap-3">
            <div className="xl:col-span-8 space-y-3">
              <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="text-sm font-semibold mb-2" style={{ color: 'var(--text-strong)' }}>Pipeline Timing</div>
                <div className="space-y-3">
                  <div className="rounded-lg border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
                    <div className="flex items-center gap-3">
                      <PipelinePie slices={pipelineSlices} />
                      <div className="min-w-0 flex-1 space-y-0.5">
                        {pipelineSlices.map((slice) => (
                          <RuntimeStat
                            key={slice.name}
                            label={slice.name}
                            value={`${formatMs(slice.ms, 3)} • ${formatPercent(slice.pct)}`}
                          />
                        ))}
                        <RuntimeStat label="Native total" value={`${formatMs(benchmark.nativePerf.totalMs, 3)} • ${formatPercent(hasNativeBreakdown ? 100 : null)}`} />
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="rounded-lg border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
                      <div className="text-xs font-semibold mb-1.5" style={{ color: 'var(--text-strong)' }}>Per-layer KPIs</div>
                      <div className="space-y-0.5 text-xs">
                        <RuntimeStat label="Render wall / layer" value={formatMs(benchmark.nativePerf.renderWallMsPerLayer, 3)} />
                        <RuntimeStat label="Render CPU / layer" value={formatMs(benchmark.nativePerf.renderCpuMsPerLayer, 3)} />
                        <RuntimeStat label="PNG CPU / layer" value={formatMs(benchmark.nativePerf.pngCpuMsPerLayer, 3)} />
                        <RuntimeStat label="Native total / layer" value={formatMs(benchmark.nativePerf.totalMsPerLayer, 3)} />
                      </div>
                    </div>

                    <div className="rounded-lg border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
                      <div className="text-xs font-semibold mb-1.5" style={{ color: 'var(--text-strong)' }}>Overhead Snapshot</div>
                      <div className="space-y-0.5 text-xs">
                        <RuntimeStat label="Wall vs native total" value={formatPercent(wallVsNativePct)} />
                        <RuntimeStat label="Native vs app wall" value={formatPercent(nativeVsWallPct)} />
                        <RuntimeStat label="Core vs app wall" value={formatPercent(coreVsWallPct)} />
                        <RuntimeStat label="Mesh prep vs app wall" value={formatPercent(meshPrepVsWallPct)} />
                        <RuntimeStat label="CPU agg vs render wall" value={formatPercent(workerCpuVsRenderWallPct)} />
                        <RuntimeStat label="Transport overhead" value={formatMs(benchmark.nativePerf.transportOverheadMs, 2)} />
                        <RuntimeStat label="Stage mesh IPC" value={formatMs(benchmark.nativePerf.stageMeshMs, 2)} />
                        <RuntimeStat label="Stage throughput" value={formatMiBPerSec(benchmark.nativePerf.stageMeshThroughputMiBPerSec)} />
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="text-sm font-semibold mb-2" style={{ color: 'var(--text-strong)' }}>
                  Raw Counters
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-0.5 text-xs max-h-[28vh] overflow-auto custom-scrollbar pr-1">
                  <RuntimeStat label="Stage file path" value={benchmark.jobConfig.meshStageFilePath ?? '—'} />
                  <RuntimeStat label="artifactDir" value={runtime?.artifactDir ?? '—'} />
                  <RuntimeStat label="meshStageDir" value={runtime?.meshStageDir ?? '—'} />
                  <RuntimeStat label="bridgePayloadChars" value={benchmark.nativePerf.bridgePayloadChars != null ? benchmark.nativePerf.bridgePayloadChars.toLocaleString() : '—'} />
                  <RuntimeStat label="triangleFloatCount" value={benchmark.nativePerf.triangleFloatCount != null ? benchmark.nativePerf.triangleFloatCount.toLocaleString() : '—'} />
                  <RuntimeStat label="meshBytesLen" value={benchmark.nativePerf.meshBytesLen != null ? benchmark.nativePerf.meshBytesLen.toLocaleString() : '—'} />
                  <RuntimeStat label="stageMeshChunkCount" value={benchmark.nativePerf.stageMeshChunkCount != null ? benchmark.nativePerf.stageMeshChunkCount.toLocaleString() : '—'} />
                  <RuntimeStat label="stageMeshAvgChunkBytes" value={benchmark.nativePerf.stageMeshAvgChunkBytes != null ? Math.round(benchmark.nativePerf.stageMeshAvgChunkBytes).toLocaleString() : '—'} />
                  <RuntimeStat label="stageMeshAckAppendMs" value={benchmark.nativePerf.stageMeshAckAppendMs != null ? benchmark.nativePerf.stageMeshAckAppendMs.toFixed(3) : '—'} />
                  <RuntimeStat label="stageMeshCapacityMaxBytes" value={benchmark.nativePerf.stageMeshCapacityMaxBytes != null ? benchmark.nativePerf.stageMeshCapacityMaxBytes.toLocaleString() : '—'} />
                  <RuntimeStat label="stageMeshReserveGrowthEvents" value={benchmark.nativePerf.stageMeshReserveGrowthEvents != null ? benchmark.nativePerf.stageMeshReserveGrowthEvents.toLocaleString() : '—'} />
                  <RuntimeStat label="totalNs" value={formatNs(perf?.totalNs)} />
                  <RuntimeStat label="indexBuildNs" value={formatNs(perf?.indexBuildNs)} />
                  <RuntimeStat label="renderWallNs" value={formatNs(perf?.renderWallNs)} />
                  <RuntimeStat label="renderNs" value={formatNs(perf?.renderNs)} />
                  <RuntimeStat label="pngEncodeNs" value={formatNs(perf?.pngEncodeNs)} />
                  <RuntimeStat label="archiveEncodeNs" value={formatNs(perf?.archiveEncodeNs)} />
                  <RuntimeStat label="zBlendBackwardNs" value={formatNs(perf?.zBlendBackwardNs)} />
                  <RuntimeStat label="zBlendForwardNs" value={formatNs(perf?.zBlendForwardNs)} />
                  <RuntimeStat label="postBlurNs" value={formatNs(perf?.postBlurNs)} />
                  <RuntimeStat label="supportMergeNs" value={formatNs(perf?.supportMergeNs)} />
                  <RuntimeStat label="layers" value={perf?.layers != null ? `${perf.layers}` : '—'} />
                  <RuntimeStat label="Core vs native total" value={formatPercent(coreVsNativePct)} />
                  <RuntimeStat label="Bridge payload build" value={formatMs(benchmark.nativePerf.bridgePayloadBuildMs, 2)} />
                  <RuntimeStat label="Bridge invoke roundtrip" value={formatMs(benchmark.nativePerf.bridgeInvokeRoundTripMs, 2)} />
                  <RuntimeStat label="Bridge total" value={formatMs(benchmark.nativePerf.bridgeTotalMs, 2)} />
                  <RuntimeStat label="Worker CPU aggregate" value={formatMs(workerCpuAggregateMs, 2)} />
                  <RuntimeStat label="Mesh prep" value={formatMs(benchmark.meshPrepMs)} />
                </div>
              </div>
            </div>

            <div className="xl:col-span-4 flex flex-col gap-3">
              <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="text-sm font-semibold mb-2" style={{ color: 'var(--text-strong)' }}>V3 Runtime Configuration</div>
                <div className="space-y-0.5 text-xs">
                  <RuntimeStat label="Rayon pool threads" value={runtime ? String(runtime.poolThreads) : '—'} />
                  <RuntimeStat label="Max concurrent workers" value={runtime ? String(runtime.maxConcurrent) : '—'} />
                  <RuntimeStat label="Bounded queue buffer" value={runtime ? String(runtime.queueBuffer) : '—'} />
                  <RuntimeStat label="3DAA post threads" value={runtime?.daaPostThreads != null ? String(runtime.daaPostThreads) : '—'} />
                  <RuntimeStat label="3DAA post buffer" value={runtime?.daaPostBufferDepth != null ? String(runtime.daaPostBufferDepth) : '—'} />
                  <RuntimeStat label="Build profile" value={runtime?.buildProfile ?? '—'} />
                  <RuntimeStat label="Metadata parse" value={formatNs(runtime?.metadataParseNs)} />
                  <RuntimeStat label="Mesh decode" value={formatNs(runtime?.meshDecodeNs)} />
                  <RuntimeStat label="Artifact metadata" value={formatNs(runtime?.artifactMetadataNs)} />
                  <RuntimeStat label="Wrapper total" value={formatNs(runtime?.wrapperTotalNs)} />
                  <RuntimeStat label="Wrapper overhead" value={formatNs(runtime?.wrapperOverheadNs)} />
                </div>
              </div>

              <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="text-sm font-semibold mb-2" style={{ color: 'var(--text-strong)' }}>Output & Render Configuration</div>
                <div className="space-y-0.5 text-xs">
                  <RuntimeStat label="Output format" value={`${benchmark.jobConfig.outputDisplayName} (${benchmark.jobConfig.outputFormat})`} />
                  <RuntimeStat label="Source raster" value={`${benchmark.jobConfig.sourceWidthPx} × ${benchmark.jobConfig.sourceHeightPx}`} />
                  <RuntimeStat label="Logical output" value={`${benchmark.jobConfig.widthPx} × ${benchmark.jobConfig.heightPx}`} />
                  <RuntimeStat label="Build area" value={`${benchmark.jobConfig.buildWidthMm.toFixed(2)} × ${benchmark.jobConfig.buildDepthMm.toFixed(2)} mm`} />
                  <RuntimeStat label="Layer height" value={`${benchmark.jobConfig.layerHeightMm.toFixed(4)} mm`} />
                  <RuntimeStat label="AA level" value={benchmark.jobConfig.antiAliasingLevel} />
                  <RuntimeStat label="Compute backend" value={benchmark.jobConfig.computeBackend} />
                  <RuntimeStat label="PNG strategy" value={benchmark.jobConfig.pngCompressionStrategy} />
                  <RuntimeStat label="Container compression" value={String(benchmark.jobConfig.containerCompressionLevel)} />
                  <RuntimeStat label="X packing mode" value={benchmark.jobConfig.xPackingMode} />
                  <RuntimeStat label="Mesh transfer mode" value={benchmark.jobConfig.meshTransferMode} />
                  <RuntimeStat label="Mesh encoding" value={benchmark.jobConfig.meshEncoding} />
                  <RuntimeStat label="BVH accel requested" value={benchmark.jobConfig.bvhAccelerationEnabled ? 'true' : 'false'} />
                  <RuntimeStat label="Initial staging reserve" value={formatBytes(benchmark.jobConfig.initialMeshStagingBytes)} />
                  <RuntimeStat label="Target chunk size" value={formatBytes(benchmark.jobConfig.meshChunkTargetBytes)} />
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="text-sm font-semibold mb-2" style={{ color: 'var(--text-strong)' }}>Geometry & Payload</div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-x-3 gap-y-0.5 text-xs">
              <RuntimeStat label="Model triangles" value={benchmark.jobConfig.modelTriangleCount.toLocaleString()} />
              <RuntimeStat label="Triangles / layer" value={trianglesPerLayer != null ? trianglesPerLayer.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'} />
              <RuntimeStat label="Triangle floats" value={benchmark.jobConfig.triangleFloatCount.toLocaleString()} />
              <RuntimeStat label="Staged mesh bytes" value={formatBytes(benchmark.nativePerf.stageMeshBytes)} />
              <RuntimeStat label="Mesh payload bytes" value={formatBytes(benchmark.nativePerf.meshBytesLen)} />
              <RuntimeStat label="Bridge payload chars" value={benchmark.nativePerf.bridgePayloadChars != null ? benchmark.nativePerf.bridgePayloadChars.toLocaleString() : '—'} />
              <RuntimeStat label="Staged chunk count" value={benchmark.nativePerf.stageMeshChunkCount != null ? benchmark.nativePerf.stageMeshChunkCount.toLocaleString() : '—'} />
              <RuntimeStat label="Average chunk bytes" value={formatBytes(benchmark.nativePerf.stageMeshAvgChunkBytes)} />
              <RuntimeStat label="Staging max capacity" value={formatBytes(benchmark.nativePerf.stageMeshCapacityMaxBytes)} />
              <RuntimeStat label="Reserve growth events" value={(benchmark.nativePerf.stageMeshReserveGrowthEvents ?? 0).toLocaleString()} />
              <RuntimeStat label="Metadata JSON" value={formatBytes(benchmark.jobConfig.metadataJsonBytes)} />
              <RuntimeStat label="Thumbnail" value={benchmark.jobConfig.exportThumbnailProvided ? formatBytes(benchmark.jobConfig.exportThumbnailBytes) : 'none'} />
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  icon,
  compact = false,
}: { label: string; value: string; icon: React.ReactNode; compact?: boolean }) {
  return (
    <div
      className={compact ? 'rounded-lg border px-2.5 py-2' : 'rounded-lg border px-3 py-2.5'}
      style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
          {icon}
          <span className="truncate">{label}</span>
        </div>
        <div className={compact ? 'text-sm font-semibold tabular-nums whitespace-nowrap leading-tight' : 'text-base font-semibold tabular-nums whitespace-nowrap leading-tight'} style={{ color: 'var(--text-strong)' }}>{value}</div>
      </div>
    </div>
  );
}

function RuntimeStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 py-1 border-b last:border-b-0" style={{ borderColor: 'color-mix(in srgb, var(--border-subtle), transparent 35%)' }}>
      <span className="min-w-0 text-xs" style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span className="font-mono text-right text-xs break-all leading-tight" style={{ color: 'var(--text-strong)' }}>{value}</span>
    </div>
  );
}

function PipelinePie({ slices }: { slices: PipelineSlice[] }) {
  const total = slices.reduce((acc, slice) => acc + Math.max(0, slice.pct), 0);
  let cursor = 0;
  const stops: string[] = [];
  for (const slice of slices) {
    const start = cursor;
    const end = Math.min(100, start + Math.max(0, slice.pct));
    if (end > start) {
      stops.push(`${slice.color} ${start.toFixed(3)}% ${end.toFixed(3)}%`);
    }
    cursor = end;
  }

  const pieBackground = total > 0
    ? `conic-gradient(${stops.join(', ')})`
    : 'conic-gradient(var(--surface-2) 0% 100%)';

  return (
    <div className="relative h-20 w-20 shrink-0 rounded-full border" style={{ borderColor: 'var(--border-subtle)', background: pieBackground }}>
      <div
        className="absolute inset-[26%] rounded-full border"
        style={{
          borderColor: 'var(--border-subtle)',
          background: 'var(--surface-1)',
        }}
      >
        <div className="flex h-full w-full items-center justify-center text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>
          {total > 0 ? 'Timing' : '—'}
        </div>
      </div>
    </div>
  );
}

export default SliceMetricsDebugModal;
