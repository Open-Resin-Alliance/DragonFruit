"use client";

import React from 'react';
import { GridSettings } from '../types';
import { NumberInput } from '@/components/ui/NumberInput';

interface GridSettingsCardProps {
    grid: GridSettings;
    onChange: (grid: Partial<GridSettings>) => void;
}

export function GridSettingsCard({ grid, onChange }: GridSettingsCardProps) {
    const compactInputClass = 'ui-input w-full h-[36px] px-3 py-2 text-base no-spinners';

    return (
        <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Grid</span>
                <label className="flex items-center gap-2 cursor-pointer">
                    <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                        {grid.enabled ? 'on' : 'off'}
                    </span>
                    <input
                        type="checkbox"
                        checked={grid.enabled}
                        onChange={(e) => onChange({ enabled: e.target.checked })}
                        className="ui-checkbox"
                    />
                </label>
            </div>
            {/* Always show grid options, but disable if grid is off */}
            <div className={`grid grid-cols-2 gap-1.5 ${!grid.enabled ? 'opacity-80' : ''}`}>
                <label className="flex flex-col gap-0.5">
                    <span className="text-[10px] font-medium" style={{ color: !grid.enabled ? 'color-mix(in srgb, var(--text-muted), black 32%)' : 'var(--text-muted)' }}>Spacing</span>
                    <NumberInput
                        value={grid.spacingMm}
                        disabled={!grid.enabled}
                        onChange={(val) => {
                            let safeVal = val;
                            if (safeVal < 1) safeVal = 1;
                            if (safeVal > 10) safeVal = 10;
                            onChange({ spacingMm: safeVal });
                        }}
                        className={`${compactInputClass} disabled:opacity-60 disabled:cursor-not-allowed`}
                    />
                </label>
            </div>
        </div>
    );
}
