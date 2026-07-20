"use client";

import React from 'react';
import { Settings } from 'lucide-react';
import { Card, CardHeader, IconButton, Button } from '@/components/atoms';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';
import { useFloatingPanelCollapse } from '@/components/layout/FloatingPanelStack';
import type { UseIslandsReturn } from '@/volumeAnalysis/Islands/useIslands';
import { runAutoPlace } from '@/supports/autoSupport';
import type { SizingDebugInfo, AutoSupportSettings } from '@/supports/autoSupport';
import { getSettings, updateAutoSupportSettings } from '@/supports/Settings/state';
import { getSnapshot, setSnapshot } from '@/supports/state';

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

const PRESETS = {
  light: {
    minIslandAreaMm2: 0.05, tipInfluenceRadiusMm: 2.0, clusterRadiusMm: 15,
    maxBranchReachMm: 20, maxBranchAngleDeg: 45, minTrunkSeparationMm: 8,
    densityFactor: 1.0,
  },
  medium: {
    minIslandAreaMm2: 0.02, tipInfluenceRadiusMm: 0.5, clusterRadiusMm: 20,
    maxBranchReachMm: 25, maxBranchAngleDeg: 50, minTrunkSeparationMm: 6,
    densityFactor: 1.0,
  },
  heavy: {
    minIslandAreaMm2: 0.0, tipInfluenceRadiusMm: 0.1, clusterRadiusMm: 25,
    maxBranchReachMm: 30, maxBranchAngleDeg: 55, minTrunkSeparationMm: 4,
    densityFactor: 1.5,
  },
} satisfies Record<string, Partial<AutoSupportSettings>>;

