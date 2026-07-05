"use client";

import React from 'react';
import { Settings, RotateCcw } from 'lucide-react';
import { Button, Card, CardHeader, IconButton } from '@/components/ui/primitives';
import { NumberInput } from '@/components/ui/NumberInput';
import { Tooltip } from '@/components/ui/Tooltip';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';
import { useFloatingPanelCollapse } from '@/components/layout/FloatingPanelStack';
import type { UseIslandsReturn } from '@/volumeAnalysis/Islands/useIslands';
import { ISLAND_LAYER_COLORS, markerIdFor } from '@/volumeAnalysis/Islands/islandPuckMarkers';

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

function ToggleBtn({ label, checked, color, hint, onChange }: {
  label: string;
  checked: boolean;
  color: string;
  hint: string;
  onChange: (v: boolean) => void;
}) {
  return (
    <Tooltip content={hint}>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className="min-h-[36px] w-full rounded-md border px-2 text-[11px] font-semibold uppercase tracking-wide transition-colors flex items-center justify-center gap-1.5"
        style={checked
          ? {
              borderColor: `color-mix(in srgb, ${color}, white 10%)`,
              background: `color-mix(in srgb, ${color}, var(--surface-1) 84%)`,
              color: `color-mix(in srgb, ${color}, var(--text-strong) 25%)`,
            }
          : {
              borderColor: 'var(--border-subtle)',
              background: 'var(--surface-1)',
              color: 'var(--text-muted)',
            }}
      >
        {label}
      </button>
    </Tooltip>
  );
}

interface IslandsPanelProps {
  islands: UseIslandsReturn;
  hasGeometry: boolean;
  bottomClearancePx?: number;
}

