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
    <div className="bg-neutral-800 rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-0.5 hover:bg-neutral-700 rounded transition-colors"
            title={expanded ? 'Collapse card' : 'Expand card'}
          >
            <svg 
              className={`w-4 h-4 ${enabled ? 'text-blue-500' : 'text-neutral-500'}`} 
              fill="none" 
              stroke="currentColor" 
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
          </button>
          <h3 className="text-sm font-semibold text-neutral-200">Island Voxels</h3>
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onEnabledChange(e.target.checked)}
            className="w-4 h-4 rounded border-neutral-600 bg-neutral-700 text-blue-500"
          />
          <span className="text-xs text-neutral-300">Show</span>
        </label>
      </div>
      
      {islandCount > 0 && (
        <div className="text-xs text-neutral-400">
          {islandCount} island{islandCount !== 1 ? 's' : ''} detected
        </div>
      )}
      
      {expanded && (
        <>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-neutral-400">Color Scheme</label>
            <select
              value={colorScheme}
              onChange={(e) => onColorSchemeChange(e.target.value as 'unique' | 'lifecycle' | 'height')}
              disabled={!enabled}
              className="w-full rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-sm text-neutral-100 disabled:opacity-50"
            >
              <option value="unique">Unique Colors</option>
              <option value="lifecycle">Lifecycle (Active/Merged)</option>
              <option value="height">Height Gradient</option>
            </select>
          </div>
          
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <label className="text-xs text-neutral-400">Opacity</label>
              <span className="text-xs text-neutral-300">{Math.round(opacity * 100)}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={opacity}
              onChange={(e) => onOpacityChange(parseFloat(e.target.value))}
              disabled={!enabled}
              className="w-full h-2 bg-neutral-700 rounded-lg appearance-none cursor-pointer disabled:opacity-50"
            />
          </div>
          
          <div className="flex items-center justify-between pt-2 border-t border-neutral-700">
            <label className="text-xs text-neutral-400">Show Merged Islands</label>
            <input
              type="checkbox"
              checked={showMerged}
              onChange={(e) => onShowMergedChange(e.target.checked)}
              disabled={!enabled}
              className="w-4 h-4 rounded border-neutral-600 bg-neutral-700 text-blue-500 disabled:opacity-50"
            />
          </div>
          
          <div className="text-xs text-neutral-500 pt-2 border-t border-neutral-700">
            <p className="mb-1">Voxel visualization shows each island as colored 3D pixels.</p>
            <ul className="list-disc list-inside space-y-0.5 ml-1">
              <li><strong>Unique Colors:</strong> Each island gets a distinct color</li>
              <li><strong>Lifecycle:</strong> Green = active, Orange = merged</li>
              <li><strong>Height:</strong> Blue (high) to red (low)</li>
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
