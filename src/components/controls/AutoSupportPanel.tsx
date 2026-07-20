"use client";

import React from 'react';
import { Settings } from 'lucide-react';
import { Card, CardHeader, IconButton, Button } from '@/components/atoms';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';
import { useFloatingPanelCollapse } from '@/components/layout/FloatingPanelStack';
import type { UseIslandsReturn } from '@/volumeAnalysis/Islands/useIslands';
import { runAutoPlace } from '@/supports/autoSupport';
import { getSettings, updateAutoSupportSettings } from '@/supports/Settings/state';

/** Set to true while auto-support is busy (scanning or placing).
 *  Page-level overlay reads this to show the "Generating Supports"
 *  full-screen modal, matching the native island-scan modal style. */
let _autoSupportBusy = false;
const _busyListeners = new Set<() => void>();

export function getAutoSupportBusy(): boolean { return _autoSupportBusy; }
export function subscribeAutoSupportBusy(fn: () => void): () => void {
  _busyListeners.add(fn);
  return () => _busyListeners.delete(fn);
}
function setAutoSupportBusy(v: boolean) {
  if (_autoSupportBusy !== v) {
    _autoSupportBusy = v;
    for (const fn of _busyListeners) fn();
  }
}

/** Set to true while auto-support is driving its own scan, so the
 *  native island-scan overlay can be suppressed. */
export let autoSupportDrivingScan = false;

const SECTION_CARD: React.CSSProperties = {
  borderColor: 'var(--border-subtle)',
  background: 'var(--surface-1)',
};

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-center" style={{ color: 'var(--text-strong)' }}>
      {title}
    </div>
  );
}

interface AutoSupportPanelProps {
  islands: UseIslandsReturn;
  hasGeometry: boolean;
  activeModelId?: string;
}

type KnobDef = {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  hint: string;
};

const KNOBS: KnobDef[] = [
  { key: 'minIslandAreaMm2',     label: 'Min Island Area',       min: 0.01, max: 2,    step: 0.01, unit: 'mm²', hint: 'Skip islands smaller than this area' },
  { key: 'tipInfluenceRadiusMm',  label: 'Tip Influence Radius',  min: 0.1,  max: 10,   step: 0.1,  unit: 'mm',  hint: 'Candidates within this distance are merged' },
  { key: 'clusterRadiusMm',       label: 'Cluster Radius',        min: 5,    max: 40,   step: 0.5,  unit: 'mm',  hint: 'Max XY distance for grouping into a tree cluster' },
  { key: 'maxBranchReachMm',      label: 'Max Branch Reach',      min: 5,    max: 40,   step: 0.5,  unit: 'mm',  hint: 'Furthest a branch can fan out from its core trunk' },
  { key: 'maxBranchAngleDeg',     label: 'Max Branch Angle',      min: 20,   max: 60,   step: 1,    unit: '°',   hint: 'Steepest angle a branch can leave the trunk' },
  { key: 'minTrunkSeparationMm',  label: 'Min Trunk Separation',  min: 3,    max: 30,   step: 0.5,  unit: 'mm',  hint: 'Minimum XY distance between independent trunks' },
  { key: 'densityFactor',         label: 'Density Factor',        min: 0.5,  max: 3,    step: 0.1,  unit: '×',   hint: 'Scaling multiplier for overall support density' },
];

