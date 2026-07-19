"use client";

import React from 'react';
import { Settings } from 'lucide-react';
import { Card, CardHeader, IconButton, Button } from '@/components/atoms';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';
import { useFloatingPanelCollapse } from '@/components/layout/FloatingPanelStack';
import type { UseIslandsReturn } from '@/volumeAnalysis/Islands/useIslands';
import { runAutoPlace } from '@/supports/autoSupport';
import type { AutoPlaceAnalytics } from '@/supports/autoSupport';
import { getSettings, updateAutoSupportSettings } from '@/supports/Settings/state';

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

interface LogEntry {
  id: number;
  text: string;
  kind: 'info' | 'success' | 'warning' | 'error';
}

let logId = 0;

// ---------------------------------------------------------------------------
// Tuning knob range definitions
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------

export function AutoSupportPanel({ islands, hasGeometry, activeModelId }: AutoSupportPanelProps) {
  const [expanded, setExpanded] = useFloatingPanelCollapse(true);
  const [busy, setBusy] = React.useState(false);
  const [logs, setLogs] = React.useState<LogEntry[]>([]);
  const [analytics, setAnalytics] = React.useState<AutoPlaceAnalytics | null>(null);
  const [showSettings, setShowSettings] = React.useState(false);

  // Draft settings for the modal (so changes don't apply until "Apply").
  const settings = getSettings().autoSupport;
  const [draft, setDraft] = React.useState(settings);

  // Sync draft when modal opens.
  const openSettings = React.useCallback(() => {
    setDraft(getSettings().autoSupport);
    setShowSettings(true);
  }, []);

  const applySettings = React.useCallback(() => {
    updateAutoSupportSettings(draft);
    setShowSettings(false);
  }, [draft]);

  const addLog = React.useCallback((text: string, kind: LogEntry['kind'] = 'info') => {
    setLogs((prev) => {
      const next = [...prev, { id: ++logId, text, kind }];
      return next.length > 50 ? next.slice(-50) : next;
    });
  }, []);

  const handleRun = React.useCallback(() => {
    if (!activeModelId || busy) return;
    setBusy(true);
    setLogs([]);
    addLog(`Starting auto-support for model ${activeModelId}...`);

    const captured: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      const line = args.map(String).join(' ');
      // Suppress verbose internal logs from both panel capture and console output.
      const noisePrefixes = [
        '[SmartPlacementV2]', 'forward-logs-shared', '[DEBUG', '[Islands]',
        '[SupportStore]', '[SettingsStore]', '[SupportWorkers]',
        'computeFlatteningPlanes', '[processGeometry]', '[3DMouse]',
        'Layer ', 'detect.ts', 'src_0-3tr2',
      ];
      if (noisePrefixes.some(p => line.includes(p))) return;
      captured.push(line);
      originalLog.apply(console, args);
    };

    try {
      const currentSettings = getSettings();
      const islandList = islands.filteredIslands;

      addLog(`${islandList.length} filtered islands (${islands.voxelIslands.length} voxel, ${islands.minimaIslands.length} minima)`);

      if (islandList.length === 0) {
        addLog('No islands to process — run island scan first.', 'warning');
        setBusy(false);
        console.log = originalLog;
        return;
      }

      if (!currentSettings.autoSupport.enabled) {
        addLog('Auto-support is disabled in settings.', 'warning');
        setBusy(false);
        console.log = originalLog;
        return;
      }

      const result = runAutoPlace(
        islandList,
        activeModelId,
        currentSettings.autoSupport,
      );

      for (const entry of captured) {
        if (entry.startsWith('[AutoSupport]')) {
          addLog(entry.replace('[AutoSupport] ', ''), 'info');
        }
      }

      setAnalytics(result.analytics ?? null);

      if (result.changed) {
        addLog(
          `Done: ${result.placedTrunks} trunks, ${result.placedAnchors} anchors, ${result.placedBranches} branches, ${result.placedLeaves} leaves.`,
          'success',
        );
        if (result.rejectedCandidates > 0) {
          addLog(`${result.rejectedCandidates} candidates rejected.`, 'warning');
        }
        if (result.analytics) {
          const a = result.analytics;
          addLog(
            `Coverage: ${a.islandsCovered}/${a.islandsCovered + a.islandsUncovered} islands (${(a.areaCoverage * 100).toFixed(0)}% of area)`,
            a.areaCoverage >= 0.8 ? 'success' : a.areaCoverage >= 0.5 ? 'warning' : 'error',
          );
          if (a.islandsUncovered > 0) {
            addLog(`${a.islandsUncovered} islands still uncovered — consider lowering Min Island Area or increasing density.`, 'warning');
          }
        }
      } else {
        addLog(result.message, 'warning');
      }
    } catch (err) {
      addLog(`Error: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      console.log = originalLog;
      setBusy(false);
    }
  }, [activeModelId, busy, islands.filteredIslands, islands.voxelIslands.length, islands.minimaIslands.length, addLog]);

  const canRun = hasGeometry && !!activeModelId && !busy && !islands.scanning;

  // ── Render ──────────────────────────────────────────────────────────

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
                <svg
                  className="w-3 h-3 transform transition-transform"
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
              <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Auto Support</h3>
            </>
          )}
          right={(
            <IconButton
              onClick={openSettings}
              className="!p-1.5"
              title="Auto-support settings"
            >
              <Settings className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />
            </IconButton>
          )}
          hideDivider={!expanded}
        />

        {expanded && (
          <div className="px-2.5 pb-3 space-y-2.5">
            {/* Status card */}
            <div className="rounded-md border p-2" style={SECTION_CARD}>
              <SectionHeader title="Scan Summary" />
              <div className="grid grid-cols-3 gap-2">
                {([
                  { label: 'Voxel', count: islands.voxelIslands.length },
                  { label: 'Minima', count: islands.minimaIslands.length },
                  { label: 'Filtered', count: islands.filteredIslands.length },
                ]).map((s) => (
                  <div key={s.label} className="text-center min-w-0">
                    <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                      {s.label}
                    </div>
                    <div
                      className="text-sm font-bold"
                      style={{ color: s.label === 'Filtered' ? 'var(--accent)' : 'var(--text-strong)' }}
                    >
                      {islands.scanning ? '…' : s.count}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Active preset indicator */}
            <div className="rounded-md border px-2 py-1.5 flex items-center justify-between" style={SECTION_CARD}>
              <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                Preset
              </span>
              <div className="flex gap-1.5">
                {([
                  { label: 'Detail', max: 0.15 },
                  { label: 'Structure', max: 0.50 },
                  { label: 'Anchor', max: Infinity },
                ] as const).map((p) => {
                  const active = settings.enabled && islands.filteredIslands.length > 0;
                  return (
                    <span
                      key={p.label}
                      className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                      style={{
                        color: 'var(--text-muted)',
                        border: '1px solid var(--border-subtle)',
                      }}
                    >
                      {p.label}
                    </span>
                  );
                })}
              </div>
            </div>

            {/* Run button */}
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
              {busy
                ? 'Running…'
                : `Run Auto-Support${canRun ? ` (${islands.filteredIslands.length} islands)` : ''}`}
            </button>

            {/* Log area */}
            {logs.length > 0 && (
              <div className="rounded-md border p-2" style={SECTION_CARD}>
                <SectionHeader title="Log" />
                <div
                  className="rounded overflow-y-auto max-h-[160px]"
                  style={{ background: 'color-mix(in srgb, var(--surface-0), black 8%)' }}
                >
                  <div className="p-1.5 space-y-0.5 font-mono text-[10px] leading-relaxed">
                    {logs.map((entry) => (
                      <div
                        key={entry.id}
                        style={{
                          color:
                            entry.kind === 'error' ? '#f87171'
                              : entry.kind === 'warning' ? '#f59e0b'
                              : entry.kind === 'success' ? '#34d399'
                              : 'var(--text-muted)',
                        }}
                      >
                        {entry.text}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Analytics card */}
            {analytics && (
              <div className="rounded-md border p-2 space-y-2" style={SECTION_CARD}>
                <SectionHeader title="Run Analytics" />
                {/* Coverage */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Coverage</span>
                    <span className="text-[11px] tabular-nums font-semibold" style={{ color: analytics.areaCoverage >= 0.8 ? '#34d399' : analytics.areaCoverage >= 0.5 ? '#f59e0b' : '#f87171' }}>
                      {analytics.islandsCovered}/{analytics.islandsCovered + analytics.islandsUncovered} islands ({(analytics.areaCoverage * 100).toFixed(0)}%)
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--surface-2)' }}>
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${Math.min(100, analytics.areaCoverage * 100)}%`,
                        background: analytics.areaCoverage >= 0.8 ? '#34d399' : analytics.areaCoverage >= 0.5 ? '#f59e0b' : '#f87171',
                      }}
                    />
                  </div>
                </div>
                {/* Presets */}
                <div className="grid grid-cols-3 gap-1.5 text-center">
                  {([
                    { label: 'Detail', key: 'detail' as const, color: '#f59e0b' },
                    { label: 'Structure', key: 'structure' as const, color: '#60a5fa' },
                    { label: 'Anchor', key: 'anchor' as const, color: '#34d399' },
                  ]).map((p) => (
                    <div key={p.key} className="rounded px-1.5 py-1" style={{ background: 'color-mix(in srgb, var(--surface-0), black 6%)' }}>
                      <div className="text-[9px] font-semibold uppercase" style={{ color: p.color }}>{p.label}</div>
                      <div className="text-xs font-bold" style={{ color: 'var(--text-strong)' }}>{analytics.presets[p.key]}</div>
                    </div>
                  ))}
                </div>
                {/* Rejection reasons */}
                {Object.keys(analytics.rejectionReasons).length > 0 && (
                  <div>
                    <div className="text-[9px] font-semibold uppercase tracking-wide mb-1" style={{ color: 'var(--text-muted)' }}>Rejections</div>
                    <div className="space-y-0.5">
                      {(Object.entries(analytics.rejectionReasons) as [string, number][]).map(([reason, count]) => (
                        <div key={reason} className="flex justify-between text-[10px]">
                          <span style={{ color: 'var(--text-muted)' }}>{reason.replace(/_/g, ' ')}</span>
                          <span className="tabular-nums" style={{ color: '#f87171' }}>{count}</span>
                        </div>
                      ))}
                    </div>
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

      {/* ── Settings Modal ──────────────────────────────────────────── */}
      <StructuredDialogModal
        open={showSettings}
        ariaLabel="Auto-support settings"
        title="Auto-Support Settings"
        subtitle="Tune candidate generation, clustering, and fan-out"
        iconTone="neutral"
        onClose={() => setShowSettings(false)}
        onBackdropClick={() => setShowSettings(false)}
        actions={
          <>
            <Button onClick={() => setShowSettings(false)} variant="secondary" size="sm" className="!h-9 text-[12px]">
              Cancel
            </Button>
            <Button onClick={applySettings} variant="primary" size="sm" className="!h-9 text-[12px]">
              Apply
            </Button>
          </>
        }
      >
        <div className="space-y-3">

          {/* Toggles */}
          <div className="rounded-md border p-2.5" style={SECTION_CARD}>
            <SectionHeader title="General" />
            <div className="grid grid-cols-2 gap-2">
              {([
                { key: 'enabled' as const, label: 'Enabled', hint: 'Enable auto-support placement' },
                { key: 'prioritizeIntersection' as const, label: 'Prioritize Dual-Detect', hint: '1.5× priority for islands confirmed by both voxel + minima detectors' },
              ]).map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, [t.key]: !d[t.key] }))}
                  className="min-h-[36px] w-full rounded-md border px-2 text-[11px] font-semibold uppercase tracking-wide transition-colors flex items-center justify-center gap-1.5"
                  style={(draft as any)[t.key]
                    ? {
                        borderColor: 'color-mix(in srgb, var(--accent-secondary), white 10%)',
                        background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 84%)',
                        color: 'color-mix(in srgb, var(--accent-secondary), var(--text-strong) 25%)',
                      }
                    : { borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
                  title={t.hint}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Debug */}
          <div className="rounded-md border p-2.5" style={SECTION_CARD}>
            <SectionHeader title="Debug" />
            <div className="grid grid-cols-2 gap-2">
              {([
                { key: 'debugSkipAutoBracing' as const, label: 'Skip Auto-Brace', hint: 'Skip auto-bracing after placement (faster iteration)' },
                { key: 'debugClusterColorsEnabled' as const, label: 'Cluster Colors', hint: 'Color-code supports by cluster group' },
              ]).map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, [t.key]: !(d as any)[t.key] }))}
                  className="min-h-[36px] w-full rounded-md border px-2 text-[11px] font-semibold uppercase tracking-wide transition-colors flex items-center justify-center gap-1.5"
                  style={(draft as any)[t.key]
                    ? {
                        borderColor: 'color-mix(in srgb, var(--accent-secondary), white 10%)',
                        background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 84%)',
                        color: 'color-mix(in srgb, var(--accent-secondary), var(--text-strong) 25%)',
                      }
                    : { borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
                  title={t.hint}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Numeric knobs */}
          <div className="rounded-md border p-2.5" style={SECTION_CARD}>
            <SectionHeader title="Placement" />
            <div className="space-y-3">
              {KNOBS.map((knob) => {
                const value = (draft as any)[knob.key] as number;
                return (
                  <div key={knob.key}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }} title={knob.hint}>
                        {knob.label}
                      </span>
                      <span className="text-[11px] tabular-nums font-semibold" style={{ color: 'var(--text-strong)' }}>
                        {knob.step < 1 ? value.toFixed(1) : value}{knob.unit}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={knob.min}
                      max={knob.max}
                      step={knob.step}
                      value={value}
                      onChange={(e) => setDraft((d) => ({ ...d, [knob.key]: parseFloat(e.target.value) }))}
                      className="ui-range w-full"
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {/* Preset info */}
          <div className="rounded-md border p-2.5" style={SECTION_CARD}>
            <SectionHeader title="Sizing Presets" />
            <div className="space-y-1.5">
              {([
                { label: 'Detail',  area: '≤ 0.15 mm²', tip: '0.22 mm', shaft: '0.8 mm', flare: '2.5 mm' },
                { label: 'Structure', area: '0.15 – 0.50 mm²', tip: '0.28 mm', shaft: '1.0 mm', flare: '—' },
                { label: 'Anchor', area: '> 0.50 mm²', tip: '0.40 mm', shaft: '1.2 mm', flare: '4.0 mm' },
              ] as const).map((p) => (
                <div key={p.label} className="flex items-center gap-2 text-[10px]">
                  <span className="w-16 font-semibold" style={{ color: 'var(--text-strong)' }}>{p.label}</span>
                  <span style={{ color: 'var(--text-muted)' }}>{p.area}</span>
                  <span className="ml-auto tabular-nums" style={{ color: 'var(--text-muted)' }}>
                    tip {p.tip} · shaft {p.shaft} · flare {p.flare}
                  </span>
                </div>
              ))}
            </div>
          </div>

        </div>
      </StructuredDialogModal>
    </>
  );
}
