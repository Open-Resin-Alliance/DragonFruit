"use client";

import React from 'react';
import { Card, CardHeader, IconButton } from '@/components/ui/primitives';

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
                        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Territory Voxels</h3>
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
                        title="Toggle Territory Voxels"
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

                    <div className="ui-meta pt-1.5 border-t leading-snug" style={{ borderColor: 'var(--border-subtle)' }}>
                        <p>Visualizes &apos;Vertical Watershed&apos; territories, preserving identity after merges.</p>
                    </div>

                    {/* Analysis Settings */}
                    <div className="pt-1.5 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                        <div className="flex items-center justify-between">
                            <label className="ui-meta" title="Prioritize surface connectivity to prevent internal tunneling">Surface Priority Mode</label>
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
                                className={`w-9 h-5 rounded-full flex items-center px-0.5 transition-colors ${(!onUseSurfaceContiguityChange || !enabled) ? 'opacity-50 cursor-not-allowed' : ''}`}
                                style={{ background: useSurfaceContiguity ? 'var(--accent)' : 'var(--surface-2)' }}
                            >
                                <span
                                    className={`w-4 h-4 rounded-full bg-white shadow transform transition-transform ${useSurfaceContiguity ? 'translate-x-4' : 'translate-x-0'
                                        }`}
                                />
                            </button>
                        </div>
                        <div className="mt-1 text-[10px] leading-snug" style={{ color: 'color-mix(in srgb, var(--text-muted), black 20%)' }}>
                            {onRescan ? 'Automatically recalculates territory when toggled.' : 'Toggles between internal centroid (OFF) and surface neighbor (ON) logic. Requires Re-Scan.'}
                        </div>
                    </div>
                        </div>
                    )}
                </div>
            )}
        </Card>
    );
}
