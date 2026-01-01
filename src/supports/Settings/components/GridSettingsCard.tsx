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
            {grid.enabled && (
                <div className="grid grid-cols-2 gap-1.5">
                    <label className="flex flex-col gap-0.5">
                        <span className="text-[9px] text-neutral-400">Spacing</span>
                        <NumberInput
                            value={grid.spacingMm}
                            onChange={(val) => {
                                let safeVal = val;
                                if (safeVal < 1) safeVal = 1;
                                if (safeVal > 10) safeVal = 10;
                                onChange({ spacingMm: safeVal });
                            }}
                            className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                        />
                    </label>

                    <label className="flex flex-col gap-0.5">
                        <span className="text-[9px] text-neutral-400">Min Angle</span>
                        <NumberInput
                            value={grid.minBranchAngleDeg}
                            onChange={(val) => {
                                let safeVal = val;
                                if (safeVal < 5) safeVal = 5;
                                if (safeVal > 89) safeVal = 89;
                                onChange({ minBranchAngleDeg: safeVal });
                            }}
                            className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                        />
                    </label>

                    <label className="flex flex-col gap-0.5 col-span-2">
                        <span className="text-[9px] text-neutral-400">Attach Step (mm)</span>
                        <NumberInput
                            value={grid.attachSearchStepMm}
                            onChange={(val) => {
                                let safeVal = val;
                                if (safeVal < 0.25) safeVal = 0.25;
                                if (safeVal > 20) safeVal = 20;
                                onChange({ attachSearchStepMm: safeVal });
                            }}
                            className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                        />
                    </label>
                </div>
            )}
        </div>
    );
}
