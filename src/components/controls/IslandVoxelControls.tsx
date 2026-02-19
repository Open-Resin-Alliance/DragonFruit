"use client";

import React from 'react';
import { Card, CardHeader, IconButton, Select } from '@/components/ui/primitives';

interface IslandVoxelControlsProps {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  colorScheme: 'unique' | 'lifecycle' | 'height';
  onColorSchemeChange: (scheme: 'unique' | 'lifecycle' | 'height') => void;
  opacity: number;
  onOpacityChange: (opacity: number) => void;
  showMerged: boolean;
  onShowMergedChange: (show: boolean) => void;
  islandCount?: number;
}

/**
 * Control panel for island voxel visualization settings
 */
export function IslandVoxelControls({
  enabled,
  onEnabledChange,
  colorScheme,
  onColorSchemeChange,
  opacity,
  onOpacityChange,
  showMerged,
  onShowMergedChange,
  islandCount = 0,
}: IslandVoxelControlsProps) {
  const [expanded, setExpanded] = React.useState(false);

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
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Island Voxels</h3>
          </>
        )}
        right={(
          <button
            type="button"
            onClick={() => onEnabledChange(!enabled)}
            className="h-8 min-w-[74px] rounded-md border px-2.5 text-[11px] font-semibold uppercase tracking-wide transition-colors"
            style={enabled
              ? {
                  borderColor: 'color-mix(in srgb, var(--accent), white 10%)',
                  background: 'color-mix(in srgb, var(--accent), var(--surface-0) 76%)',
                  color: 'var(--accent-contrast)',
                }
              : {
                  borderColor: 'var(--border-subtle)',
                  background: 'var(--surface-1)',
                  color: 'var(--text-muted)',
                }}
            title="Toggle Island Voxels"
          >
            {enabled ? 'ON' : 'OFF'}
          </button>
        )}
        hideDivider={!expanded}
      />

      {(islandCount > 0 || expanded) && (
        <div className="px-2.5 pt-2 pb-3">
          {islandCount > 0 && (
            <div className="ui-meta mb-2">
              {islandCount} island{islandCount !== 1 ? 's' : ''} detected
            </div>
          )}

          {expanded && (
            <div className="space-y-2.5">
              <div className="flex flex-col gap-1">
            <label className="ui-meta">Color Scheme</label>
            <Select
              value={colorScheme}
              onChange={(e) => onColorSchemeChange(e.target.value as 'unique' | 'lifecycle' | 'height')}
              disabled={!enabled}
              className="w-full !h-8 px-2 py-0 text-sm disabled:opacity-50"
            >
              <option value="unique">Unique Colors</option>
              <option value="lifecycle">Lifecycle (Merge Status)</option>
              <option value="height">Height Gradient</option>
            </Select>
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <label className="ui-meta">Opacity</label>
              <span className="ui-meta" style={{ color: 'var(--text-strong)' }}>{Math.round(opacity * 100)}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={opacity}
              onChange={(e) => onOpacityChange(parseFloat(e.target.value))}
              disabled={!enabled}
              className="ui-range"
            />
          </div>

          <label className="flex items-center gap-1.5 py-1.5 border-t cursor-pointer" style={{ borderColor: 'var(--border-subtle)' }}>
            <input
              type="checkbox"
              checked={showMerged}
              onChange={(e) => onShowMergedChange(e.target.checked)}
              disabled={!enabled}
              className="ui-checkbox !w-4 !h-4"
            />
            <span className="ui-meta">Show Merged Islands</span>
          </label>

          <div className="ui-meta pt-1.5 border-t leading-snug" style={{ borderColor: 'var(--border-subtle)' }}>
            <p>Visualizes isolated grid-aligned islands.</p>
          </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
