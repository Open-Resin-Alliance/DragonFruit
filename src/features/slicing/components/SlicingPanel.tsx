import React, { useEffect, useMemo, useState } from 'react';
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
import { runSliceExportOrchestrator } from '@/features/slicing/sliceExportOrchestrator';
import { isSlicerWasmAvailable } from '@/features/slicing/wasm/slicerWasmBridge';
import { resolveSlicingFormatDefinition } from '@/features/slicing/formats/registry';

interface SlicingPanelProps {
  models: LoadedModel[];
  activeModel: LoadedModel | null;
}

type LifetimeTelemetry = {
  runCount: number;
  totalElapsedMs: number;
  totalRasterMs: number;
  lastElapsedMs: number | null;
  lastRasterMs: number | null;
  lastBackend: 'wasm-nanodlp' | 'js-raster-zip' | null;
};

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

export function SlicingPanel({ models, activeModel }: SlicingPanelProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [filename, setFilename] = useState(() => normalizeExportBaseName(activeModel?.name));
  const [isSlicingZip, setIsSlicingZip] = useState(false);
  const [sliceStatus, setSliceStatus] = useState('Idle');
  const [wasmStatus, setWasmStatus] = useState<'n/a' | 'checking' | 'available' | 'missing'>('n/a');
  const [currentPhase, setCurrentPhase] = useState('Idle');
  const [currentElapsedMs, setCurrentElapsedMs] = useState(0);
  const [currentRasterMs, setCurrentRasterMs] = useState(0);
  const [lifetimeTelemetry, setLifetimeTelemetry] = useState<LifetimeTelemetry>({
    runCount: 0,
    totalElapsedMs: 0,
    totalRasterMs: 0,
    lastElapsedMs: null,
    lastRasterMs: null,
    lastBackend: null,
  });

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

  useEffect(() => {
    if (!activeModel) return;
    setFilename(normalizeExportBaseName(activeModel.name));
  }, [activeModel]);

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
    setCurrentElapsedMs(0);
    setCurrentRasterMs(0);

    const runStartMs = performance.now();
    let rasterStartedMs: number | null = null;
    let rasterAccumulatedMs = 0;

    try {
      const result = await runSliceExportOrchestrator({
        models: visibleModels,
        printerProfile: activePrinterProfile,
        materialProfile: activeMaterialProfile,
        filenameBase: filename || activePrinterProfile.name || 'slice_export',
        onProgress: (done, total, phase) => {
          setCurrentPhase(phase);
          setSliceStatus(`${phase} ${done}/${total}`);

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
      });

      const runEndMs = performance.now();
      if (rasterStartedMs != null) {
        rasterAccumulatedMs += runEndMs - rasterStartedMs;
      }

      const elapsedMs = runEndMs - runStartMs;
      setCurrentElapsedMs(elapsedMs);
      setCurrentRasterMs(rasterAccumulatedMs);
      setLifetimeTelemetry((prev) => ({
        runCount: prev.runCount + 1,
        totalElapsedMs: prev.totalElapsedMs + elapsedMs,
        totalRasterMs: prev.totalRasterMs + rasterAccumulatedMs,
        lastElapsedMs: elapsedMs,
        lastRasterMs: rasterAccumulatedMs,
        lastBackend: result.backend,
      }));

      if (result.backend === 'wasm-nanodlp') {
        setSliceStatus('Generated .nanodlp via WASM encoder.');
      } else if (result.outputFormat === '.nanodlp') {
        setSliceStatus(result.wasmAvailable
          ? 'WASM failed, used fallback ZIP prototype.'
          : 'WASM not found, used fallback ZIP prototype.');
      } else {
        setSliceStatus('Slice ZIP generated.');
      }
    } catch (error) {
      console.error('Slice ZIP export failed:', error);
      const message = error instanceof Error ? error.message : 'Unknown slicing error.';
      setCurrentPhase('Failed');
      setSliceStatus(`Failed: ${message}`);
      alert(`Slice ZIP export failed: ${message}`);
    } finally {
      setIsSlicingZip(false);
    }
  };

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
          </div>

          <div className="rounded-md border p-2 space-y-1.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
              <Timer className="w-3.5 h-3.5" />
              <span>Live Telemetry</span>
            </div>
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Phase: {currentPhase}</div>
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{sliceStatus}</div>
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
    </Card>
  );
}

export default SlicingPanel;