export function AutoSupportPanel({ islands, hasGeometry, activeModelId }: AutoSupportPanelProps) {
  const [expanded, setExpanded] = useFloatingPanelCollapse(true);
  const [busy, setBusy] = React.useState(false);
  const [showSettings, setShowSettings] = React.useState(false);
  const [showReplaceDialog, setShowReplaceDialog] = React.useState(false);
  const [showSizingDebug, setShowSizingDebug] = React.useState(false);
  const [sizingDebug, setSizingDebugState] = React.useState<SizingDebugInfo | null>(null);
  const [activePreset, setActivePreset] = React.useState<string | null>('medium');

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
  const islandsRef = React.useRef(islands);
  islandsRef.current = islands;

  // Deferred run: fires after React flushes state changes (scan complete
  // or snapshot clear).  Incrementing deferredRunRef triggers a re-render,
  // which gives us fresh islands.filteredIslands.
  React.useEffect(() => {
    if (!pendingRef.current) return;
    if (islands.scanning) return;
    pendingRef.current = false;
    autoSupportDrivingScan = false;
    const s = getSettings();
    const list = islands.filteredIslands;
    if (list.length > 0 && s.autoSupport.enabled) {
      try {
        const result = runAutoPlace(list, activeModelId!, s.autoSupport);
        if (result.analytics?.sizingDebug) setSizingDebugState(result.analytics.sizingDebug);
      } finally {
        setAutoSupportBusy(false);
        setBusy(false);
      }
    } else {
      setAutoSupportBusy(false);
      setBusy(false);
    }
  }, [islands.scanning, islands.filteredIslands, activeModelId]);

  const doRun = React.useCallback((replace: boolean) => {
    if (!activeModelId) return;
    if (replace) {
      const snap = getSnapshot();
      const next = {
        ...snap,
        trunks: { ...snap.trunks },
        roots: { ...snap.roots },
        branches: { ...snap.branches },
        leaves: { ...snap.leaves },
        anchors: { ...snap.anchors },
        braces: { ...snap.braces },
        knots: { ...snap.knots },
        twigs: { ...snap.twigs },
        sticks: { ...snap.sticks },
      };
      for (const id of Object.keys(snap.trunks)) {
        if (snap.trunks[id].modelId === activeModelId) {
          delete next.trunks[id];
          delete next.roots[snap.trunks[id].rootId];
        }
      }
      for (const id of Object.keys(snap.branches)) {
        if (snap.branches[id].modelId === activeModelId) delete next.branches[id];
      }
      for (const id of Object.keys(snap.leaves)) {
        if (snap.leaves[id].modelId === activeModelId) delete next.leaves[id];
      }
      for (const id of Object.keys(snap.anchors)) {
        if (snap.anchors[id].modelId === activeModelId) delete next.anchors[id];
      }
      // Clean up braces and knots (no modelId — delete all).
      for (const id of Object.keys(snap.braces)) delete next.braces[id];
      for (const id of Object.keys(snap.knots)) delete next.knots[id];
      // Clean up twigs and sticks if they reference this model.
      for (const id of Object.keys(snap.twigs)) {
        if (snap.twigs[id].modelId === activeModelId) delete next.twigs[id];
      }
      for (const id of Object.keys(snap.sticks)) {
        if (snap.sticks[id].modelId === activeModelId) delete next.sticks[id];
      }
      setSnapshot(next);
      // rAF fires after React flushes the snapshot, giving us
      // fresh islands.filteredIslands with updated supported flags.
      requestAnimationFrame(() => {
        setBusy(true);
        setAutoSupportBusy(true);
        requestAnimationFrame(() => {
          setTimeout(() => {
            try {
              const s = getSettings();
              const list = islandsRef.current.filteredIslands;
              if (list.length > 0 && s.autoSupport.enabled) {
                const result = runAutoPlace(list, activeModelId, s.autoSupport);
                if (result.analytics?.sizingDebug) setSizingDebugState(result.analytics.sizingDebug);
              }
            } finally {
              setAutoSupportBusy(false);
              setBusy(false);
            }
          }, 0);
        });
      });
      return;
    }
    setBusy(true);
    setAutoSupportBusy(true);
    const list = islands.filteredIslands;
    // Need to scan first?
    if (list.length === 0 && islands.voxelIslands.length === 0 && islands.minimaIslands.length === 0) {
      pendingRef.current = true;
      autoSupportDrivingScan = true;
      void islands.onRunScan();
      return;
    }
    // Let React flush the busy state and the browser paint the modal
    // before the heavy synchronous work blocks the main thread.
    requestAnimationFrame(() => {
      setTimeout(() => {
        try {
          const s = getSettings();
          if (list.length > 0 && s.autoSupport.enabled) {
            const result = runAutoPlace(list, activeModelId, s.autoSupport);
            if (result.analytics?.sizingDebug) setSizingDebugState(result.analytics.sizingDebug);
          }
        } finally {
          setAutoSupportBusy(false);
          setBusy(false);
        }
      }, 0);
    });
  }, [activeModelId, islands.filteredIslands, islands.voxelIslands.length, islands.minimaIslands.length]);

  const handleRun = React.useCallback(() => {
    if (!activeModelId || busy) return;
    const s = getSettings();
    const list = islands.filteredIslands;
    // Check for existing supports.
    const snap = getSnapshot();
    let hasSupports = false;
    for (const t of Object.values(snap.trunks)) {
      if (t.modelId === activeModelId) { hasSupports = true; break; }
    }
    if (!hasSupports) {
      for (const b of Object.values(snap.branches)) {
        if (b.modelId === activeModelId) { hasSupports = true; break; }
      }
    }
    if (hasSupports) {
      setShowReplaceDialog(true);
      return;
    }
    doRun(false);
  }, [activeModelId, busy, islands.filteredIslands, islands.voxelIslands.length, islands.minimaIslands.length, doRun]);

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
              {busy ? 'Running…' : 'Generate Supports'}
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

            {/* Preset quick-select */}
            <div className="rounded-md border p-2" style={SECTION_CARD}>
              <div className="grid grid-cols-3 gap-1.5">
                {(['light', 'medium', 'heavy'] as const).map((key) => (
                  <button key={key} type="button"
                    onClick={() => {
                      updateAutoSupportSettings(PRESETS[key]);
                      setActivePreset(key);
                    }}
                    className="h-8 rounded-md border text-[11px] font-semibold capitalize transition-colors"
                    style={activePreset === key
                      ? { borderColor: 'color-mix(in srgb, var(--accent), white 10%)', background: 'color-mix(in srgb, var(--accent), var(--surface-1) 84%)', color: 'var(--accent)' }
                      : { borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
                  >{key}</button>
                ))}
              </div>
            </div>

            {/* Sizing debug */}
            {sizingDebug && (
              <div className="rounded-md border" style={SECTION_CARD}>
                <button type="button" onClick={() => setShowSizingDebug(!showSizingDebug)}
                  className="w-full flex items-center justify-between px-2.5 py-2 text-[10px] font-semibold uppercase tracking-wide"
                  style={{ color: 'var(--text-muted)' }}
                >
                  <span>Sizing Debug</span>
                  <svg className="w-3 h-3 transition-transform" style={{ transform: showSizingDebug ? 'rotate(180deg)' : 'rotate(0deg)' }}
                    fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {showSizingDebug && (
                  <div className="px-2.5 pb-2 space-y-1 text-[10px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
                    <div className="flex justify-between border-t pt-1.5" style={{ borderColor: 'var(--border-subtle)' }}>
                      <span>Model volume</span><span style={{ color: 'var(--text-strong)' }}>{(sizingDebug.modelVolumeMm3 / 1000).toFixed(1)} cm³</span>
                    </div>
                    <div className="flex justify-between"><span>Est. weight</span><span style={{ color: 'var(--text-strong)' }}>{sizingDebug.estimatedWeightG.toFixed(1)} g</span></div>
                    <div className="flex justify-between"><span>Candidates</span><span style={{ color: 'var(--text-strong)' }}>{sizingDebug.totalCandidates}</span></div>
                    <div className="flex justify-between"><span>Weight / support</span><span style={{ color: 'var(--text-strong)' }}>{sizingDebug.weightPerSupportG.toFixed(2)} g</span></div>
                    <div className="flex justify-between"><span>Avg island area</span><span style={{ color: 'var(--text-strong)' }}>{sizingDebug.avgIslandAreaMm2.toFixed(2)} mm²</span></div>
                    <div className="flex justify-between"><span>Peel force (max)</span><span style={{ color: 'var(--text-strong)' }}>{sizingDebug.avgPeelForceN.toFixed(3)} N</span></div>
                    <div className="flex justify-between" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 2, marginTop: 2 }}>
                      <span>Shaft Ø range</span><span style={{ color: 'var(--text-strong)' }}>{sizingDebug.shaftDiameterRange.min.toFixed(2)}–{sizingDebug.shaftDiameterRange.max.toFixed(2)} mm</span>
                    </div>
                    <div className="flex justify-between"><span>Tip Ø range</span><span style={{ color: 'var(--text-strong)' }}>{sizingDebug.tipContactRange.min.toFixed(2)}–{sizingDebug.tipContactRange.max.toFixed(2)} mm</span></div>
                  </div>
                )}
              </div>
            )}

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

      {/* Replace / Add dialog */}
      <StructuredDialogModal
        open={showReplaceDialog}
        ariaLabel="Existing supports detected"
        title="Existing Supports Detected"
        subtitle="This model already has supports. How would you like to proceed?"
        iconTone="neutral"
        onClose={() => setShowReplaceDialog(false)}
        onBackdropClick={() => setShowReplaceDialog(false)}
        actions={
          <>
            <Button onClick={() => setShowReplaceDialog(false)} variant="secondary" size="sm" className="!h-9 text-[12px]">Cancel</Button>
            <Button onClick={() => { setShowReplaceDialog(false); doRun(false); }} variant="secondary" size="sm" className="!h-9 text-[12px]">Add to existing</Button>
            <Button onClick={() => { setShowReplaceDialog(false); doRun(true); }} variant="primary" size="sm" className="!h-9 text-[12px]">Replace all</Button>
          </>
        }
      >
        <div className="rounded-md border p-3" style={SECTION_CARD}>
          <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            You can replace all existing supports with auto-placed ones, or incorporate your existing supports and fill in the gaps.
          </p>
        </div>
      </StructuredDialogModal>
    </>
  );
}
