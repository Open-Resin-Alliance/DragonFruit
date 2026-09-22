"use client";

import React from 'react';
import { GridSettings } from '../types';
import { NumberInput } from '@/components/ui/NumberInput';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';

interface GridSettingsCardProps {
    grid: GridSettings;
    onChange: (grid: Partial<GridSettings>) => void;
}

export function GridSettingsCard({ grid, onChange }: GridSettingsCardProps) {
    const { _ } = useLingui();
    const unitHint = (unit: string) => (
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>{unit}</span>
    );
    const compactInputClass = 'ui-input w-full h-[36px] px-3 py-2 text-base text-center no-spinners !bg-[var(--surface-0)]';

    const enabled = grid.enabled;

    return (
        <div className="flex items-stretch gap-1.5">
            <button
                type="button"
                role="switch"
                aria-checked={enabled}
                onClick={() => onChange({ enabled: !enabled })}
                className="ui-input h-[36px] flex-1 min-w-0 px-2.5 leading-tight text-sm inline-flex items-center justify-between"
                style={enabled
                    ? {
                        borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 36%)',
                        background: 'color-mix(in srgb, var(--accent), var(--surface-1) 88%)',
                        color: 'color-mix(in srgb, var(--accent), var(--text-strong) 25%)',
                    }
                    : {
                        borderColor: 'var(--border-subtle)',
                        background: 'var(--surface-1)',
                        color: 'var(--text-muted)',
                    }}
            >
                <span className="text-[12px] font-semibold uppercase tracking-wide">{enabled ? _(msg({ message: 'On', comment: 'Toggle state shown uppercase on the grid switch in the support settings.' })) : _(msg({ message: 'Off', comment: 'Toggle state shown uppercase on the grid switch in the support settings.' }))}</span>
                <span
                    className="inline-flex h-5 w-9 rounded-full p-0.5 transition-colors"
                    style={{ background: enabled ? 'var(--accent)' : 'var(--surface-2)' }}
                >
                    <span className={`h-4 w-4 rounded-full bg-white transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0'}`} />
                </span>
            </button>
            {/* Always show the spacing, but disable it while grid is off */}
            <div className="relative flex-1 min-w-0">
                <NumberInput
                    value={grid.spacingMm}
                    disabled={!enabled}
                    step={0.1}
                    showStepper={false}
                    onChange={(val) => {
                        let safeVal = val;
                        if (safeVal < 1) safeVal = 1;
                        if (safeVal > 10) safeVal = 10;
                        onChange({ spacingMm: safeVal });
                    }}
                    className={`${compactInputClass} w-full disabled:opacity-60 disabled:cursor-not-allowed`}
                />
                {unitHint('mm')}
            </div>
        </div>
    );
}
