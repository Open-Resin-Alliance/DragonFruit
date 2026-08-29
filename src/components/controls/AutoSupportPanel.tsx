"use client";

import React from 'react';
import { Settings } from 'lucide-react';
import { Card, CardHeader, IconButton, Button } from '@/components/atoms';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';
import { useFloatingPanelCollapse } from '@/components/layout/FloatingPanelStack';
import type { UseIslandsReturn } from '@/volumeAnalysis/Islands/useIslands';
import { runAutoPlace, forestReportToText } from '@/supports/autoSupport';
import { DETAIL_PRESET, STRUCTURE_PRESET, ANCHOR_PRESET } from '@/supports/Settings/presets';
import type { SizingDebugInfo, AutoSupportSettings, ForestReport } from '@/supports/autoSupport';
import { getSettings, updateAutoSupportSettings, subscribeToSettings, updateDebugSimpleSupportRender } from '@/supports/Settings/state';
import { getSnapshot, setSnapshot } from '@/supports/state';
import { getKickstandSnapshot, setKickstandSnapshot } from '@/supports/SupportTypes/Kickstand/kickstandStore';
import type { Knot } from '@/supports/types';
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

interface AutoSupportPanelProps {
  islands: UseIslandsReturn;
  hasGeometry: boolean;
  activeModelId?: string;
}

type KnobDef = {
  key: NumericAutoSupportSettingKey;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  hint: string;
};

type NumericAutoSupportSettingKey =
  | 'minIslandAreaMm2'
  | 'tipInfluenceRadiusMm'
  | 'maxAttachmentsPerTrunk'
  | 'areaPerSupportMm2'
  | 'gridAreaThresholdMm2'
  | 'overhangSelfSupportAngleDeg'
  | 'sizeScale'
  | 'flatDensityBoost'
  | 'slopeRelaxFactor'
  | 'suctionAreaExponent'
  | 'coverageTargetPercent'
  | 'leafFanRadiusMm'
  | 'leafFanMaxAngleDeg';

const KNOBS: KnobDef[] = [
  { key: 'overhangSelfSupportAngleDeg', label: 'Self-Support Angle',  min: 20,   max: 75,  step: 5,  unit: '°',   hint: 'Surfaces flatter than this angle get supports (resin standard: 45°). Higher = fewer, mostly on the steepest parts.' },
  { key: 'minIslandAreaMm2',     label: 'Min Island Size',       min: 0.01, max: 2,    step: 0.01, unit: 'mm²', hint: 'Skip detected areas smaller than this — tiny specks rarely need supports' },
  { key: 'tipInfluenceRadiusMm',  label: 'Merge Radius',  min: 0.1,  max: 10,   step: 0.1,  unit: 'mm',  hint: 'A candidate within this 3D distance of an existing support merges into it instead of starting a new trunk' },
  { key: 'areaPerSupportMm2',     label: 'Support Density',      min: 1,    max: 30,   step: 0.5, unit: 'mm²', hint: 'Projected area each support carries — smaller = more, tighter supports (grid spacing ≈ √value)' },
  { key: 'gridAreaThresholdMm2',  label: 'Grid Threshold',       min: 5,    max: 200,  step: 5,   unit: 'mm²', hint: 'Flat regions at/above this area get a full grid; smaller regions get a single support' },
  { key: 'flatDensityBoost',      label: 'Flat Boost',           min: 0.5,  max: 1,    step: 0.05, unit: '×',   hint: 'Grid spacing on flat ceilings — lower = denser supports on anchor surfaces (0.7 = ~2× the supports)' },
  { key: 'slopeRelaxFactor',      label: 'Slope Relax',          min: 1,    max: 2,    step: 0.1,  unit: '×',   hint: 'Grid spacing on slopes at the self-support angle — higher = sparser' },
  { key: 'suctionAreaExponent',   label: 'Suction Scale',        min: 0,    max: 0.4,  step: 0.05, unit: '',   hint: 'How strongly flat density grows with region area — large shallow ceilings carry more peel. 0 = off' },
  { key: 'sizeScale',             label: 'Support Size',         min: 0.5,  max: 2,    step: 0.05, unit: '×',   hint: 'Master multiplier over the preset sizing bands — thicker or thinner everywhere' },
  { key: 'coverageTargetPercent', label: 'Coverage Target',      min: 75,   max: 100,  step: 5,   unit: '%',   hint: 'How much of each region\'s footprint the grid must cover before gap-filling stops' },
  { key: 'leafFanRadiusMm',       label: 'Fan Reach',            min: 2,    max: 15,   step: 0.5, unit: 'mm',  hint: 'Max horizontal distance a fan-out leaf may span from a trunk shaft' },
  { key: 'leafFanMaxAngleDeg',    label: 'Fan Angle',            min: 20,   max: 80,   step: 5,   unit: '°',   hint: 'Max angle from vertical for fan-out leaves' },
  { key: 'maxAttachmentsPerTrunk',         label: 'Branches per Column',   min: 2,  max: 50, step: 1,   unit: '',   hint: 'Max branches + leaves one trunk may carry before new trunks are started' },
];

