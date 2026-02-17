"use client";

import React from 'react';
import { GridSettings } from '../types';
import { NumberInput } from '@/components/ui/NumberInput';

interface GridSettingsCardProps {
    grid: GridSettings;
    onChange: (grid: Partial<GridSettings>) => void;
}

export function GridSettingsCard({ grid, onChange }: GridSettingsCardProps) {
    return (
        <div className="bg-neutral-750 rounded p-1 mb-1">
            <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-neutral-300">Grid</span>
                <label className="flex items-center gap-2 cursor-pointer">
                    <span className="text-[9px] text-neutral-500 uppercase tracking-wide">
                        {grid.enabled ? 'on' : 'off'}
                    </span>
                    <input
                        type="checkbox"
                        checked={grid.enabled}
                        onChange={(e) => onChange({ enabled: e.target.checked })}
                        className="w-3 h-3 rounded border-neutral-700 bg-neutral-900 text-blue-600 focus:ring-1 focus:ring-blue-500"
                    />
                </label>
            </div>
            {/* Always show grid options, but disable if grid is off */}
            <div className={`grid grid-cols-2 gap-1.5 ${!grid.enabled ? 'opacity-80' : ''}`}>
                <label className="flex flex-col gap-0.5">
                    <span className={`text-[9px] ${!grid.enabled ? 'text-neutral-600' : 'text-neutral-400'}`}>Spacing</span>
                    <NumberInput
                        value={grid.spacingMm}
                        disabled={!grid.enabled}
                        onChange={(val) => {
                            let safeVal = val;
                            if (safeVal < 1) safeVal = 1;
                            if (safeVal > 10) safeVal = 10;
                            onChange({ spacingMm: safeVal });
                        }}
                        className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners disabled:bg-neutral-900 disabled:text-neutral-600 disabled:border-neutral-800 disabled:cursor-not-allowed"
                    />
                </label>
            </div>
        </div>
    );
}
