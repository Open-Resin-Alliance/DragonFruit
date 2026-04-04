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

    const enabled = grid.enabled;

    return (
        <div className="space-y-2.5">
            <div className="space-y-1">
                <button
                    type="button"
                    role="switch"
                    aria-checked={enabled}
                    onClick={() => onChange({ enabled: !enabled })}
                    className="ui-input w-full h-[36px] px-2.5 leading-tight text-sm inline-flex items-center justify-between"
                    style={enabled
                        ? {
                            borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 36%)',
                            background: 'color-mix(in srgb, var(--accent), var(--surface-1) 88%)',
                            color: 'var(--accent-contrast)',
                        }
                        : {
                            borderColor: 'var(--border-subtle)',
                            background: 'var(--surface-1)',
                            color: 'var(--text-muted)',
                        }}
                >
                    <span className="text-[12px] font-semibold uppercase tracking-wide">{enabled ? 'On' : 'Off'}</span>
                    <span
                        className="inline-flex h-5 w-9 rounded-full p-0.5 transition-colors"
                        style={{ background: enabled ? 'var(--accent)' : 'var(--surface-2)' }}
                    >
                        <span className={`h-4 w-4 rounded-full bg-white transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0'}`} />
                    </span>
                </button>
            </div>
            {/* Always show grid options, but disable if grid is off */}
            <div className={`grid grid-cols-1 gap-1.5 ${!enabled ? 'opacity-80' : ''}`}>
                <label className="flex flex-col gap-0.5 w-full">
                    <span className="text-[11px] font-medium" style={{ color: !enabled ? 'color-mix(in srgb, var(--text-muted), black 32%)' : 'var(--text-muted)' }}>Spacing</span>
                    <NumberInput
                        value={grid.spacingMm}
                        disabled={!enabled}
                        step={0.1}
                        onChange={(val) => {
                            let safeVal = val;
                            if (safeVal < 1) safeVal = 1;
                            if (safeVal > 10) safeVal = 10;
                            onChange({ spacingMm: safeVal });
                        }}
                        className={`${compactInputClass} w-full disabled:opacity-60 disabled:cursor-not-allowed`}
                    />
                </label>
            </div>
        </div>
    );
}
