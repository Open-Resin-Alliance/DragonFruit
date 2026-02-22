"use client";

import React from 'react';
import { NumberInput } from '@/components/ui/NumberInput';
import { Button } from '@/components/ui/primitives';
import {
    AUTO_BRACING_CONSTRAINTS,
    AUTO_BRACING_HARD_RULES,
    AUTO_BRACING_PATTERN_OPTIONS,
    type AutoBracingSettings,
    type AutoBracingPattern,
} from './settings';

interface AutoBracingSettingsCardProps {
    settings: AutoBracingSettings;
    onChange: (patch: Partial<AutoBracingSettings>) => void;
    onAutoBrace: () => void;
    status?: {
        kind: 'success' | 'warning' | 'error';
        message: string;
    } | null;
}

const compactInputClass = 'ui-input w-full h-[36px] px-3 py-2 text-base no-spinners';

export function AutoBracingSettingsCard({
    settings,
    onChange,
    onAutoBrace,
    status,
}: AutoBracingSettingsCardProps) {
    const renderPatternSelect = (
        label: string,
        value: AutoBracingPattern,
        onPatternChange: (pattern: AutoBracingPattern) => void,
    ) => {
        return (
            <label className="space-y-1 min-w-0">
                <div className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>{label}</div>
                <select
                    value={value}
                    onChange={(event) => onPatternChange(event.target.value as AutoBracingPattern)}
                    className="ui-input w-full h-[36px] px-3 py-2 text-base"
                >
                    {AUTO_BRACING_PATTERN_OPTIONS.map((pattern) => (
                        <option key={pattern} value={pattern}>
                            {pattern === 'singleDiagonal' ? 'Single diagonal' : 'Cross diagonal'}
                        </option>
                    ))}
                </select>
            </label>
        );
    };

    return (
        <div className="space-y-3">
            <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                Auto Bracing
            </div>

            <div className="grid grid-cols-2 gap-1.5">
                <label className="space-y-1 min-w-0">
                    <div className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>Brace diameter (mm)</div>
                    <NumberInput
                        value={settings.braceDiameterMm}
                        onChange={(value) => onChange({ braceDiameterMm: value })}
                        className={compactInputClass}
                    />
                </label>

                <label className="space-y-1 min-w-0">
                    <div className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>Max group size</div>
                    <NumberInput
                        value={settings.maxGroupSize}
                        onChange={(value) => onChange({ maxGroupSize: value })}
                        className={compactInputClass}
                    />
                </label>
            </div>

            <div className="grid grid-cols-2 gap-1.5">
                {renderPatternSelect('Initial pattern', settings.initialPattern, (initialPattern) => onChange({ initialPattern }))}
                <label className="space-y-1 min-w-0">
                    <div className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>Initial offset from bottom (mm)</div>
                    <NumberInput
                        value={settings.initialOffsetFromBottomMm}
                        onChange={(value) => onChange({ initialOffsetFromBottomMm: value })}
                        className={compactInputClass}
                    />
                </label>
            </div>

            <div className="grid grid-cols-2 gap-1.5">
                {renderPatternSelect('Repeat pattern', settings.repeatPattern, (repeatPattern) => onChange({ repeatPattern }))}
                <label className="space-y-1 min-w-0">
                    <div className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>Repeat interval (mm)</div>
                    <NumberInput
                        value={settings.repeatIntervalMm}
                        onChange={(value) => onChange({ repeatIntervalMm: value })}
                        className={compactInputClass}
                    />
                </label>
            </div>

            <label className="flex items-center justify-between rounded-md border px-2.5 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-0), transparent 8%)' }}>
                <span className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>Show section debug colors</span>
                <input
                    type="checkbox"
                    checked={settings.debugSectionColorsEnabled}
                    onChange={(event) => onChange({ debugSectionColorsEnabled: event.target.checked })}
                    className="ui-checkbox"
                />
            </label>

            <label className="flex items-center justify-between rounded-md border px-2.5 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-0), transparent 8%)' }}>
                <span className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>Show support height labels (debug)</span>
                <input
                    type="checkbox"
                    checked={settings.debugSupportHeightLabelsEnabled}
                    onChange={(event) => onChange({ debugSupportHeightLabelsEnabled: event.target.checked })}
                    className="ui-checkbox"
                />
            </label>

            <div className="rounded-md border px-2.5 py-2 text-[10px] leading-tight" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-0), transparent 6%)', color: 'var(--text-muted)' }}>
                <div>Fixed rules: {AUTO_BRACING_HARD_RULES.braceAngleDeg}° brace angle, minimum group size {AUTO_BRACING_HARD_RULES.minGroupSize}, and {AUTO_BRACING_HARD_RULES.minAxisSeparationDeg}° minimum axis separation.</div>
                <div className="mt-1">Value limits: diameter {AUTO_BRACING_CONSTRAINTS.braceDiameterMm.min}–{AUTO_BRACING_CONSTRAINTS.braceDiameterMm.max} mm, group size {AUTO_BRACING_CONSTRAINTS.maxGroupSize.min}–{AUTO_BRACING_CONSTRAINTS.maxGroupSize.max}.</div>
            </div>

            {status && (
                <div
                    className="rounded-md border px-2.5 py-2 text-[10px] leading-tight"
                    style={{
                        borderColor:
                            status.kind === 'success'
                                ? '#34d399'
                                : status.kind === 'warning'
                                    ? '#f59e0b'
                                    : '#f87171',
                        color:
                            status.kind === 'success'
                                ? '#34d399'
                                : status.kind === 'warning'
                                    ? '#f59e0b'
                                    : '#f87171',
                        background: 'color-mix(in srgb, var(--surface-0), transparent 6%)',
                    }}
                >
                    {status.message}
                </div>
            )}

            <Button
                type="button"
                onClick={onAutoBrace}
                variant="primary"
                size="sm"
                className="w-full !h-10 !text-[12px] !font-semibold"
            >
                Auto Brace
            </Button>
        </div>
    );
}
