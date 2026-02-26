import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Cpu, Gauge, Layers3, Timer } from 'lucide-react';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { Button, Card, CardHeader, IconButton, Input } from '@/components/ui/primitives';
import {
  getActiveMaterialProfile,
  getActivePrinterProfile,
  getProfileStoreServerSnapshot,
  getProfileStoreSnapshot,
  subscribeToProfileStore,
} from '@/features/profiles/profileStore';
import {
  runSliceExportOrchestrator,
  type SliceExportArtifact,
  type SliceExportResult,
} from '@/features/slicing/sliceExportOrchestrator';
import { isSlicerWasmAvailable } from '@/features/slicing/wasm/slicerWasmBridge';
import { resolveSlicingFormatDefinition } from '@/features/slicing/formats/registry';

interface SlicingPanelProps {
  models: LoadedModel[];
  activeModel: LoadedModel | null;
  captureSceneThumbnailPng?: () => Promise<Uint8Array | null>;
  onLayerPreviewGenerated?: (payload: {
    layerIndex: number;
    totalLayers: number;
    pngBytes: Uint8Array;
  }) => void;
  onSlicingFinished?: (payload: {
    totalLayers: number;
  }) => void;
  onSliceArtifactReady?: (artifact: SliceExportArtifact) => void;
}

type LifetimeTelemetry = {
  runCount: number;
  totalElapsedMs: number;
  totalRasterMs: number;
  lastElapsedMs: number | null;
  lastRasterMs: number | null;
  lastBackend: 'wasm-nanodlp' | 'js-raster-zip' | null;
};

type SliceBenchmarkSnapshot = SliceExportResult['benchmark'];

function normalizeExportBaseName(rawName: string | null | undefined): string {
  const trimmed = (rawName ?? '').trim();
  if (!trimmed) return 'MyPrint';

  const withoutKnownExt = trimmed.replace(/(\.(stl|obj|3mf|lys|lychee|json))+$/i, '');
  const cleaned = withoutKnownExt.replace(/[.\s]+$/g, '').trim();
  return cleaned || 'MyPrint';
}

function formatDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function formatLayerRate(layersPerSecond: number | null): string {
  if (layersPerSecond == null || !Number.isFinite(layersPerSecond)) return '—';
  if (layersPerSecond >= 100) return `${Math.round(layersPerSecond)} layers/s`;
  return `${layersPerSecond.toFixed(1)} layers/s`;
}

function formatProgressLayerLabel(done: number, total: number): string {
  const totalSafe = Math.max(1, Math.round(total));
  const doneSafe = Math.max(0, Math.min(totalSafe, Math.round(done)));
  return `${doneSafe}/${totalSafe}`;
}

function formatElapsedClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }

  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function SlicingPanel({
  models,
  activeModel,
  captureSceneThumbnailPng,
  onLayerPreviewGenerated,
  onSlicingFinished,
  onSliceArtifactReady,
}: SlicingPanelProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [filename, setFilename] = useState(() => normalizeExportBaseName(activeModel?.name));
  const [isSlicingZip, setIsSlicingZip] = useState(false);
  const [sliceStatus, setSliceStatus] = useState('Idle');
  const [wasmStatus, setWasmStatus] = useState<'n/a' | 'checking' | 'available' | 'missing'>('n/a');
  const [currentPhase, setCurrentPhase] = useState('Idle');
  const [progressDone, setProgressDone] = useState(0);
  const [progressTotal, setProgressTotal] = useState(1);
  const [currentElapsedMs, setCurrentElapsedMs] = useState(0);
  const [currentRasterMs, setCurrentRasterMs] = useState(0);
  const [showSlicingModal, setShowSlicingModal] = useState(false);
  const [slicingModalStage, setSlicingModalStage] = useState<'running' | 'finished' | 'failed' | 'cancelled'>('running');
  const [displayProgressPercent, setDisplayProgressPercent] = useState(0);
  const [layerPreviewUrls, setLayerPreviewUrls] = useState<Array<string | null>>([]);
  const [previewTotalLayers, setPreviewTotalLayers] = useState(0);
  const [previewSelectedLayer, setPreviewSelectedLayer] = useState(1);
  const [lastBenchmark, setLastBenchmark] = useState<SliceBenchmarkSnapshot | null>(null);
  const [lastWasmError, setLastWasmError] = useState<string | null>(null);
  const [lifetimeTelemetry, setLifetimeTelemetry] = useState<LifetimeTelemetry>({
    runCount: 0,
    totalElapsedMs: 0,
    totalRasterMs: 0,
    lastElapsedMs: null,
    lastRasterMs: null,
    lastBackend: null,
  });
  const slicingAbortControllerRef = useRef<AbortController | null>(null);

  const profileState = React.useSyncExternalStore(subscribeToProfileStore, getProfileStoreSnapshot, getProfileStoreServerSnapshot);
  const activePrinterProfile = useMemo(() => getActivePrinterProfile(profileState), [profileState]);
  const activeMaterialProfile = useMemo(() => getActiveMaterialProfile(profileState), [profileState]);
  const activeOutputFormat = activePrinterProfile?.display.outputFormat ?? null;

  const selectedFormat = useMemo(() => {
    if (!activePrinterProfile || !activeMaterialProfile) return null;
    return resolveSlicingFormatDefinition({
      printerProfile: activePrinterProfile,
      materialProfile: activeMaterialProfile,
    });
  }, [activeMaterialProfile, activePrinterProfile]);

  const pipelineContainerBackendLabel = useMemo(() => {
    if (!selectedFormat) return '—';
    if (selectedFormat.outputFormat !== '.nanodlp') return 'JS prototype ZIP writer';
    if (wasmStatus === 'available') return 'WASM NanoDLP container encoder';
    if (wasmStatus === 'checking') return 'Checking WASM availability…';
    return 'JS fallback ZIP writer';
  }, [selectedFormat, wasmStatus]);

  const pipelineRasterizerLabel = useMemo(() => {
    if (!selectedFormat) return '—';
    if (selectedFormat.outputFormat === '.nanodlp' && wasmStatus === 'available') {
      return 'WASM solid cross-section slicer';
    }
    return 'JS Canvas triangle rasterizer';
  }, [selectedFormat, wasmStatus]);

  const backendNote = useMemo(() => {
    if (lifetimeTelemetry.lastBackend === 'wasm-nanodlp') {
      return 'NanoDLP slicing + container packaging are running in WASM.';
    }
    return 'Fallback ZIP uses JS solid cross-section slicing (not shell projection).';
  }, [lifetimeTelemetry.lastBackend]);

  const progressPercent = useMemo(() => {
    const total = Math.max(1, progressTotal);
    return Math.max(0, Math.min(100, Math.round((progressDone / total) * 100)));
  }, [progressDone, progressTotal]);

  const slicingElapsedLabel = useMemo(() => formatElapsedClock(currentElapsedMs), [currentElapsedMs]);

  useEffect(() => {
    if (!showSlicingModal) {
      setDisplayProgressPercent(0);
      return;
    }

    let rafId = 0;
    let mounted = true;

    const animate = () => {
      if (!mounted) return;
      setDisplayProgressPercent((prev) => {
        const target = progressPercent;
        if (Math.abs(target - prev) < 0.2) return target;
        return prev + ((target - prev) * 0.16);
      });
      rafId = window.requestAnimationFrame(animate);
    };

    rafId = window.requestAnimationFrame(animate);
    return () => {
      mounted = false;
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, [progressPercent, showSlicingModal]);

  useEffect(() => {
    if (!activeModel) return;
    setFilename(normalizeExportBaseName(activeModel.name));
  }, [activeModel]);

  const clearLayerPreviewUrls = useCallback(() => {
    setLayerPreviewUrls((previous) => {
      for (const url of previous) {
        if (url) URL.revokeObjectURL(url);
      }
      return [];
    });
  }, []);

  useEffect(() => {
    return () => {
      slicingAbortControllerRef.current?.abort();
      clearLayerPreviewUrls();
    };
  }, [clearLayerPreviewUrls]);

  useEffect(() => {
    if (!isSlicingZip) {
      setCurrentElapsedMs(0);
      return;
    }

    const runStart = performance.now();
    const id = window.setInterval(() => {
      setCurrentElapsedMs(performance.now() - runStart);
    }, 120);

    return () => {
      window.clearInterval(id);
    };
  }, [isSlicingZip]);

  useEffect(() => {
    if (activeOutputFormat !== '.nanodlp') {
      setWasmStatus('n/a');
      return;
    }

    let cancelled = false;
    setWasmStatus('checking');
    void isSlicerWasmAvailable()
      .then((available) => {
        if (cancelled) return;
        setWasmStatus(available ? 'available' : 'missing');
      })
      .catch(() => {
        if (cancelled) return;
        setWasmStatus('missing');
      });

    return () => {
      cancelled = true;
    };
  }, [activeOutputFormat]);

  const handleSliceZipExport = async () => {
    if (!activePrinterProfile) {
      alert('Select a printer profile first.');
      return;
    }

    if (!activeMaterialProfile) {
      alert('Select a material profile first.');
      return;
    }

    const visibleModels = models.filter((model) => model.visible);
    if (visibleModels.length === 0) {
      alert('No visible models available for slicing.');
      return;
    }

    setIsSlicingZip(true);
    setCurrentPhase('Preparing slicer…');
    setSliceStatus('Preparing slicer…');
    setProgressDone(0);
    setProgressTotal(1);
    setCurrentElapsedMs(0);
    setCurrentRasterMs(0);
    setShowSlicingModal(true);
    setSlicingModalStage('running');
    clearLayerPreviewUrls();
    setPreviewTotalLayers(0);
    setPreviewSelectedLayer(1);

    const runStartMs = performance.now();
    const abortController = new AbortController();
    slicingAbortControllerRef.current = abortController;
    let rasterStartedMs: number | null = null;
    let rasterAccumulatedMs = 0;
    let exportThumbnailPng: Uint8Array | null = null;
    let completedTotalLayers = 0;
    let slicingSucceeded = false;
    let completedTotalLayersFromResult = 0;

    try {
      if (captureSceneThumbnailPng) {
        try {
          exportThumbnailPng = await captureSceneThumbnailPng();
        } catch (thumbnailError) {
          console.warn('[Slicing] Scene thumbnail capture failed, continuing with layer preview fallback.', thumbnailError);
        }
      }

      const result = await runSliceExportOrchestrator({
        models: visibleModels,
        printerProfile: activePrinterProfile,
        materialProfile: activeMaterialProfile,
        filenameBase: filename || activePrinterProfile.name || 'slice_export',
        outputMode: 'return',
        exportThumbnailPng,
        abortSignal: abortController.signal,
        onProgress: (done, total, phase) => {
          setCurrentPhase(phase);
          setSliceStatus(`${phase} ${formatProgressLayerLabel(done, total)}`);
          setProgressDone(done);
          setProgressTotal(Math.max(1, total));

          const phaseLower = phase.toLowerCase();
          const nowMs = performance.now();
          const isRasterPhase = phaseLower.includes('raster');

          if (isRasterPhase) {
            if (rasterStartedMs == null) {
              rasterStartedMs = nowMs;
            }
            setCurrentRasterMs(rasterAccumulatedMs + (nowMs - rasterStartedMs));
          } else if (rasterStartedMs != null) {
            rasterAccumulatedMs += nowMs - rasterStartedMs;
            rasterStartedMs = null;
            setCurrentRasterMs(rasterAccumulatedMs);
          }
        },
        onLayerPreview: (layerIndex, totalLayers, pngBytes) => {
          completedTotalLayers = Math.max(completedTotalLayers, totalLayers);
          onLayerPreviewGenerated?.({
            layerIndex,
            totalLayers,
            pngBytes,
          });
          const blobBytes = Uint8Array.from(pngBytes);
          const blob = new Blob([blobBytes.buffer], { type: 'image/png' });
          const nextUrl = URL.createObjectURL(blob);
          setLayerPreviewUrls((previous) => {
            const next = previous.slice();
            const requiredLength = Math.max(totalLayers, layerIndex + 1);
            if (next.length < requiredLength) {
              next.length = requiredLength;
            }
            const prevUrl = next[layerIndex];
            if (prevUrl) URL.revokeObjectURL(prevUrl);
            next[layerIndex] = nextUrl;
            return next;
          });
          setPreviewTotalLayers(totalLayers);
          setPreviewSelectedLayer((previousLayer) => {
            if (!Number.isFinite(previousLayer) || previousLayer <= 0) {
              return Math.max(1, Math.min(totalLayers, layerIndex + 1));
            }
            return Math.max(1, Math.min(totalLayers, previousLayer));
          });
        },
      });

      const runEndMs = performance.now();
      completedTotalLayersFromResult = Math.max(completedTotalLayersFromResult, result.benchmark.totalLayers ?? 0);
      if (rasterStartedMs != null) {
        rasterAccumulatedMs += runEndMs - rasterStartedMs;
      }

      const elapsedMs = runEndMs - runStartMs;
      const benchmarkTotalMs = result.benchmark.totalElapsedMs;
      const benchmarkCoreMs = result.benchmark.coreSlicingMs;
      setCurrentElapsedMs(benchmarkTotalMs);
      setCurrentRasterMs(benchmarkCoreMs ?? rasterAccumulatedMs);
      setLastBenchmark(result.benchmark);
      setLastWasmError(result.wasmError);

      const effectiveElapsedMs = benchmarkTotalMs || elapsedMs;
      const effectiveCoreMs = benchmarkCoreMs ?? rasterAccumulatedMs;

      setLifetimeTelemetry((prev) => ({
        runCount: prev.runCount + 1,
        totalElapsedMs: prev.totalElapsedMs + effectiveElapsedMs,
        totalRasterMs: prev.totalRasterMs + effectiveCoreMs,
        lastElapsedMs: effectiveElapsedMs,
        lastRasterMs: effectiveCoreMs,
        lastBackend: result.backend,
      }));

      if (result.backend === 'wasm-nanodlp') {
        setSliceStatus('Generated .nanodlp via WASM encoder.');
      } else if (result.outputFormat === '.nanodlp') {
        setSliceStatus(result.wasmAvailable
          ? `WASM failed (${result.wasmError ?? 'unknown error'}), used fallback solid ZIP.`
          : 'WASM not found, used fallback solid ZIP.');
      } else {
        setSliceStatus('Slice ZIP generated.');
      }
      setSlicingModalStage('finished');
      slicingSucceeded = true;
      if (result.artifact) {
        onSliceArtifactReady?.(result.artifact);
      }
    } catch (error) {
      if ((error as { name?: string } | null)?.name === 'AbortError') {
        setCurrentPhase('Cancelled');
        setSliceStatus('Slicing cancelled by user.');
        setSlicingModalStage('cancelled');
      } else {
        console.error('Slice ZIP export failed:', error);
        const message = error instanceof Error ? error.message : 'Unknown slicing error.';
        setCurrentPhase('Failed');
        setSliceStatus(`Failed: ${message}`);
        setSlicingModalStage('failed');
        alert(`Slice ZIP export failed: ${message}`);
      }
    } finally {
      if (slicingAbortControllerRef.current === abortController) {
        slicingAbortControllerRef.current = null;
      }
      setIsSlicingZip(false);
      if (slicingSucceeded) {
        onSlicingFinished?.({ totalLayers: Math.max(completedTotalLayers, completedTotalLayersFromResult, 1) });
      }
    }
  };

  const handleCancelSlicing = useCallback(() => {
    if (!isSlicingZip) return;
    setCurrentPhase('Cancelling…');
    setSliceStatus('Cancelling slicing job…');
    slicingAbortControllerRef.current?.abort();
  }, [isSlicingZip]);

  const selectedLayerPreviewUrl = useMemo(() => {
    if (previewSelectedLayer < 1) return null;
    return layerPreviewUrls[previewSelectedLayer - 1] ?? null;
  }, [layerPreviewUrls, previewSelectedLayer]);

  const handleCloseSlicingModal = useCallback(() => {
    setShowSlicingModal(false);
    clearLayerPreviewUrls();
    setPreviewTotalLayers(0);
    setPreviewSelectedLayer(1);
  }, [clearLayerPreviewUrls]);

  if (models.length === 0) {
    return (
      <Card className="w-72">
        <CardHeader
          left={(
            <>
              <IconButton
                onClick={() => setIsExpanded((prev) => !prev)}
                className="!p-0.5"
                title={isExpanded ? 'Collapse card' : 'Expand card'}
              >
                <svg
                  className="w-3 h-3 transform transition-transform"
                  style={{ color: isExpanded ? 'var(--accent)' : 'var(--text-muted)' }}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  {isExpanded ? (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  ) : (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  )}
                </svg>
              </IconButton>
              <h2 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Slicing</h2>
            </>
          )}
          hideDivider={!isExpanded}
        />
        {isExpanded && (
          <div className="px-3 pb-3 text-xs" style={{ color: 'var(--text-muted)' }}>
            No meshes loaded yet. Import a model first, then return to Slicing.
          </div>
        )}
      </Card>
    );
  }

  return (
    <Card className="w-72">
      <CardHeader
        left={(
          <>
            <IconButton
              onClick={() => setIsExpanded((prev) => !prev)}
              className="!p-0.5"
              title={isExpanded ? 'Collapse card' : 'Expand card'}
            >
              <svg
                className="w-3 h-3 transform transition-transform"
                style={{ color: isExpanded ? 'var(--accent)' : 'var(--text-muted)' }}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                {isExpanded ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                )}
              </svg>
            </IconButton>
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Slicing</h2>
          </>
        )}
        hideDivider={!isExpanded}
      />

      {isExpanded && (
        <div className="px-3 pt-2 pb-3 space-y-2.5">
          <div className="rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
              <Layers3 className="w-3.5 h-3.5" />
              <span>Job Setup</span>
            </div>

            <div className="space-y-0.5">
              <label className="text-xs" style={{ color: 'var(--text-muted)' }}>Filename</label>
              <Input
                type="text"
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                className="w-full !h-9 text-sm"
                placeholder="my_print"
              />
            </div>

            <div className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Visible models: {models.filter((model) => model.visible).length}
            </div>
          </div>

          <div className="rounded-md border p-2 space-y-1.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
              <Gauge className="w-3.5 h-3.5" />
              <span>Lifetime Preview</span>
            </div>

            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Format: {selectedFormat?.displayName ?? 'No format selected'}
            </div>
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Output: {selectedFormat?.outputFormat ?? '—'}
            </div>
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Printer: {activePrinterProfile?.name ?? 'No printer'}
            </div>
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Material: {activeMaterialProfile?.name ?? 'No material'}
            </div>
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              WASM: {wasmStatus === 'available'
                ? 'Available'
                : wasmStatus === 'checking'
                  ? 'Checking…'
                  : wasmStatus === 'missing'
                    ? 'Missing (fallback active)'
                    : 'Not required'}
            </div>
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Backend: {lifetimeTelemetry.lastBackend ?? '—'}
            </div>
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Rasterizer: {pipelineRasterizerLabel}
            </div>
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Container: {pipelineContainerBackendLabel}
            </div>
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Last throughput: {formatLayerRate(lastBenchmark?.layersPerSecond ?? null)}
            </div>

            <div className="mt-1.5 grid grid-cols-2 gap-1.5">
              <div className="rounded border px-1.5 py-1" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Current</div>
                <div className="text-[11px]" style={{ color: 'var(--text-strong)' }}>{formatDuration(currentElapsedMs)}</div>
              </div>
              <div className="rounded border px-1.5 py-1" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Raster</div>
                <div className="text-[11px]" style={{ color: 'var(--text-strong)' }}>{formatDuration(currentRasterMs)}</div>
              </div>
              <div className="rounded border px-1.5 py-1" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Last Job</div>
                <div className="text-[11px]" style={{ color: 'var(--text-strong)' }}>{formatDuration(lifetimeTelemetry.lastElapsedMs)}</div>
              </div>
              <div className="rounded border px-1.5 py-1" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Last Raster</div>
                <div className="text-[11px]" style={{ color: 'var(--text-strong)' }}>{formatDuration(lifetimeTelemetry.lastRasterMs)}</div>
              </div>
            </div>

            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Runs: {lifetimeTelemetry.runCount} • Total: {formatDuration(lifetimeTelemetry.totalElapsedMs)} • Raster total: {formatDuration(lifetimeTelemetry.totalRasterMs)}
            </div>

            <div className="mt-1.5 rounded border px-1.5 py-1 space-y-0.5" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>Last Benchmark</div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Layers: {lastBenchmark?.totalLayers ?? '—'}
              </div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Mesh prep: {formatDuration(lastBenchmark?.meshPrepMs ?? null)}
              </div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Core slicing: {formatDuration(lastBenchmark?.coreSlicingMs ?? null)}
              </div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                End-to-end: {formatDuration(lastBenchmark?.totalElapsedMs ?? null)}
              </div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Throughput: {formatLayerRate(lastBenchmark?.layersPerSecond ?? null)}
              </div>
            </div>
          </div>

          <div className="rounded-md border p-2 space-y-1.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
              <Timer className="w-3.5 h-3.5" />
              <span>Live Telemetry</span>
            </div>
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Phase: {currentPhase}</div>
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{sliceStatus}</div>
            {lastWasmError && (
              <div className="text-[11px]" style={{ color: 'var(--status-warning, #f59e0b)' }}>
                Last WASM error: {lastWasmError}
              </div>
            )}
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Note: {backendNote}
            </div>
          </div>

          <Button
            onClick={handleSliceZipExport}
            disabled={isSlicingZip || !activePrinterProfile || !activeMaterialProfile || models.length === 0}
            variant="secondary"
            className={`w-full !h-9 text-sm inline-flex items-center justify-center gap-1.5 ${isSlicingZip ? 'cursor-wait opacity-70' : ''}`}
          >
            <Cpu className="w-4 h-4" />
            {isSlicingZip ? 'Slicing…' : 'Run Slicing Job'}
          </Button>
        </div>
      )}

      {showSlicingModal && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3">
          <div
            className="w-full max-w-lg overflow-hidden rounded-xl border shadow-2xl"
            style={{
              background: 'var(--surface-0)',
              borderColor: 'var(--border-subtle)',
              boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
            }}
            role="dialog"
            aria-modal="true"
            aria-label="Slicing progress"
          >
            <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="flex items-center gap-2.5 min-w-0">
                <span
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    background: 'color-mix(in srgb, var(--accent), var(--surface-1) 90%)',
                    color: 'var(--accent)',
                  }}
                >
                  <Layers3 className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    Background Pipeline
                  </div>
                  <h2 className="text-base font-semibold" style={{ color: 'var(--text-strong)' }}>
                    Slicing Plate
                  </h2>
                </div>
              </div>
              <div
                className="rounded-md border px-2.5 py-1 text-[11px] font-medium"
                style={{
                  borderColor: slicingModalStage === 'failed'
                    ? 'color-mix(in srgb, #ef4444, var(--border-subtle) 45%)'
                    : slicingModalStage === 'cancelled'
                      ? 'color-mix(in srgb, #f59e0b, var(--border-subtle) 45%)'
                    : slicingModalStage === 'finished'
                      ? 'color-mix(in srgb, #22c55e, var(--border-subtle) 45%)'
                      : 'color-mix(in srgb, var(--accent), var(--border-subtle) 45%)',
                  color: slicingModalStage === 'failed'
                    ? '#fca5a5'
                    : slicingModalStage === 'cancelled'
                      ? '#fcd34d'
                    : slicingModalStage === 'finished'
                      ? '#86efac'
                      : 'var(--text-strong)',
                  background: 'var(--surface-1)',
                }}
              >
                {slicingModalStage === 'running'
                  ? 'Running'
                  : slicingModalStage === 'finished'
                    ? 'Ready'
                    : slicingModalStage === 'cancelled'
                      ? 'Cancelled'
                    : 'Failed'}
              </div>
            </div>

            <div className="p-4 space-y-3">
              <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                {sliceStatus}
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                  <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Sliced Layers</div>
                  <div className="text-sm font-semibold tabular-nums" style={{ color: 'var(--text-strong)' }}>
                    {formatProgressLayerLabel(progressDone, progressTotal)}
                  </div>
                </div>
                <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                  <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Progress</div>
                  <div className="text-sm font-semibold tabular-nums" style={{ color: 'var(--text-strong)' }}>{Math.round(displayProgressPercent)}%</div>
                </div>
              </div>

              {slicingModalStage === 'finished' && previewTotalLayers > 0 && (
                <div className="rounded-lg border p-2.5 space-y-1.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    Plate preview · Layer {previewSelectedLayer}/{previewTotalLayers}
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={Math.max(1, previewTotalLayers)}
                    step={1}
                    value={Math.max(1, Math.min(previewTotalLayers || 1, previewSelectedLayer))}
                    onChange={(event) => setPreviewSelectedLayer(Number(event.target.value))}
                    className="w-full"
                  />
                  {selectedLayerPreviewUrl ? (
                    <img
                      src={selectedLayerPreviewUrl}
                      alt={`Layer ${previewSelectedLayer} preview`}
                      className="w-full h-36 rounded object-contain"
                    />
                  ) : (
                    <div className="h-36 rounded border border-dashed flex items-center justify-center text-[11px]" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}>
                      Preview for this layer is not available.
                    </div>
                  )}
                </div>
              )}

              <div className="h-2.5 rounded overflow-hidden" style={{ background: 'var(--surface-2)' }}>
                <div
                  className="h-full transition-all duration-200"
                  style={{ width: `${Math.round(displayProgressPercent)}%`, background: 'linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent), #ffffff 28%))' }}
                />
              </div>

              <div className="pt-1 flex items-center justify-between gap-3">
                <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  <Timer className="h-3.5 w-3.5" />
                  <span>Elapsed {slicingElapsedLabel}</span>
                </div>

                <div className="flex items-center gap-2">
                  {slicingModalStage === 'running' && (
                    <Button
                      variant="secondary"
                      className="!h-9 text-xs"
                      onClick={handleCancelSlicing}
                    >
                      Cancel Slicing
                    </Button>
                  )}
                  {slicingModalStage !== 'running' && (
                    <Button
                      variant="secondary"
                      className="!h-9 text-xs"
                      onClick={handleCloseSlicingModal}
                    >
                      Close Plate
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

export default SlicingPanel;