const PRESETS = {
    // Quick-select applies the FULL built-in preset autoSupport block (not a
    // 4-key patch): selecting a preset deterministically reproduces the
    // built-in density AND resets any stale keys from a previously loaded or
    // persisted profile. Otherwise "medium" shown on load can differ from the
    // medium reached by round-tripping light → medium.
    light: { ...DETAIL_PRESET.settings.autoSupport },
    medium: { ...STRUCTURE_PRESET.settings.autoSupport },
    heavy: { ...ANCHOR_PRESET.settings.autoSupport },
} satisfies Record<string, Partial<AutoSupportSettings>>;

function SliderRow({ knob, draft, setDraft }: { knob: KnobDef; draft: AutoSupportSettings; setDraft: React.Dispatch<React.SetStateAction<AutoSupportSettings>> }) {
  const value = draft[knob.key];
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }} title={knob.hint}>{knob.label}</span>
        <span className="text-[11px] tabular-nums font-semibold" style={{ color: 'var(--text-strong)' }}>{value.toFixed(knob.step < 0.1 ? 2 : knob.step < 1 ? 1 : 0)}{knob.unit}</span>
      </div>
      <input type="range" min={knob.min} max={knob.max} step={knob.step} value={value}
        onChange={(e) => setDraft((d) => ({ ...d, [knob.key]: parseFloat(e.target.value) }))}
        className="ui-range w-full"
      />
    </div>
  );
}

