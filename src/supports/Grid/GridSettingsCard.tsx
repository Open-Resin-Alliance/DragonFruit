import React from 'react';
import { SupportSettings } from '../types';

interface GridSettingsCardProps {
    grid: SupportSettings['grid'];
    onChange: (newGrid: SupportSettings['grid']) => void;
}

export function GridSettingsCard({ grid, onChange }: GridSettingsCardProps) {
    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-neutral-300">Grid</span>
                <label className="flex items-center gap-2 cursor-pointer">
                    <span className="text-[10px] text-neutral-500">
                        {grid?.enabled ? 'enabled' : 'disabled'}
                    </span>
                    <input
                        type="checkbox"
                        checked={grid?.enabled ?? false}
                        onChange={(e) => {
                            const newEnabled = e.target.checked;
                            onChange({ ...(grid || { spacingMm: 4.0 }), enabled: newEnabled });
                        }}
                        className="w-4 h-4 rounded border-neutral-700 bg-neutral-900 text-blue-600 focus:ring-2 focus:ring-blue-500"
                    />
                </label>
            </div>
            {grid?.enabled && (
                <div className="grid grid-cols-2 gap-2 text-xs">
                    <label className="flex flex-col gap-1">
                        <span className="text-neutral-400">Spacing (mm)</span>
                        <input
                            type="number"
                            min={1}
                            max={10}
                            step={0.5}
                            value={grid.spacingMm}
                            onChange={(e) => {
                                let newSpacing = parseFloat(e.target.value) || 4.0;
                                if (newSpacing < 1) newSpacing = 1;
                                if (newSpacing > 10) newSpacing = 10;
                                onChange({ ...grid, spacingMm: newSpacing });
                            }}
                            className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100"
                        />
                    </label>
                </div>
            )}
        </div>
    );
}
