"use client";

import React from 'react';
import { Card, CardHeader, IconButton } from '@/components/ui/primitives';
import { useFloatingPanelCollapse } from '@/components/layout/FloatingPanelStack';
import type { UseIslandsReturn } from '@/volumeAnalysis/Islands/useIslands';

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
    showVoxel,
    setShowVoxel,
    filterToggles,
    setFilterToggles,
    pxMm,
    setPxMm,
    supportBufMm,
    setSupportBufMm,
  } = islands;

  const shownCount = filteredIslands.length;
  const totalCount = voxelIslands.length;
  const hiddenCount = totalCount - shownCount;

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
            {totalCount > 0 ? `${shownCount}${hiddenCount > 0 ? ` / ${totalCount}` : ''}` : ''}
          </span>
        )}
        hideDivider={!expanded}
      />

      {expanded && (
        <div className="px-2.5 pt-2 pb-3 space-y-2.5">
          <button
            type="button"
            onClick={() => { void islands.onRunVoxelScan(); }}
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

          {totalCount > 0 && (
            <div className="ui-meta">
              {shownCount} shown
              {hiddenCount > 0 ? ` · ${hiddenCount} filtered (supported / plate-contact)` : ''}
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
              checked={showVoxel}
              onChange={(e) => setShowVoxel(e.target.checked)}
              className="ui-checkbox !w-4 !h-4"
            />
            <span
              className="inline-block w-2.5 h-2.5 rounded-full"
              style={{ background: '#3b82f6' }}
            />
            <span className="ui-meta">Show voxel islands</span>
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
            <p>Unsupported contact regions only — no top-surface false positives. Mesh-minima &amp; intersection layers arrive in Parts B/C.</p>
          </div>
        </div>
      )}
    </Card>
  );
}
