"use client";

import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { Plural, Trans } from '@lingui/react/macro';
import { Card, CardHeader, Toggle } from '@/components/atoms';
import { PanelCollapseToggle } from '@/components/atoms/PanelCollapseToggle';
import { useFloatingPanelCollapse } from '@/components/layout/FloatingPanelStack';

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
    const { _ } = useLingui();
    const [expanded, setExpanded] = useFloatingPanelCollapse(false);

    return (
        <Card>
            <CardHeader
                left={(
                    <>
                        <PanelCollapseToggle expanded={expanded} onToggle={() => setExpanded(!expanded)} />
                        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}><Trans>Territory Voxels</Trans></h3>
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
                        title={_(msg`Toggle Territory Voxels`)}
                    >
                        {enabled
                            ? _(msg({ message: 'ON', comment: 'Toggle state on a narrow uppercase button. Keep it very short.' }))
                            : _(msg({ message: 'OFF', comment: 'Toggle state on a narrow uppercase button. Keep it very short.' }))}
                    </button>
                )}
            />

            {(islandCount > 0 || expanded) && (
                <div className="px-2.5 pt-2 pb-3">
                    {islandCount > 0 && (
                        <div className="ui-meta mb-2">
                            <Plural value={islandCount} one="# island detected" other="# islands detected" />
                        </div>
                    )}

                    {expanded && (
                        <div className="space-y-2.5">
                            <div className="flex flex-col gap-1">
                        <div className="flex items-center justify-between">
                            <label className="ui-meta"><Trans>Opacity</Trans></label>
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
                        <p><Trans>Visualizes “Vertical Watershed” territories, preserving identity after merges.</Trans></p>
                    </div>

                    {/* Analysis Settings */}
                    <div className="pt-1.5 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                        <div className="flex items-center justify-between">
                            <label className="ui-meta" title={_(msg`Prioritize surface connectivity to prevent internal tunneling`)}><Trans>Surface Priority Mode</Trans></label>
                            <Toggle
                                size="sm"
                                checked={useSurfaceContiguity}
                                disabled={!onUseSurfaceContiguityChange || !enabled}
                                className={(!onUseSurfaceContiguityChange || !enabled) ? 'opacity-50 cursor-not-allowed' : undefined}
                                onChange={(checked) => {
                                    if (onUseSurfaceContiguityChange) {
                                        onUseSurfaceContiguityChange(checked);
                                        // Trigger re-scan immediately if provided
                                        if (onRescan && enabled) {
                                            setTimeout(() => onRescan(), 50);
                                        }
                                    }
                                }}
                            />
                        </div>
                        <div className="mt-1 text-[10px] leading-snug" style={{ color: 'color-mix(in srgb, var(--text-muted), black 20%)' }}>
                            {onRescan ? _(msg`Automatically recalculates territory when toggled.`) : _(msg`Toggles between internal centroid (OFF) and surface neighbor (ON) logic. Requires Re-Scan.`)}
                        </div>
                    </div>
                        </div>
                    )}
                </div>
            )}
        </Card>
    );
}
