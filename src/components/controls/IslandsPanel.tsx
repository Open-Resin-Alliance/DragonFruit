"use client";

import React from 'react';
import { Card, CardHeader, IconButton } from '@/components/ui/primitives';
import { useFloatingPanelCollapse } from '@/components/layout/FloatingPanelStack';
import type { UseIslandsReturn } from '@/volumeAnalysis/Islands/useIslands';
import { ISLAND_LAYER_COLORS } from '@/volumeAnalysis/Islands/islandPuckMarkers';

interface IslandsPanelProps {
  islands: UseIslandsReturn;
  hasGeometry: boolean;
}

/**
 * Support-tab "Islands" panel (PoC). Styling/layout follow the conforming
 * dev-branch card `IslandVoxelControls.tsx` — the Support Painter UI is NOT a
 * template. Tab-agnostic: relies only on the injected `useIslands` return, so it
 * can be mounted under any `scene.mode` (or relocated to the Analysis tab).
 */
export function IslandsPanel({ islands, hasGeometry }: IslandsPanelProps) {
  const [expanded, setExpanded] = useFloatingPanelCollapse(true);
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
  } = islands;

  const voxelOnlyShown = filteredIslands.filter((i) => i.source === 'voxel' && i.class === 'voxelOnly').length;
  const minimaOnlyShown = filteredIslands.filter((i) => i.source === 'minima' && i.class === 'minimaOnly').length;
  const intersectionShown = filteredIslands.filter((i) => i.class === 'intersection' && i.source === 'voxel').length;

  const totalScannedPucks = (stats?.voxelTotal ?? 0) + (stats?.minimaTotal ?? 0) - (stats?.matched ?? 0);
  const totalShownPucks = voxelOnlyShown + minimaOnlyShown + intersectionShown;
  const hiddenPucksCount = totalScannedPucks - totalShownPucks;

  return (
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
          <span className="ui-meta" style={{ color: 'var(--text-muted)' }}>
            {totalScannedPucks > 0 ? `${totalShownPucks}${hiddenPucksCount > 0 ? ` / ${totalScannedPucks}` : ''}` : ''}
          </span>
        )}
        hideDivider={!expanded}
      />

      {expanded && (
        <div className="px-2.5 pt-2 pb-3 space-y-2.5">
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

          {totalScannedPucks > 0 && stats && (
            <div className="space-y-1 pt-0.5 pb-1">
              <div className="ui-meta flex justify-between">
                <span>Voxel islands:</span>
                <span className="font-semibold" style={{ color: 'var(--text-strong)' }}>{stats.voxelTotal}</span>
              </div>
              <div className="ui-meta flex justify-between">
                <span>Mesh minima:</span>
                <span className="font-semibold" style={{ color: 'var(--text-strong)' }}>{stats.minimaTotal}</span>
              </div>
              <div className="ui-meta flex justify-between border-b pb-1 mb-1" style={{ borderColor: 'var(--border-subtle)' }}>
                <span>Intersections (matched):</span>
                <span className="font-semibold" style={{ color: ISLAND_LAYER_COLORS.intersection }}>{stats.matched}</span>
              </div>
              <div className="ui-meta flex justify-between text-[10px]" style={{ color: 'var(--text-muted)' }}>
                <span>Shown pucks:</span>
                <span>{totalShownPucks} ({voxelOnlyShown} vox, {minimaOnlyShown} min, {intersectionShown} int)</span>
              </div>
              {stats.minimaSupersetOfVoxel && (
                <div
                  className="mt-1.5 p-1.5 rounded text-[10px] leading-normal flex items-center gap-1 font-medium"
                  style={{
                    background: 'color-mix(in srgb, var(--accent), var(--surface-0) 88%)',
                    color: 'var(--text-strong)',
                    border: '1px solid color-mix(in srgb, var(--accent), transparent 50%)'
                  }}
                >
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  <span>Verdict: Mesh-minima ⊇ Voxel (100% covered)</span>
                </div>
              )}
            </div>
          )}

          {/* Detection parameters — sweep then re-scan. Defaults: 0.10mm / 0.60mm. */}
          <div className="space-y-2.5 pt-1.5 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
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
            <p className="ui-meta leading-snug" style={{ color: 'var(--text-muted)' }}>
              Lower buffer flags shallower overhangs. Changes apply on the next scan.
            </p>
          </div>

          <label className="flex items-center gap-1.5 py-1 cursor-pointer">
            <input
              type="checkbox"
              checked={showVoxelOnly}
              onChange={(e) => setShowVoxelOnly(e.target.checked)}
              className="ui-checkbox !w-4 !h-4"
            />
            <span
              className="inline-block w-2.5 h-2.5 rounded-full"
              style={{ background: ISLAND_LAYER_COLORS.voxel }}
            />
            <span className="ui-meta">Voxel-only ({voxelOnlyShown})</span>
          </label>

          <label className="flex items-center gap-1.5 py-1 cursor-pointer">
            <input
              type="checkbox"
              checked={showMinimaOnly}
              onChange={(e) => setShowMinimaOnly(e.target.checked)}
              className="ui-checkbox !w-4 !h-4"
            />
            <span
              className="inline-block w-2.5 h-2.5 rounded-full"
              style={{ background: ISLAND_LAYER_COLORS.minima }}
            />
            <span className="ui-meta">Minima-only ({minimaOnlyShown})</span>
          </label>

          <label className="flex items-center gap-1.5 py-1 cursor-pointer">
            <input
              type="checkbox"
              checked={showIntersection}
              onChange={(e) => setShowIntersection(e.target.checked)}
              className="ui-checkbox !w-4 !h-4"
            />
            <span
              className="inline-block w-2.5 h-2.5 rounded-full"
              style={{ background: ISLAND_LAYER_COLORS.intersection }}
            />
            <span className="ui-meta">Intersections ({intersectionShown})</span>
          </label>

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

          <div className="ui-meta pt-1.5 border-t leading-snug" style={{ borderColor: 'var(--border-subtle)' }}>
            <p>Classified contact regions in world space. Intersection layers match voxel and mesh candidate islands within 0.5mm XY / 1 layer Z.</p>
          </div>
        </div>
      )}
    </Card>
  );
}
