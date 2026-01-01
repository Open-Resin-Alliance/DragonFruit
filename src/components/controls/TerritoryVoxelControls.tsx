"use client";

import React from 'react';

interface TerritoryVoxelControlsProps {
    enabled: boolean;
    onEnabledChange: (enabled: boolean) => void;
    opacity: number;
    onOpacityChange: (opacity: number) => void;
    islandCount?: number;
    useSurfaceContiguity?: boolean;
    onUseSurfaceContiguityChange?: (enabled: boolean) => void;
    onRescan?: () => void;
}

/**
 * Control panel for territory voxel visualization settings
 */
export function TerritoryVoxelControls({
    enabled,
    onEnabledChange,
    opacity,
    onOpacityChange,
    islandCount = 0,
    useSurfaceContiguity = false,
    onUseSurfaceContiguityChange,
    onRescan,
}: TerritoryVoxelControlsProps) {
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
                    <h3 className="text-xs font-semibold text-neutral-200">Territory Voxels</h3>
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
                            className="w-full h-1.5 bg-neutral-700 rounded-lg appearance-none cursor-pointer disabled:opacity-50 accent-purple-500"
                        />
                    </div>

                    <div className="text-[9px] text-neutral-500 pt-1 border-t border-neutral-700 leading-tight">
                        <p>Visualizes 'Vertical Watershed' territories, preserving identity after merges.</p>
                    </div>

                    {/* Analysis Settings */}
                    <div className="pt-1 border-t border-neutral-700">
                        <div className="flex items-center justify-between">
                            <label className="text-[9px] text-neutral-400" title="Prioritize surface connectivity to prevent internal tunneling">Surface Priority Mode</label>
                            <button
                                type="button"
                                onClick={() => {
                                    if (onUseSurfaceContiguityChange) {
                                        onUseSurfaceContiguityChange(!useSurfaceContiguity);
                                        // Trigger re-scan immediately if provided
                                        if (onRescan && enabled) {
                                            setTimeout(() => onRescan(), 50);
                                        }
                                    }
                                }}
                                disabled={!onUseSurfaceContiguityChange || !enabled}
                                className={`w-7 h-4 rounded-full flex items-center px-0.5 transition-colors ${useSurfaceContiguity ? 'bg-blue-500' : 'bg-neutral-600'
                                    } ${(!onUseSurfaceContiguityChange || !enabled) ? 'opacity-50 cursor-not-allowed' : ''}`}
                            >
                                <span
                                    className={`w-3 h-3 rounded-full bg-white shadow transform transition-transform ${useSurfaceContiguity ? 'translate-x-3' : 'translate-x-0'
                                        }`}
                                />
                            </button>
                        </div>
                        <div className="text-[8px] text-neutral-500 mt-0.5">
                            {onRescan ? 'Automatically recalculates territory when toggled.' : 'Toggles between internal centroid (OFF) and surface neighbor (ON) logic. Requires Re-Scan.'}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