export function AutoSupportPanel({ islands, hasGeometry, activeModelId }: AutoSupportPanelProps) {
  const [expanded, setExpanded] = useFloatingPanelCollapse(true);
  const [busy, setBusy] = React.useState(false);
  const [showSettings, setShowSettings] = React.useState(false);

  const settings = getSettings().autoSupport;
  const [draft, setDraft] = React.useState(settings);

  const openSettings = React.useCallback(() => {
    setDraft(getSettings().autoSupport);
    setShowSettings(true);
  }, []);

  const applySettings = React.useCallback(() => {
    updateAutoSupportSettings(draft);
    setShowSettings(false);
  }, [draft]);

  const pendingRef = React.useRef(false);

  // When scanning finishes after an auto-support trigger, run auto-support.
  React.useEffect(() => {
    if (!pendingRef.current || islands.scanning) return;
    pendingRef.current = false;
    autoSupportDrivingScan = false;
    const s = getSettings();
    const list = islands.filteredIslands;
    if (list.length > 0 && s.autoSupport.enabled) {
      try {
        runAutoPlace(list, activeModelId!, s.autoSupport);
      } finally {
        setAutoSupportBusy(false);
        setBusy(false);
      }
    } else {
      setAutoSupportBusy(false);
      setBusy(false);
    }
  }, [islands.scanning, islands.filteredIslands, activeModelId]);

  const handleRun = React.useCallback(() => {
    if (!activeModelId || busy) return;
    const s = getSettings();
    const list = islands.filteredIslands;
    // Need to scan first?
    if (list.length === 0 && islands.voxelIslands.length === 0 && islands.minimaIslands.length === 0) {
      setBusy(true);
      setAutoSupportBusy(true);
      pendingRef.current = true;
      autoSupportDrivingScan = true;
      void islands.onRunScan();
      return;
    }
    // Already have data — show modal, then run.
    if (list.length > 0 && s.autoSupport.enabled) {
      setBusy(true);
      setAutoSupportBusy(true);
      // Yield to let React render the modal before blocking work.
      setTimeout(() => {
        try {
          runAutoPlace(list, activeModelId, s.autoSupport);
        } finally {
          setAutoSupportBusy(false);
          setBusy(false);
        }
      }, 50);
    }
  }, [activeModelId, busy, islands.filteredIslands, islands.voxelIslands.length, islands.minimaIslands.length]);

  const canRun = hasGeometry && !!activeModelId && !busy && !islands.scanning;

  return (
    <>
      <Card>
        <CardHeader
          left={(
            <>
              <IconButton
                onClick={() => setExpanded(!expanded)}
                className="!p-0.5"
                title={expanded ? 'Collapse card' : 'Expand card'}
              >
                <svg className="w-3 h-3 transform transition-transform"
                  style={{ color: expanded ? 'var(--accent)' : 'var(--text-muted)' }}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24"
                >
                  {expanded ? (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  ) : (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  )}
                </svg>
              </IconButton>
              <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Auto Supports (Beta)</h3>
            </>
          )}
          right={(
            <IconButton onClick={openSettings} className="!p-1.5" title="Auto-support settings">
              <Settings className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />
            </IconButton>
          )}
          hideDivider={!expanded}
        />


        {expanded && (
          <div className="px-2.5 pb-3 space-y-2.5">
            {/* Run button — always at top */}
            <button
              type="button"
              onClick={() => { void handleRun(); }}
              disabled={!canRun}
              className="ui-button w-full !h-8 text-[11px] disabled:opacity-50"
              style={{
                borderColor: 'var(--accent)',
                background: 'color-mix(in srgb, var(--accent), var(--surface-0) 86%)',
                color: 'var(--accent)',
              }}
            >
              {busy ? 'Running…' : 'Run Auto-Supports'}
            </button>

            {/* Island counts */}
            <div className="rounded-md border p-2" style={SECTION_CARD}>
              <div className="grid grid-cols-3 gap-2 text-center">
                {([
                  { label: 'Voxel', count: islands.voxelIslands.length },
                  { label: 'Minima', count: islands.minimaIslands.length },
                  { label: 'Total', count: islands.filteredIslands.length },
                ]).map((s) => (
                  <div key={s.label}>
                    <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{s.label}</div>
                    <div className="text-sm font-bold" style={{ color: s.label === 'Total' ? 'var(--accent)' : 'var(--text-strong)' }}>
                      {islands.scanning ? '…' : s.count}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {!hasGeometry && (
              <div className="text-[10px] italic text-center" style={{ color: 'var(--text-muted)' }}>
                Load a model and scan for islands.
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Settings Modal */}
      <StructuredDialogModal
        open={showSettings}
        ariaLabel="Auto-support settings"
        title="Auto Supports (Beta) Settings"
        subtitle="Tune candidate generation, clustering, and fan-out"
        iconTone="neutral"
        onClose={() => setShowSettings(false)}
        onBackdropClick={() => setShowSettings(false)}
        actions={
          <>
            <Button onClick={() => setShowSettings(false)} variant="secondary" size="sm" className="!h-9 text-[12px]">Cancel</Button>
            <Button onClick={applySettings} variant="primary" size="sm" className="!h-9 text-[12px]">Apply</Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="rounded-md border p-2.5" style={SECTION_CARD}>
            <SectionHeader title="General" />
            <div className="grid grid-cols-2 gap-2">
              {([
                { key: 'enabled' as const, label: 'Enabled', hint: 'Enable auto-support placement' },
                { key: 'prioritizeIntersection' as const, label: 'Prioritize Dual-Detect', hint: '1.5× priority for islands confirmed by both detectors' },
              ]).map((t) => (
                <button key={t.key} type="button"
                  onClick={() => setDraft((d) => ({ ...d, [t.key]: !d[t.key] }))}
                  className="min-h-[36px] w-full rounded-md border px-2 text-[11px] font-semibold uppercase tracking-wide transition-colors flex items-center justify-center gap-1.5"
                  style={(draft as any)[t.key]
                    ? { borderColor: 'color-mix(in srgb, var(--accent-secondary), white 10%)', background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 84%)', color: 'color-mix(in srgb, var(--accent-secondary), var(--text-strong) 25%)' }
                    : { borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
                  title={t.hint}
                >{t.label}</button>
              ))}
            </div>
          </div>

          <div className="rounded-md border p-2.5" style={SECTION_CARD}>
            <SectionHeader title="Debug" />
            <div className="grid grid-cols-2 gap-2">
              {([
                { key: 'debugSkipAutoBracing' as const, label: 'Skip Auto-Brace', hint: 'Skip auto-bracing after placement' },
                { key: 'debugClusterColorsEnabled' as const, label: 'Cluster Colors', hint: 'Color-code supports by cluster group' },
              ]).map((t) => (
                <button key={t.key} type="button"
                  onClick={() => setDraft((d) => ({ ...d, [t.key]: !(d as any)[t.key] }))}
                  className="min-h-[36px] w-full rounded-md border px-2 text-[11px] font-semibold uppercase tracking-wide transition-colors flex items-center justify-center gap-1.5"
                  style={(draft as any)[t.key]
                    ? { borderColor: 'color-mix(in srgb, var(--accent-secondary), white 10%)', background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 84%)', color: 'color-mix(in srgb, var(--accent-secondary), var(--text-strong) 25%)' }
                    : { borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
                  title={t.hint}
                >{t.label}</button>
              ))}
            </div>
          </div>

          <div className="rounded-md border p-2.5" style={SECTION_CARD}>
            <SectionHeader title="Placement" />
            <div className="space-y-3">
              {KNOBS.map((knob) => {
                const value = (draft as any)[knob.key] as number;
                return (
                  <div key={knob.key}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }} title={knob.hint}>{knob.label}</span>
                      <span className="text-[11px] tabular-nums font-semibold" style={{ color: 'var(--text-strong)' }}>{knob.step < 1 ? value.toFixed(1) : value}{knob.unit}</span>
                    </div>
                    <input type="range" min={knob.min} max={knob.max} step={knob.step} value={value}
                      onChange={(e) => setDraft((d) => ({ ...d, [knob.key]: parseFloat(e.target.value) }))}
                      className="ui-range w-full"
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </StructuredDialogModal>
    </>
  );
}