export function IslandsPanel({ islands, hasGeometry, bottomClearancePx = 88 }: IslandsPanelProps) {
  const [expanded, setExpanded] = useFloatingPanelCollapse(true);
  const [showSettings, setShowSettings] = React.useState(false);

  const {
    scanning,
    scanProgress,
    showVoxelOnly,
    setShowVoxelOnly,
    showMinimaOnly,
    setShowMinimaOnly,
    showIntersection,
    setShowIntersection,
    filterToggles,
    setFilterToggles,
    orderedIslands,
    selectedMarkerId,
    selectPrev,
    selectNext,
    tableStats,
    enableVolumeGlow,
    setEnableVolumeGlow,
    draftPxMm,
    setDraftPxMm,
    draftSupportBufMm,
    setDraftSupportBufMm,
    draftConsolidateVoxel,
    setDraftConsolidateVoxel,
    draftConsolidationDistance,
    setDraftConsolidationDistance,
    draftReduceIntersection,
    setDraftReduceIntersection,
    draftIntersectionThreshold,
    setDraftIntersectionThreshold,
    draftScaleMarkersWithArea,
    setDraftScaleMarkersWithArea,
    draftEnableContourRegions,
    setDraftEnableContourRegions,
    draftMaxContourRegions,
    setDraftMaxContourRegions,
    draftRemoveSupportedAreaClusters,
    setDraftRemoveSupportedAreaClusters,
    draftAreaPerSupport,
    setDraftAreaPerSupport,
    applySettings,
    resetSettings,
    applyingSettings,
    hasPendingChanges,
  } = islands;

  const totalDetected = tableStats?.allTotal ?? 0;
  const selectedIndex = React.useMemo(() => {
    if (selectedMarkerId === null) return -1;
    return orderedIslands.findIndex((i) => markerIdFor(i) === selectedMarkerId);
  }, [orderedIslands, selectedMarkerId]);
  const currentIslandLabel = selectedIndex >= 0
    ? orderedIslands[selectedIndex].id.replace(/^\D+/, '')
    : null;

  const computedBottomClearance = Math.max(140, Math.round(bottomClearancePx));

  const hasData = totalDetected > 0;

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
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  {expanded ? (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  ) : (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  )}
                </svg>
              </IconButton>
              <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Islands</h3>
            </>
          )}
          right={(
            <IconButton
              onClick={() => setShowSettings(true)}
              className="!p-1.5"
              title="Scan settings"
            >
              <Settings className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />
            </IconButton>
          )}
          hideDivider={!expanded}
        />

        {expanded && (
          <div className="px-2.5 pb-3 space-y-2.5 overflow-y-auto custom-scrollbar" style={{ maxHeight: `calc(100vh - var(--topbar-height) - ${computedBottomClearance}px)` }}>
            {applyingSettings && (
              <div
                className="absolute inset-0 flex flex-col items-center justify-center z-50 rounded-md"
                style={{
                  background: 'color-mix(in srgb, var(--surface-0) 60%, transparent)',
                  backdropFilter: 'blur(1px)',
                }}
              >
                <div className="flex items-center gap-2 px-3 py-2 border rounded-md shadow-md" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                  <svg className="animate-spin h-4 w-4" style={{ color: 'var(--accent)' }} viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  <span className="text-[11px] font-semibold" style={{ color: 'var(--text-strong)' }}>Recalculating…</span>
                </div>
              </div>
            )}

            {/* Scan button */}
            <button
              type="button"
              onClick={() => { void islands.onRunScan(); }}
              disabled={!hasGeometry || scanning}
              className="ui-button w-full !h-8 text-[11px] disabled:opacity-50"
              style={{
                borderColor: 'var(--accent)',
                background: 'color-mix(in srgb, var(--accent), var(--surface-0) 86%)',
                color: 'var(--accent)',
              }}
            >
              {scanning
                ? `Scanning… ${scanProgress?.done ?? 0}/${scanProgress?.total ?? 0}`
                : 'Scan Islands'}
            </button>

            {/* Progress bar */}
            {scanning && scanProgress && (
              <div className="h-1 rounded-full overflow-hidden" style={{ background: 'var(--surface-2)' }}>
                <div
                  className="h-full rounded-full transition-all duration-200"
                  style={{
                    width: `${Math.min(100, (scanProgress.done / Math.max(1, scanProgress.total)) * 100)}%`,
                    background: 'var(--accent)',
                  }}
                />
              </div>
            )}

            {/* --- Post-scan content --- */}
            {hasData && !scanning && (
              <>
                {/* Breakdown by type */}
                <div className="rounded-md border p-2" style={SECTION_CARD}>
                  <div className="grid grid-cols-3 gap-2">
                    {([
                      { label: 'Voxels', key: 'voxel', color: ISLAND_LAYER_COLORS.voxel, count: tableStats?.voxelTotal ?? 0 },
                      { label: 'Minima', key: 'geom', color: ISLAND_LAYER_COLORS.minima, count: tableStats?.geomTotal ?? 0 },
                      { label: 'Coincident', key: 'coincident', color: ISLAND_LAYER_COLORS.intersection, count: tableStats?.coincidentTotal ?? 0 },
                    ] as const).map(s => (
                      <div key={s.key} className="text-center min-w-0">
                        <div className="flex items-center justify-center gap-1 mb-0.5">
                          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: s.color }} />
                          <span className="text-[9px] font-semibold uppercase tracking-wide truncate" style={{ color: 'var(--text-muted)' }}>{s.label}</span>
                        </div>
                        <div className="text-[13px] font-bold tabular-nums" style={{ color: 'var(--text-strong)' }}>
                          {s.count}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Navigation */}
                <div className="rounded-md border p-2" style={SECTION_CARD}>
                  <SectionHeader title="Navigate" />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={selectPrev}
                      disabled={orderedIslands.length === 0 || selectedIndex <= 0}
                      className="flex-1 h-8 rounded border flex items-center justify-center transition-colors disabled:opacity-40"
                      style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)', color: 'var(--text-strong)' }}
                      title="Previous (B)"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                      </svg>
                    </button>

                    <div className="flex-1 text-center min-w-0">
                      <span className="text-[13px] font-bold tabular-nums" style={{ color: 'var(--text-strong)' }}>
                        {currentIslandLabel ?? orderedIslands.length}
                      </span>
                      {selectedIndex >= 0 && (
                        <span className="text-[10px] ml-1" style={{ color: 'var(--text-muted)' }}>
                          / {orderedIslands.length}
                        </span>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={selectNext}
                      disabled={orderedIslands.length === 0 || selectedIndex >= orderedIslands.length - 1}
                      className="flex-1 h-8 rounded border flex items-center justify-center transition-colors disabled:opacity-40"
                      style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)', color: 'var(--text-strong)' }}
                      title="Next (N)"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                  </div>
                </div>

                {/* Display toggles */}
                <div className="rounded-md border p-2" style={SECTION_CARD}>
                  <SectionHeader title="Display" />
                  <div className="grid grid-cols-2 gap-1.5">
                    <ToggleBtn label="Voxels" checked={showVoxelOnly} onChange={setShowVoxelOnly} color={ISLAND_LAYER_COLORS.voxel} hint="Slicing islands and suspended areas detected from layer contours" />
                    <ToggleBtn label="Minima" checked={showMinimaOnly} onChange={setShowMinimaOnly} color={ISLAND_LAYER_COLORS.minima} hint="Individual lowest-vertex triangles on the mesh surface" />
                    <ToggleBtn label="Coincident" checked={showIntersection} onChange={setShowIntersection} color={ISLAND_LAYER_COLORS.intersection} hint="Regions where both voxel and geometric islands overlap" />
                    <ToggleBtn label="Glow" checked={enableVolumeGlow} onChange={setEnableVolumeGlow} color="#baf72e" hint="Volumetric selection glow around the active island" />
                  </div>
                </div>

                {/* Filter toggles */}
                <div className="rounded-md border p-2" style={SECTION_CARD}>
                  <SectionHeader title="Filters" />
                  <div className="grid grid-cols-2 gap-1.5">
                    {[
                      { label: 'Supported', key: 'supported', checked: filterToggles.showAlreadySupported, onChange: (v: boolean) => setFilterToggles({ ...filterToggles, showAlreadySupported: v }) },
                      { label: 'Plate', key: 'plate', checked: filterToggles.showPlateContact, onChange: (v: boolean) => setFilterToggles({ ...filterToggles, showPlateContact: v }) },
                    ].map(b => (
                      <button
                        key={b.key}
                        type="button"
                        onClick={() => b.onChange(!b.checked)}
                        className="min-h-[36px] rounded-md border px-2 text-[11px] font-semibold uppercase tracking-wide transition-colors flex items-center justify-center gap-1.5"
                        style={b.checked
                          ? {
                              borderColor: 'color-mix(in srgb, var(--accent), white 10%)',
                              background: 'color-mix(in srgb, var(--accent), var(--surface-1) 84%)',
                              color: 'color-mix(in srgb, var(--accent), var(--text-strong) 25%)',
                            }
                          : {
                              borderColor: 'var(--border-subtle)',
                              background: 'var(--surface-1)',
                              color: 'var(--text-muted)',
                            }}
                      >
                        {b.label}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* Empty state */}
            {!hasData && !scanning && hasGeometry && (
              <div
                className="rounded-md border px-3 py-3 text-center text-[11px] leading-snug"
                style={{
                  color: 'var(--text-muted)',
                  borderColor: 'var(--border-subtle)',
                  background: 'color-mix(in srgb, var(--surface-1), transparent 8%)',
                }}
              >
                Scan the model to detect unsupported islands
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Settings Modal */}
      <StructuredDialogModal
        open={showSettings}
        ariaLabel="Scan settings"
        title="Scan Settings"
        subtitle="Configure island detection parameters"
        iconTone="neutral"
        onClose={() => setShowSettings(false)}
        onBackdropClick={() => setShowSettings(false)}
        actions={
          <>
            <Button onClick={() => setShowSettings(false)} variant="secondary" size="sm" className="!h-9 text-[12px]">
              Cancel
            </Button>
            <Button
              onClick={() => { applySettings(); setShowSettings(false); }}
              variant="primary"
              size="sm"
              className="!h-9 text-[12px]"
              disabled={!hasPendingChanges}
            >
              Apply
            </Button>
          </>
        }
      >
        <div className="space-y-3">

          {/* Scan section */}
          <div className="rounded-md border p-2.5" style={SECTION_CARD}>
            <SectionHeader title="Scan" />
            <div className="space-y-3">
              {/* Resolution */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Resolution</span>
                  <span className="text-[11px] tabular-nums font-semibold" style={{ color: 'var(--text-strong)' }}>{draftPxMm.toFixed(2)} mm/px</span>
                </div>
                <input type="range" min="0.03" max="0.5" step="0.01" value={draftPxMm} onChange={(e) => setDraftPxMm(parseFloat(e.target.value))} disabled={scanning} className="ui-range w-full" />
              </div>

              {/* Support Buffer */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Support buffer</span>
                  <span className="text-[11px] tabular-nums font-semibold" style={{ color: 'var(--text-strong)' }}>{draftSupportBufMm.toFixed(2)} mm</span>
                </div>
                <input type="range" min="0" max="1" step="0.05" value={draftSupportBufMm} onChange={(e) => setDraftSupportBufMm(parseFloat(e.target.value))} disabled={scanning} className="ui-range w-full" />
              </div>
            </div>
          </div>

          {/* Clustering section */}
          <div className="rounded-md border p-2.5" style={SECTION_CARD}>
            <SectionHeader title="Clustering" />
            <div className="space-y-3">

              {/* Scale markers with area */}
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={draftScaleMarkersWithArea} onChange={(e) => setDraftScaleMarkersWithArea(e.target.checked)} className="ui-checkbox !w-4 !h-4" />
                <span className="text-[11px] font-medium" style={{ color: 'var(--text-strong)' }}>Scale markers with area</span>
              </label>

              {/* Consolidate — indented under scale */}
              <div className="space-y-1.5 pl-5">
                <label className={`flex items-center gap-2 select-none ${!draftScaleMarkersWithArea ? 'opacity-50 pointer-events-none' : 'cursor-pointer'}`}>
                  <input
                    type="checkbox"
                    checked={draftConsolidateVoxel}
                    onChange={(e) => setDraftConsolidateVoxel(e.target.checked)}
                    disabled={!draftScaleMarkersWithArea}
                    className="ui-checkbox !w-4 !h-4"
                  />
                  <span className="text-[11px] font-medium" style={{ color: 'var(--text-strong)' }}>Consolidate</span>
                </label>
                {draftScaleMarkersWithArea && draftConsolidateVoxel && (
                  <div className="relative">
                    <NumberInput
                      value={draftConsolidationDistance}
                      onChange={(v) => setDraftConsolidationDistance(Math.max(0.1, Math.min(5.0, v)))}
                      className="ui-input h-8 w-full px-2.5 text-xs sm:text-sm text-center no-spinners tabular-nums"
                      step={0.1}
                      min={0.1}
                      max={5.0}
                      showStepper={false}
                    />
                    <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>mm</span>
                  </div>
                )}
              </div>

              {/* Contoured regions */}
              <div className="space-y-1.5">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input type="checkbox" checked={draftEnableContourRegions} onChange={(e) => setDraftEnableContourRegions(e.target.checked)} className="ui-checkbox !w-4 !h-4" />
                  <span className="text-[11px] font-medium" style={{ color: 'var(--text-strong)' }}>Contoured regions</span>
                </label>
                {draftEnableContourRegions && (
                  <div className="relative">
                    <NumberInput
                      value={draftMaxContourRegions}
                      onChange={(v) => setDraftMaxContourRegions(Math.max(1, Math.min(50, Math.round(v))))}
                      className="ui-input h-8 w-full px-2.5 text-xs sm:text-sm text-center no-spinners tabular-nums"
                      step={1}
                      min={1}
                      max={50}
                      showStepper={false}
                    />
                    <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>max</span>
                  </div>
                )}
              </div>

              {/* Remove supported clusters */}
              <div className="space-y-1.5">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input type="checkbox" checked={draftRemoveSupportedAreaClusters} onChange={(e) => setDraftRemoveSupportedAreaClusters(e.target.checked)} className="ui-checkbox !w-4 !h-4" />
                  <span className="text-[11px] font-medium" style={{ color: 'var(--text-strong)' }}>Remove supported clusters</span>
                </label>
                {draftRemoveSupportedAreaClusters && (
                  <div className="relative">
                    <NumberInput
                      value={draftAreaPerSupport}
                      onChange={(v) => setDraftAreaPerSupport(Math.max(1.0, Math.min(10.0, v)))}
                      className="ui-input h-8 w-full px-2.5 text-xs sm:text-sm text-center no-spinners tabular-nums"
                      step={0.5}
                      min={1.0}
                      max={10.0}
                      showStepper={false}
                    />
                    <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>mm²</span>
                  </div>
                )}
              </div>

              {/* Reduce intersections */}
              <div className="space-y-1.5">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input type="checkbox" checked={draftReduceIntersection} onChange={(e) => setDraftReduceIntersection(e.target.checked)} className="ui-checkbox !w-4 !h-4" />
                  <span className="text-[11px] font-medium" style={{ color: 'var(--text-strong)' }}>Reduce intersections</span>
                </label>
                {draftReduceIntersection && (
                  <div className="relative">
                    <NumberInput
                      value={draftIntersectionThreshold}
                      onChange={(v) => setDraftIntersectionThreshold(Math.max(0.1, Math.min(2.0, v)))}
                      className="ui-input h-8 w-full px-2.5 text-xs sm:text-sm text-center no-spinners tabular-nums"
                      step={0.1}
                      min={0.1}
                      max={2.0}
                      showStepper={false}
                    />
                    <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>mm²</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={resetSettings}
            className="ui-button ui-button-secondary w-full !h-8 px-3 text-xs inline-flex items-center justify-center gap-1.5"
          >
            <RotateCcw className="w-3 h-3" />
            Reset defaults
          </button>
        </div>
      </StructuredDialogModal>
    </>
  );
}