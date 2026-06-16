"use client";

import React from 'react';
import { Card, CardHeader, IconButton } from '@/components/ui/primitives';
import { useFloatingPanelCollapse } from '@/components/layout/FloatingPanelStack';
import type { UseIslandsReturn } from '@/volumeAnalysis/Islands/useIslands';
import { ISLAND_LAYER_COLORS, markerIdFor } from '@/volumeAnalysis/Islands/islandPuckMarkers';

interface IslandsPanelProps {
  islands: UseIslandsReturn;
  hasGeometry: boolean;
  bottomClearancePx?: number;
}

/**
 * Support-tab "Islands" panel (PoC). Styling/layout follow the conforming
 * dev-branch card `IslandVoxelControls.tsx` — the Support Painter UI is NOT a
 * template. Tab-agnostic: relies only on the injected `useIslands` return, so it
 * can be mounted under any `scene.mode` (or relocated to the Analysis tab).
 */
export function IslandsPanel({ islands, hasGeometry, bottomClearancePx = 220 }: IslandsPanelProps) {
  const [expanded, setExpanded] = useFloatingPanelCollapse(true);
  const computedBottomClearance = React.useMemo(() => Math.max(140, Math.round(bottomClearancePx)), [bottomClearancePx]);
  const panelMaxHeight = React.useMemo(() => `calc(100vh - var(--topbar-height,48px) - ${computedBottomClearance}px)`, [computedBottomClearance]);
  const {
    scanning,
    scanProgress,
    filteredIslands,
    voxelIslands,
    minimaIslands,
    showVoxelOnly,
    setShowVoxelOnly,
    showMinimaOnly,
    setShowMinimaOnly,
    showIntersection,
    setShowIntersection,
    stats,
    filterToggles,
    setFilterToggles,
    pxMm,
    setPxMm,
    supportBufMm,
    setSupportBufMm,
    orderedIslands,
    selectedMarkerId,
    setSelectedMarkerId,
    selectPrev,
    selectNext,
    layerHeightMm,
    consolidateVoxel,
    setConsolidateVoxel,
    consolidationDistance,
    setConsolidationDistance,
    reduceIntersection,
    setReduceIntersection,
    intersectionThreshold,
    setIntersectionThreshold,
    enableVolumeGlow,
    setEnableVolumeGlow,
    scaleMarkersWithArea,
    setScaleMarkersWithArea,
    enableContourRegions,
    setEnableContourRegions,
    maxContourRegions,
    setMaxContourRegions,
    removeSupportedAreaClusters,
    setRemoveSupportedAreaClusters,
    areaPerSupport,
    setAreaPerSupport,
    tableStats,
  } = islands;

  const [settingsExpanded, setSettingsExpanded] = React.useState(false);

  const handleResetDefaults = React.useCallback(() => {
    setPxMm(0.05);
    setSupportBufMm(0.25);
    setConsolidateVoxel(true);
    setConsolidationDistance(0.2);
    setReduceIntersection(false);
    setIntersectionThreshold(0.5);
    setScaleMarkersWithArea(true);
    setEnableContourRegions(true);
    setMaxContourRegions(20);
    setRemoveSupportedAreaClusters(false);
    setAreaPerSupport(4.0);
  }, [
    setPxMm,
    setSupportBufMm,
    setConsolidateVoxel,
    setConsolidationDistance,
    setReduceIntersection,
    setIntersectionThreshold,
    setScaleMarkersWithArea,
    setEnableContourRegions,
    setMaxContourRegions,
    setRemoveSupportedAreaClusters,
    setAreaPerSupport,
  ]);

  const voxelOnlyShown = filteredIslands.filter((i) => i.source === 'voxel' && i.class === 'voxelOnly').length;
  const minimaOnlyShown = filteredIslands.filter((i) => i.source === 'minima' && i.class === 'minimaOnly').length;
  const intersectionShown = filteredIslands.filter((i) => i.class === 'intersection' && i.source === 'voxel').length;

  const totalScannedPucks = (stats?.voxelTotal ?? 0) + (stats?.minimaTotal ?? 0) - (stats?.matched ?? 0);
  const totalShownPucks = voxelOnlyShown + minimaOnlyShown + intersectionShown;
  const hiddenPucksCount = totalScannedPucks - totalShownPucks;

  return (
    <Card
      className="flex flex-col relative"
      style={expanded ? { maxHeight: panelMaxHeight } : undefined}
    >
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
          <span className="ui-meta" style={{ color: 'var(--text-muted)' }}>
            {totalScannedPucks > 0 ? `${totalShownPucks}${hiddenPucksCount > 0 ? ` / ${totalScannedPucks}` : ''}` : ''}
          </span>
        )}
        hideDivider={!expanded}
      />

      {expanded && (
        <div className="px-2.5 pt-2 pb-3 space-y-2.5 flex-1 flex flex-col min-h-0">
          <button
            type="button"
            onClick={() => { void islands.onRunScan(); }}
            disabled={!hasGeometry || scanning}
            className="h-8 w-full rounded-md border px-2.5 text-[11px] font-semibold uppercase tracking-wide transition-colors disabled:opacity-50"
            style={{
              borderColor: 'color-mix(in srgb, var(--accent), white 10%)',
              background: 'color-mix(in srgb, var(--accent), var(--surface-0) 76%)',
              color: 'var(--accent-contrast)',
            }}
            title="Detect unsupported island contact regions"
          >
            {scanning
              ? `Scanning… ${scanProgress?.done ?? 0}/${scanProgress?.total ?? 0}`
              : 'Scan Islands'}
          </button>

          {totalScannedPucks > 0 && (
            <div className="space-y-2 flex-1 flex flex-col min-h-0">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={selectPrev}
                  disabled={orderedIslands.length === 0}
                  className="h-7 flex-1 rounded border px-2 text-[10px] font-semibold transition-colors disabled:opacity-50"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    background: 'var(--surface-1)',
                    color: 'var(--text-strong)',
                  }}
                  title="Select previous island (Hotkey: B)"
                >
                  ◀ Prev (B)
                </button>
                <button
                  type="button"
                  onClick={selectNext}
                  disabled={orderedIslands.length === 0}
                  className="h-7 flex-1 rounded border px-2 text-[10px] font-semibold transition-colors disabled:opacity-50"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    background: 'var(--surface-1)',
                    color: 'var(--text-strong)',
                  }}
                  title="Select next island (Hotkey: N)"
                >
                  Next (N) ▶
                </button>
              </div>

              {orderedIslands.length > 0 ? (
                <div
                  className="border rounded divide-y overflow-y-auto flex-grow min-h-[120px] max-h-none"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    background: 'var(--surface-0)',
                  }}
                >
                  {orderedIslands.map((island) => {
                    const id = markerIdFor(island);
                    const isSelected = selectedMarkerId === id;
                    let color: string = ISLAND_LAYER_COLORS.voxel;
                    if (island.class === 'minimaOnly') {
                      color = ISLAND_LAYER_COLORS.minima;
                    } else if (island.class === 'intersection') {
                      color = ISLAND_LAYER_COLORS.intersection;
                    }

                    const label = island.id;
                    const zHeight = island.contact.z.toFixed(2);
                    const layerHeight = layerHeightMm || 0.05;
                    const layerIdx = Math.floor(island.contact.z / layerHeight);

                    return (
                      <div
                        key={id}
                        onClick={() => setSelectedMarkerId(id)}
                        className="flex items-center justify-between px-2 py-1 text-[10px] cursor-pointer transition-colors hover:bg-[color-mix(in_srgb,var(--accent),transparent_92%)]"
                        style={{
                          background: isSelected
                            ? 'color-mix(in srgb, var(--accent), transparent 88%)'
                            : 'transparent',
                        }}
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ background: color }}
                          />
                          <span
                            className="font-medium truncate"
                            style={{ color: isSelected ? 'var(--accent)' : 'var(--text-strong)' }}
                          >
                            {label}
                          </span>
                        </div>
                        <div className="flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
                          <span>Z: {zHeight} mm</span>
                          <span className="font-semibold">L{layerIdx}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div
                  className="p-3 border rounded text-center text-[10px]"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    color: 'var(--text-muted)',
                    background: 'var(--surface-0)',
                  }}
                >
                  No visible islands matching filter.
                </div>
              )}
            </div>
          )}

          {totalScannedPucks > 0 && tableStats && (
            <div className="pt-0.5 pb-1">
              <table className="w-full text-[10px] text-left border-collapse" style={{ color: 'var(--text-strong)' }}>
                <thead>
                  <tr className="border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                    <th className="py-1 font-semibold">Type</th>
                    <th className="py-1 font-semibold text-right">Unsupported</th>
                    <th className="py-1 font-semibold text-right pl-6">Total</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                    <td className="py-1 flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: ISLAND_LAYER_COLORS.voxel }} />
                      <span>Voxel</span>
                    </td>
                    <td className="py-1 text-right font-medium">{tableStats.voxelUnsupported}</td>
                    <td className="py-1 text-right font-medium pl-6">{tableStats.voxelTotal}</td>
                  </tr>
                  <tr className="border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                    <td className="py-1 flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: ISLAND_LAYER_COLORS.minima }} />
                      <span>Geometric</span>
                    </td>
                    <td className="py-1 text-right font-medium">{tableStats.geomUnsupported}</td>
                    <td className="py-1 text-right font-medium pl-6">{tableStats.geomTotal}</td>
                  </tr>
                  <tr className="border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                    <td className="py-1 flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: ISLAND_LAYER_COLORS.intersection }} />
                      <span>Coincident</span>
                    </td>
                    <td className="py-1 text-right font-medium">{tableStats.coincidentUnsupported}</td>
                    <td className="py-1 text-right font-medium pl-6">{tableStats.coincidentTotal}</td>
                  </tr>
                  <tr className="font-semibold">
                    <td className="py-1.5">All</td>
                    <td className="py-1.5 text-right">{tableStats.allUnsupported}</td>
                    <td className="py-1.5 text-right pl-6">{tableStats.allTotal}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {/* Visual Display Toggles & Volumetric Glow */}
          <div className="space-y-2 pt-1.5 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
            <label className="flex items-start gap-1.5 py-0.5 cursor-pointer">
              <input
                type="checkbox"
                checked={showVoxelOnly}
                onChange={(e) => setShowVoxelOnly(e.target.checked)}
                className="ui-checkbox !w-4 !h-4 mt-0.5"
              />
              <span
                className="inline-block w-2 h-2 rounded-full mt-1.5 shrink-0"
                style={{ background: ISLAND_LAYER_COLORS.voxel }}
              />
              <div className="flex flex-col">
                <span className="ui-meta font-medium">Voxels</span>
                <span className="text-[10px] leading-tight" style={{ color: 'var(--text-muted)' }}>
                  Slicing process islands and suspended areas
                </span>
              </div>
            </label>

            <label className="flex items-start gap-1.5 py-0.5 cursor-pointer">
              <input
                type="checkbox"
                checked={showMinimaOnly}
                onChange={(e) => setShowMinimaOnly(e.target.checked)}
                className="ui-checkbox !w-4 !h-4 mt-0.5"
              />
              <span
                className="inline-block w-2 h-2 rounded-full mt-1.5 shrink-0"
                style={{ background: ISLAND_LAYER_COLORS.minima }}
              />
              <div className="flex flex-col">
                <span className="ui-meta font-medium">Mesh Geometric Minima</span>
                <span className="text-[10px] leading-tight" style={{ color: 'var(--text-muted)' }}>
                  Individual lowest triangles in an area
                </span>
              </div>
            </label>

            <label className="flex items-start gap-1.5 py-0.5 cursor-pointer">
              <input
                type="checkbox"
                checked={showIntersection}
                onChange={(e) => setShowIntersection(e.target.checked)}
                className="ui-checkbox !w-4 !h-4 mt-0.5"
              />
              <span
                className="inline-block w-2 h-2 rounded-full mt-1.5 shrink-0"
                style={{ background: ISLAND_LAYER_COLORS.intersection }}
              />
              <div className="flex flex-col">
                <span className="ui-meta font-medium">Coincident Voxel & Geometric Islands</span>
              </div>
            </label>

            <label className="flex items-center gap-1.5 py-0.5 cursor-pointer">
              <input
                type="checkbox"
                checked={enableVolumeGlow}
                onChange={(e) => setEnableVolumeGlow(e.target.checked)}
                className="ui-checkbox !w-4 !h-4"
              />
              <span className="ui-meta">Volumetric selection glow</span>
            </label>
          </div>

          {/* Filter Toggles */}
          <div className="space-y-1.5 pt-1.5 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={filterToggles.showAlreadySupported}
                onChange={(e) => setFilterToggles({ ...filterToggles, showAlreadySupported: e.target.checked })}
                className="ui-checkbox !w-4 !h-4"
              />
              <span className="ui-meta">Show already-supported</span>
            </label>
            <p className="text-[9px] font-normal leading-tight mt-0.5" style={{ color: 'var(--text-muted)', paddingLeft: '22px' }}>
              Area markers retained upon successful support for visibility
            </p>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={filterToggles.showPlateContact}
                onChange={(e) => setFilterToggles({ ...filterToggles, showPlateContact: e.target.checked })}
                className="ui-checkbox !w-4 !h-4"
              />
              <span className="ui-meta">Show plate-contact</span>
            </label>
          </div>

          {/* Voxel Scan Settings Rollup */}
          <div className="border-t pt-2" style={{ borderColor: 'var(--border-subtle)' }}>
            <button
              type="button"
              onClick={() => setSettingsExpanded(!settingsExpanded)}
              className="flex items-center justify-between w-full py-1 text-left text-[11px] font-semibold uppercase tracking-wider transition-colors hover:text-[var(--accent)]"
              style={{ color: 'var(--text-strong)' }}
            >
              <span>Voxel Scan Settings</span>
              <svg
                className="w-3 h-3 transform transition-transform"
                style={{ color: settingsExpanded ? 'var(--accent)' : 'var(--text-muted)' }}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                {settingsExpanded ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                )}
              </svg>
            </button>

            {settingsExpanded && (
              <div className="mt-2.5 space-y-3 pb-1">
                {/* Resolution */}
                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between">
                    <label className="ui-meta">Resolution (pixel)</label>
                    <span className="ui-meta" style={{ color: 'var(--text-strong)' }}>{pxMm.toFixed(2)} mm</span>
                  </div>
                  <input
                    type="range"
                    min="0.03"
                    max="0.5"
                    step="0.01"
                    value={pxMm}
                    onChange={(e) => setPxMm(parseFloat(e.target.value))}
                    disabled={scanning}
                    className="ui-range"
                    title="Voxel pixel size. Smaller = finer detail + slower; larger = coarser + faster."
                  />
                </div>

                {/* Support Buffer */}
                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between">
                    <label className="ui-meta">Support buffer</label>
                    <span className="ui-meta" style={{ color: 'var(--text-strong)' }}>{supportBufMm.toFixed(2)} mm</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={supportBufMm}
                    onChange={(e) => setSupportBufMm(parseFloat(e.target.value))}
                    disabled={scanning}
                    className="ui-range"
                    title="A region within this distance of the layer below counts as supported. Lower = flags shallower overhangs."
                  />
                </div>
                <p className="ui-meta leading-snug font-normal text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  Lower buffer flags shallower overhangs. Changes apply on the next scan.
                </p>

                {/* Scale markers with area */}
                <div className="space-y-2 pt-1.5 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={scaleMarkersWithArea}
                      onChange={(e) => setScaleMarkersWithArea(e.target.checked)}
                      className="ui-checkbox !w-4 !h-4"
                    />
                    <span className="ui-meta">Scale suspension and consolidated markers with suspension area</span>
                  </label>
                </div>

                {/* Contoured regions */}
                <div className="space-y-2 pt-1.5 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={enableContourRegions}
                      onChange={(e) => setEnableContourRegions(e.target.checked)}
                      className="ui-checkbox !w-4 !h-4"
                    />
                    <span className="ui-meta">Paint contoured regions for large overhangs</span>
                  </label>
                  {enableContourRegions && (
                    <div className="flex flex-col gap-1 pl-5">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Max contoured regions</span>
                        <span className="text-[10px] font-semibold" style={{ color: 'var(--text-strong)' }}>{maxContourRegions}</span>
                      </div>
                      <input
                        type="range"
                        min="1"
                        max="50"
                        step="1"
                        value={maxContourRegions}
                        onChange={(e) => setMaxContourRegions(parseInt(e.target.value, 10))}
                        className="ui-range"
                      />
                    </div>
                  )}
                </div>

                {/* Remove area clusters once supported */}
                <div className="space-y-2 pt-1.5 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={removeSupportedAreaClusters}
                      onChange={(e) => setRemoveSupportedAreaClusters(e.target.checked)}
                      className="ui-checkbox !w-4 !h-4"
                    />
                    <span className="ui-meta">Remove area clusters once supported</span>
                  </label>
                  {removeSupportedAreaClusters && (
                    <div className="flex flex-col gap-1 pl-5">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Area per support</span>
                        <span className="text-[10px] font-semibold" style={{ color: 'var(--text-strong)' }}>{areaPerSupport.toFixed(1)} mm²</span>
                      </div>
                      <input
                        type="range"
                        min="1.0"
                        max="10.0"
                        step="0.5"
                        value={areaPerSupport}
                        onChange={(e) => setAreaPerSupport(parseFloat(e.target.value))}
                        className="ui-range"
                      />
                    </div>
                  )}
                </div>

                {/* Consolidate Voxels */}
                <div className="space-y-2 pt-1.5 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                  <label className={`flex items-center gap-1.5 ${!scaleMarkersWithArea ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
                    <input
                      type="checkbox"
                      checked={consolidateVoxel}
                      onChange={(e) => setConsolidateVoxel(e.target.checked)}
                      disabled={!scaleMarkersWithArea}
                      className="ui-checkbox !w-4 !h-4"
                    />
                    <span className="ui-meta">Consolidate voxels</span>
                  </label>
                  {scaleMarkersWithArea && consolidateVoxel && (
                    <div className="flex flex-col gap-1 pl-5">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Consolidation distance</span>
                        <span className="text-[10px] font-semibold" style={{ color: 'var(--text-strong)' }}>{consolidationDistance.toFixed(1)} mm</span>
                      </div>
                      <input
                        type="range"
                        min="0.1"
                        max="5.0"
                        step="0.1"
                        value={consolidationDistance}
                        onChange={(e) => setConsolidationDistance(parseFloat(e.target.value))}
                        className="ui-range"
                      />
                    </div>
                  )}
                </div>

                {/* Reduce Small Intersections */}
                <div className="space-y-2 pt-1.5 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={reduceIntersection}
                      onChange={(e) => setReduceIntersection(e.target.checked)}
                      className="ui-checkbox !w-4 !h-4"
                    />
                    <span className="ui-meta">Reduce small intersections</span>
                  </label>
                  {reduceIntersection && (
                    <div className="flex flex-col gap-1 pl-5">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Intersection threshold</span>
                        <span className="text-[10px] font-semibold" style={{ color: 'var(--text-strong)' }}>{intersectionThreshold.toFixed(1)} mm²</span>
                      </div>
                      <input
                        type="range"
                        min="0.1"
                        max="2.0"
                        step="0.1"
                        value={intersectionThreshold}
                        onChange={(e) => setIntersectionThreshold(parseFloat(e.target.value))}
                        className="ui-range"
                      />
                    </div>
                  )}
                </div>

                {/* Reset Defaults button */}
                <div className="pt-2 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                  <button
                    type="button"
                    onClick={handleResetDefaults}
                    className="h-7 w-full rounded border px-2 text-[10px] font-semibold transition-colors hover:bg-[color-mix(in_srgb,var(--text-strong),transparent_95%)]"
                    style={{
                      borderColor: 'var(--border-subtle)',
                      background: 'var(--surface-1)',
                      color: 'var(--text-strong)',
                    }}
                  >
                    Reset Defaults
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
