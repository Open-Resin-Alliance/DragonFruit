"use client";

import React from 'react';
import { NumberInput } from '@/components/ui/NumberInput';
import { Button } from '@/components/ui/primitives';
import { SelectDropdown } from '@/components/ui/SelectDropdown';
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
const compactFieldLabelClass = 'text-[11px] font-medium leading-tight';

export function AutoBracingSettingsCard({
    settings,
    onChange,
    onAutoBrace,
    status,
}: AutoBracingSettingsCardProps) {
    const ToggleButton = ({
        checked,
        onChange,
        label,
    }: {
        checked: boolean;
        onChange: () => void;
        label: string;
    }) => (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            onClick={onChange}
            className="ui-input w-full h-[36px] px-2.5 leading-tight text-sm inline-flex items-center justify-between"
            style={checked
                ? {
                    borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 36%)',
                    background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 90%)',
                    color: 'var(--text-strong)',
                }
                : {
                    borderColor: 'var(--border-subtle)',
                    background: 'var(--surface-1)',
                    color: 'var(--text-muted)',
                }}
        >
            <span className="text-[12px] font-semibold uppercase tracking-wide">{label}</span>
            <span
                className="inline-flex h-5 w-9 rounded-full p-0.5 transition-colors"
                style={{ background: checked ? 'var(--accent-secondary)' : 'var(--surface-2)' }}
            >
                <span className={`h-4 w-4 rounded-full bg-white transition-transform ${checked ? 'translate-x-4' : 'translate-x-0'}`} />
            </span>
        </button>
    );

    const renderPatternSelect = (
        label: string,
        value: AutoBracingPattern,
        onPatternChange: (pattern: AutoBracingPattern) => void,
    ) => {
        return (
            <label className="space-y-1 min-w-0">
                <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }}>{label}</div>
                <SelectDropdown
                    value={value}
                    onChange={(nextValue) => onPatternChange(nextValue as AutoBracingPattern)}
                    options={AUTO_BRACING_PATTERN_OPTIONS.map((pattern) => ({
                        value: pattern,
                        label: pattern === 'singleDiagonal' ? 'Single diagonal' : 'Cross diagonal',
                    }))}
                    className="min-w-0 space-y-0"
                    selectClassName="h-[36px] px-3 py-2 text-base"
                />
            </label>
        );
    };

    return (
        <div className="space-y-1.5">
            <div className="space-y-1.5">
                {/* Global Settings */}
                <div className="grid grid-cols-2 gap-1.5 items-start">
                    <label className="space-y-1 min-w-0">
                        <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }}>Brace Diameter (mm)</div>
                        <NumberInput
                            value={settings.braceDiameterMm}
                            onChange={(value) => onChange({ braceDiameterMm: value })}
                            step={0.1}
                            className={compactInputClass}
                        />
                    </label>
                    <label className="space-y-1 min-w-0">
                        <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }}>Seed Spacing (Cells)</div>
                        <NumberInput
                            value={settings.seedSpacingMm}
                            onChange={(value) => onChange({ seedSpacingMm: value })}
                            className={compactInputClass}
                        />
                    </label>
                </div>

                {/* Initial Pattern Settings */}
                <div className="grid grid-cols-2 gap-1.5 items-start">
                    {renderPatternSelect('Initial Pattern', settings.initialPattern, (initialPattern) => onChange({ initialPattern }))}
                    <label className="space-y-1 min-w-0">
                        <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }}>Initial Distance (mm)</div>
                        <NumberInput
                            value={settings.initialDistanceMm}
                            onChange={(value) => onChange({ initialDistanceMm: value })}
                            step={0.1}
                            className={compactInputClass}
                        />
                    </label>
                </div>

                {/* Repeating Pattern Settings */}
                <div className="grid grid-cols-2 gap-1.5 items-start">
                    {renderPatternSelect('Repeating Pattern', settings.repeatingPattern, (repeatingPattern) => onChange({ repeatingPattern }))}
                    <label className="space-y-1 min-w-0">
                        <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }}>Repeat Interval (mm)</div>
                        <NumberInput
                            value={settings.patternIntervalMm}
                            onChange={(value) => onChange({ patternIntervalMm: value })}
                            step={0.1}
                            className={compactInputClass}
                        />
                    </label>
                </div>

                <div className="h-px w-full" style={{ background: 'var(--border-subtle)' }} />

                {/* Tuning Settings */}
                <div className="grid grid-cols-2 gap-1.5 items-start">
                    <label className="space-y-1 min-w-0">
                        <div className={compactFieldLabelClass} style={{ color: 'var(--text-secondary)' }}>Seed Jitter (Cells)</div>
                        <NumberInput
                            value={settings.seedJitterMm}
                            onChange={(value) => onChange({ seedJitterMm: value })}
                            className={compactInputClass}
                        />
                    </label>
                    <label className="space-y-1 min-w-0">
                        <div className={compactFieldLabelClass} style={{ color: 'var(--text-secondary)' }}>Max Brace Distance (mm)</div>
                        <NumberInput
                            value={settings.maxBraceLengthMm}
                            onChange={(value) => onChange({ maxBraceLengthMm: value })}
                            step={0.1}
                            className={compactInputClass}
                        />
                    </label>
                </div>
            </div>

            <div className="grid grid-cols-2 gap-1.5">
                <ToggleButton
                    checked={settings.debugSectionColorsEnabled}
                    onChange={() => onChange({ debugSectionColorsEnabled: !settings.debugSectionColorsEnabled })}
                    label="Section Colors"
                />
                <ToggleButton
                    checked={settings.debugVoronoiSeedsEnabled}
                    onChange={() => onChange({ debugVoronoiSeedsEnabled: !settings.debugVoronoiSeedsEnabled })}
                    label="Seed Markers"
                />
            </div>

            <div className="rounded-md border px-2.5 py-2 text-[11px] leading-snug" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-0), transparent 6%)', color: 'var(--text-muted)' }}>
                <div className="space-y-1">
                    <div>Fixed rules: {AUTO_BRACING_HARD_RULES.braceAngleDeg}° brace angle, min group size {AUTO_BRACING_HARD_RULES.minGroupSize}, and {AUTO_BRACING_HARD_RULES.minAxisSeparationDeg}° min axis separation.</div>
                    <div>Value limits: dia {AUTO_BRACING_CONSTRAINTS.braceDiameterMm.min}–{AUTO_BRACING_CONSTRAINTS.braceDiameterMm.max}, dist {AUTO_BRACING_CONSTRAINTS.maxBraceLengthMm.min}–{AUTO_BRACING_CONSTRAINTS.maxBraceLengthMm.max} mm.</div>
                </div>
            </div>

            {status && (
                <div
                    className="rounded-md border px-2.5 py-2 text-[11px] leading-snug"
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