export function AutoSupportPanel({ islands, hasGeometry, activeModelId }: AutoSupportPanelProps) {
  const [expanded, setExpanded] = useFloatingPanelCollapse(true);
  const [busy, setBusy] = React.useState(false);
  const [showSettings, setShowSettings] = React.useState(false);
  const [settingsTab, setSettingsTab] = React.useState<'detection' | 'distribution' | 'density'>('detection');
  const [showReplaceDialog, setShowReplaceDialog] = React.useState(false);
  const [showSizingDebug, setShowSizingDebug] = React.useState(false);
  const [sizingDebug, setSizingDebugState] = React.useState<SizingDebugInfo | null>(null);
  const [showForestReport, setShowForestReport] = React.useState(false);
  const [forestReport, setForestReportState] = React.useState<ForestReport | null>(null);
  // Derive the quick-select label from the ACTUAL settings on mount — the
  // loaded/persisted profile may not match the built-in medium preset, and a
  // hardcoded 'medium' would lie about what the current settings are.
  const [activePreset, setActivePreset] = React.useState<string | null>(() => {
    const current = getSettings().autoSupport;
    const matchesPreset = (block: Partial<AutoSupportSettings>): boolean => {
      for (const key of Object.keys(block) as Array<keyof AutoSupportSettings>) {
        if (current[key] !== block[key]) return false;
      }
      return true;
    };
    if (matchesPreset(DETAIL_PRESET.settings.autoSupport)) return 'light';
    if (matchesPreset(STRUCTURE_PRESET.settings.autoSupport)) return 'medium';
    if (matchesPreset(ANCHOR_PRESET.settings.autoSupport)) return 'heavy';
    return 'medium';
  });
  const debugSimpleRender = React.useSyncExternalStore(subscribeToSettings, getSettings, getSettings).debugSimpleSupportRender;

  const settings = getSettings().autoSupport;
  const [draft, setDraft] = React.useState(settings);

  const openSettings = React.useCallback(() => {
    setDraft(getSettings().autoSupport);
    setSettingsTab('detection');
    setShowSettings(true);
  }, []);

  const applySettings = React.useCallback(() => {
    updateAutoSupportSettings(draft);
    setShowSettings(false);
  }, [draft]);

  const pendingRef = React.useRef(false);
  const islandsRef = React.useRef(islands);
  islandsRef.current = islands;

  const runAutoSupports = React.useCallback((list: UseIslandsReturn['filteredIslands']) => {
    if (!activeModelId) return;
    try {
      const result = runAutoPlace(list, activeModelId, getSettings().autoSupport);
      if (result.analytics?.sizingDebug) setSizingDebugState(result.analytics.sizingDebug);
      if (result.analytics?.forestReport) setForestReportState(result.analytics.forestReport);
    } catch (e) {
      console.error('[AutoSupport] runAutoPlace failed:', e);
    }
  }, [activeModelId]);

  // Deferred run: fires after React flushes state changes (scan complete
  // or snapshot clear).  Incrementing deferredRunRef triggers a re-render,
  // which gives us fresh islands.filteredIslands.
  React.useEffect(() => {
    if (!pendingRef.current) return;
    if (islands.scanning) return;
    pendingRef.current = false;
    autoSupportDrivingScan = false;
    const list = islands.filteredIslands;
    if (list.length > 0 && getSettings().autoSupport.enabled) {
      try {
        runAutoSupports(list);
      } finally {
        setAutoSupportBusy(false);
        setBusy(false);
      }
    } else {
      setAutoSupportBusy(false);
      setBusy(false);
    }
  }, [islands.scanning, islands.filteredIslands, activeModelId, runAutoSupports]);

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
      // Delete only this model's braces: those carrying its modelId, or whose
      // knots hang off its segments (legacy braces without modelId). Other
      // models' braces survive.
      const modelSegments = new Set<string>();
      for (const t of Object.values(snap.trunks)) {
        if (t.modelId === activeModelId) for (const s of t.segments) modelSegments.add(s.id);
      }
      for (const b of Object.values(snap.branches)) {
        if (b.modelId === activeModelId) for (const s of b.segments) modelSegments.add(s.id);
      }
      const removedBraceIds = new Set<string>();
      for (const [id, brace] of Object.entries(snap.braces)) {
        const knotA = brace.startKnotId ? snap.knots[brace.startKnotId] : undefined;
        const knotB = brace.endKnotId ? snap.knots[brace.endKnotId] : undefined;
        const belongsToModel =
          brace.modelId === activeModelId ||
          (knotA ? modelSegments.has(knotA.parentShaftId) : false) ||
          (knotB ? modelSegments.has(knotB.parentShaftId) : false);
        if (belongsToModel) {
          removedBraceIds.add(id);
          delete next.braces[id];
        }
      }
      // Rebuild knots: keep those referenced by surviving entities (other
      // models' trunks/branches/braces/leaf cones) or by the kickstand store;
      // drop orphans left by this model's deleted supports.
      const survivingSegmentIds = new Set<string>();
      for (const t of Object.values(next.trunks)) {
        for (const s of t.segments) survivingSegmentIds.add(s.id);
      }
      for (const b of Object.values(next.branches)) {
        for (const s of b.segments) survivingSegmentIds.add(s.id);
      }
      for (const brace of Object.values(next.braces)) {
        survivingSegmentIds.add(`braceSegment:${brace.id}`);
      }
      for (const l of Object.values(next.leaves)) {
        survivingSegmentIds.add(`leafCone:${l.id}`);
      }
      // The model's kickstands are supports too — drop them from the
      // kickstand store. They used to leak into the next run: stale roots
      // occupied grid nodes and their axes fed the axis-mixing, which
      // flipped a regenerated kickstand between the two sides of its axis.
      {
        const ks = getKickstandSnapshot();
        const removedIds = new Set<string>();
        for (const k of Object.values(ks.kickstands)) {
          if (k.modelId === activeModelId) removedIds.add(k.id);
        }
        if (removedIds.size > 0) {
          const kickstands: typeof ks.kickstands = {};
          const roots: typeof ks.roots = {};
          const knots: typeof ks.knots = {};
          for (const [id, k] of Object.entries(ks.kickstands)) {
            if (removedIds.has(id)) continue;
            kickstands[id] = k;
            const root = ks.roots[k.rootId];
            if (root) roots[root.id] = root;
            const knot = ks.knots[k.hostKnotId];
            if (knot) knots[knot.id] = knot;
          }
          setKickstandSnapshot({
            ...ks,
            kickstands,
            roots,
            knots,
            selectedId: ks.selectedId && !removedIds.has(ks.selectedId) ? ks.selectedId : null,
          });
        }
      }
      const kickstandKnotIds = new Set<string>();
      const kickstandSnap = getKickstandSnapshot();
      for (const k of Object.values(kickstandSnap.kickstands)) {
        kickstandKnotIds.add(k.hostKnotId);
        for (const s of k.segments) survivingSegmentIds.add(s.id);
      }
      const nextKnots: Record<string, Knot> = {};
      for (const [id, knot] of Object.entries(snap.knots)) {
        if (survivingSegmentIds.has(knot.parentShaftId) || kickstandKnotIds.has(id)) {
          nextKnots[id] = knot;
        }
      }
      next.knots = nextKnots;
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
              const list = islandsRef.current.filteredIslands;
              const cur = islandsRef.current;
              if (list.length === 0 && cur.voxelIslands.length === 0 && cur.minimaIslands.length === 0) {
                pendingRef.current = true;
                autoSupportDrivingScan = true;
                void cur.onRunScan();
                return;
              }
              if (list.length > 0 && getSettings().autoSupport.enabled) {
                runAutoSupports(list);
              }
            } finally {
              if (!pendingRef.current) {
                setAutoSupportBusy(false);
                setBusy(false);
              }
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
          if (list.length > 0 && getSettings().autoSupport.enabled) {
            runAutoSupports(list);
          }
        } finally {
          setAutoSupportBusy(false);
          setBusy(false);
        }
      }, 0);
    });
  }, [activeModelId, islands.filteredIslands, islands.voxelIslands.length, islands.minimaIslands.length, runAutoSupports]);

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
                      // Density + sizing tier only — the trunk preset
                      // (manual placement) is deliberately not touched.
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
                    <div className="flex justify-between"><span>Standalone trunks</span><span style={{ color: 'var(--text-strong)' }}>{sizingDebug.standaloneTrunks}</span></div>
                    <div className="flex justify-between"><span>Grid infill trunks</span><span style={{ color: 'var(--text-strong)' }}>{sizingDebug.gridInfillTrunks}</span></div>
                    <div className="flex justify-between" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 2, marginTop: 2 }}>
                      <span>Shaft Ø range</span><span style={{ color: 'var(--text-strong)' }}>{sizingDebug.shaftDiameterRange.min.toFixed(2)}–{sizingDebug.shaftDiameterRange.max.toFixed(2)} mm</span>
                    </div>
                    <div className="flex justify-between"><span>Tip Ø range</span><span style={{ color: 'var(--text-strong)' }}>{sizingDebug.tipContactRange.min.toFixed(2)}–{sizingDebug.tipContactRange.max.toFixed(2)} mm</span></div>
                  </div>
                )}
              </div>
            )}

            {/* Forest Report */}
            {forestReport && (
              <button
                type="button"
                onClick={() => setShowForestReport(true)}
                className="w-full rounded-md border px-2.5 py-2 text-[10px] font-semibold uppercase tracking-wide flex items-center justify-between"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
              >
                <span>Forest Report</span>
                <span className="text-[9px] normal-case tracking-normal">
                  {forestReport.trunkCount}T {forestReport.leafCount}L {forestReport.branchCount}B · {forestReport.trees.length} trees
                </span>
              </button>
            )}

            {!hasGeometry && (
              <div className="text-[10px] italic text-center" style={{ color: 'var(--text-muted)' }}>
                Load a model and scan for islands.
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Forest Report Modal */}
      <StructuredDialogModal
        open={showForestReport}
        ariaLabel="Forest report"
        title="Forest Report"
        subtitle="Every placed support with its size and fan-out groups"
        iconTone="neutral"
        maxWidthClassName="max-w-[72rem]"
        onClose={() => setShowForestReport(false)}
        onBackdropClick={() => setShowForestReport(false)}
        actions={
          <>
            <Button
              onClick={() => {
                if (forestReport) {
                  void navigator.clipboard?.writeText(forestReportToText(forestReport));
                }
              }}
              variant="secondary" size="sm" className="!h-9 text-[12px]"
            >Copy</Button>
            <Button onClick={() => setShowForestReport(false)} variant="primary" size="sm" className="!h-9 text-[12px]">Close</Button>
          </>
        }
      >
        {forestReport && (
          <div className="rounded-md border overflow-hidden" style={SECTION_CARD}>
            <pre
              className="px-3 py-2 text-[10px] leading-relaxed whitespace-pre-wrap break-words tabular-nums overflow-y-auto"
              style={{ color: 'var(--text-muted)', maxHeight: '70vh' }}
            >
              {forestReportToText(forestReport)}
            </pre>
          </div>
        )}
      </StructuredDialogModal>

      {/* Settings Modal */}
      <StructuredDialogModal
        open={showSettings}
        ariaLabel="Auto-support settings"
        title="Auto Supports (Beta) Settings"
        subtitle="Tune candidate generation, clustering, and fan-out"
        iconTone="neutral"
        maxWidthClassName="max-w-2xl"
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
          {/* ── Toggles row — full width ────────────────────────── */}
          <div className="rounded-md border p-2.5" style={SECTION_CARD}>
            <div className="grid grid-cols-5 gap-2">
              {([
                { key: 'enabled' as const, label: 'Enabled', title: 'Generate supports automatically on scan' },
                { key: 'prioritizeIntersection' as const, label: 'Prioritize Dual', title: 'Islands found by BOTH the slice and mesh scans are placed first (they are the most certain)' },
                { key: 'debugSupportOriginColors' as const, label: 'Origin Colors', title: 'Debug: color supports by origin — anchor (red), overhang (orange), island (blue), standalone (purple)' },
                { key: 'debugSkipAutoBracing' as const, label: 'No Brace', title: 'Debug: skip automatic bracing for this run' },
              ]).map((t) => (
                <button key={t.key} type="button" title={t.title}
                  onClick={() => setDraft((d) => ({ ...d, [t.key]: !d[t.key] }))}
                  className="min-h-[36px] w-full rounded-md border px-2 text-[11px] font-semibold uppercase tracking-wide transition-colors flex items-center justify-center"
                  style={draft[t.key]
                    ? { borderColor: 'color-mix(in srgb, var(--accent-secondary), white 10%)', background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 84%)', color: 'color-mix(in srgb, var(--accent-secondary), var(--text-strong) 25%)' }
                    : { borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
                >{t.label}</button>
              ))}
              <button type="button" title="Debug: simplified support render — contact disks/cones plus line vectors instead of full shafts"
                onClick={() => updateDebugSimpleSupportRender(!debugSimpleRender)}
                className="min-h-[36px] w-full rounded-md border px-2 text-[11px] font-semibold uppercase tracking-wide transition-colors flex items-center justify-center"
                style={debugSimpleRender
                  ? { borderColor: 'color-mix(in srgb, var(--accent-secondary), white 10%)', background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 84%)', color: 'color-mix(in srgb, var(--accent-secondary), var(--text-strong) 25%)' }
                  : { borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
              >Simplified</button>
            </div>
          </div>

          {/* ── Tabbed settings body ────────────────────────────── */}
          <div className="rounded-md border p-2.5" style={SECTION_CARD}>
            <div className="grid grid-cols-3 gap-1.5">
              {([
                { key: 'detection' as const, label: 'Detection' },
                { key: 'distribution' as const, label: 'Distribution' },
                { key: 'density' as const, label: 'Density & Sizing' },
              ]).map((tab) => (
                <button key={tab.key} type="button"
                  onClick={() => setSettingsTab(tab.key)}
                  className="h-8 rounded-md border text-[11px] font-semibold uppercase tracking-wide transition-colors"
                  title={tab.key === 'detection'
                    ? 'What counts as a support-needing surface and how tightly regions merge'
                    : tab.key === 'distribution'
                      ? 'How points scatter (grid vs Poisson) and how leaves fan out from trunks'
                      : 'How dense and thick the supports are'}
                  style={settingsTab === tab.key
                    ? { borderColor: 'color-mix(in srgb, var(--accent), white 10%)', background: 'color-mix(in srgb, var(--accent), var(--surface-1) 84%)', color: 'var(--accent)' }
                    : { borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
                >{tab.label}</button>
              ))}
            </div>
          </div>

          <div className="rounded-md border p-2.5" style={SECTION_CARD}>
            {settingsTab === 'detection' && (
              <div className="space-y-2.5">
                {KNOBS.filter(k => ['overhangSelfSupportAngleDeg', 'minIslandAreaMm2', 'tipInfluenceRadiusMm', 'coverageTargetPercent'].includes(k.key)).map(knob => (
                  <SliderRow key={knob.key} knob={knob} draft={draft} setDraft={setDraft} />
                ))}
              </div>
            )}
            {settingsTab === 'distribution' && (
              <>
                <div className="space-y-2.5">
                  {KNOBS.filter(k => ['leafFanRadiusMm', 'leafFanMaxAngleDeg'].includes(k.key)).map(knob => (
                    <SliderRow key={knob.key} knob={knob} draft={draft} setDraft={setDraft} />
                  ))}
                </div>
              </>
            )}
            {settingsTab === 'density' && (
              <div className="space-y-2.5">
                {KNOBS.filter(k => ['areaPerSupportMm2', 'gridAreaThresholdMm2', 'flatDensityBoost', 'slopeRelaxFactor', 'suctionAreaExponent', 'sizeScale', 'maxAttachmentsPerTrunk'].includes(k.key)).map(knob => (
                  <SliderRow key={knob.key} knob={knob} draft={draft} setDraft={setDraft} />
                ))}
              </div>
            )}
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
