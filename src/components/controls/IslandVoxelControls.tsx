"use client";

import React from 'react';

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
    <div className="bg-neutral-800/95 backdrop-blur-sm rounded-lg px-3 pb-2 pt-1 shadow-xl">
      <div className="flex items-center justify-between py-1 border-b border-neutral-700 mb-1">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-0.5 hover:bg-neutral-700 rounded transition-colors"
            title={expanded ? 'Collapse card' : 'Expand card'}
          >
            <svg
              className={`w-3 h-3 transform transition-transform ${expanded ? 'text-blue-500' : 'text-neutral-500'}`}
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
          </button>
          <h3 className="text-xs font-semibold text-neutral-200">Island Voxels</h3>
        </div>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onEnabledChange(e.target.checked)}
            className="w-3 h-3 rounded border-neutral-600 bg-neutral-700 text-blue-500 focus:ring-1 focus:ring-blue-500 focus:ring-offset-0"
          />
          <span className="text-[9px] text-neutral-400 uppercase tracking-wide">{enabled ? 'On' : 'Off'}</span>
        </label>
      </div>

      {islandCount > 0 && (
        <div className="text-[9px] text-neutral-400 mb-1 px-1">
          {islandCount} island{islandCount !== 1 ? 's' : ''} detected
        </div>
      )}

      {expanded && (
        <div className="space-y-2 mt-1.5">
          <div className="flex flex-col gap-0.5">
            <label className="text-[9px] text-neutral-400">Color Scheme</label>
            <select
              value={colorScheme}
              onChange={(e) => onColorSchemeChange(e.target.value as 'unique' | 'lifecycle' | 'height')}
              disabled={!enabled}
              className="w-full rounded border border-neutral-700 bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-100 disabled:opacity-50 focus:outline-none focus:border-blue-500"
            >
              <option value="unique">Unique Colors</option>
              <option value="lifecycle">Lifecycle (Merge Status)</option>
              <option value="height">Height Gradient</option>
            </select>
          </div>

          <div className="flex flex-col gap-0.5">
            <div className="flex items-center justify-between">
              <label className="text-[9px] text-neutral-400">Opacity</label>
              <span className="text-[9px] text-neutral-300">{Math.round(opacity * 100)}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={opacity}
              onChange={(e) => onOpacityChange(parseFloat(e.target.value))}
              disabled={!enabled}
              className="w-full h-1.5 bg-neutral-700 rounded-lg appearance-none cursor-pointer disabled:opacity-50 accent-blue-500"
            />
          </div>

          <label className="flex items-center gap-1.5 py-1 border-t border-neutral-700 cursor-pointer">
            <input
              type="checkbox"
              checked={showMerged}
              onChange={(e) => onShowMergedChange(e.target.checked)}
              disabled={!enabled}
              className="w-3 h-3 rounded border-neutral-600 bg-neutral-700 text-blue-500 disabled:opacity-50 focus:ring-1 focus:ring-blue-500"
            />
            <span className="text-[9px] text-neutral-400">Show Merged Islands</span>
          </label>

          <div className="text-[9px] text-neutral-500 pt-1 border-t border-neutral-700 leading-tight">
            <p>Visualizes isolated grid-aligned islands.</p>
          </div>
        </div>
      )}
    </div>
  );
}
