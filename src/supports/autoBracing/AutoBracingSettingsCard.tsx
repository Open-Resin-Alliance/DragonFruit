"use client";

import React from 'react';
import { NumberInput } from '@/components/ui/NumberInput';
import { Button } from '@/components/ui/primitives';
import { SelectDropdown } from '@/components/ui/SelectDropdown';
import {
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

const unitHint = (unit: string) => (
    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>{unit}</span>
);
const compactInputClass = 'ui-input w-full h-[36px] px-3 py-2 text-base text-center no-spinners';
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
                        label: pattern === 'singleDiagonal' ? 'Single Diagonal' : 'Cross Diagonal',
                    }))}
                    className="min-w-0 space-y-0"
                    selectClassName="h-[36px] px-3 py-2 text-base"
                />
            </label>
        );
    };

    return (
        <div className="space-y-1.5">
            {/* Row 1: Brace Diameter | Max Brace Distance */}
            <div className="grid grid-cols-2 gap-1.5 items-start">
                <label className="space-y-1 min-w-0">
                    <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }}>Brace Diameter</div>
                    <div className="relative">
                        <NumberInput
                            value={settings.braceDiameterMm}
                            onChange={(value) => onChange({ braceDiameterMm: value })}
                            step={0.1}
                            showStepper={false}
                            className={compactInputClass}
                        />
                        {unitHint('mm')}
                    </div>
                </label>
                <label className="space-y-1 min-w-0">
                    <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }}>Max Brace Distance</div>
                    <div className="relative">
                        <NumberInput
                            value={settings.maxBraceLengthMm}
                            onChange={(value) => onChange({ maxBraceLengthMm: value })}
                            step={0.1}
                            showStepper={false}
                            className={compactInputClass}
                        />
                        {unitHint('mm')}
                    </div>
                </label>
            </div>

            {/* Row 2: Initial Distance | Repeat Interval */}
            <div className="grid grid-cols-2 gap-1.5 items-start">
                <label className="space-y-1 min-w-0">
                    <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }}>Initial Distance</div>
                    <div className="relative">
                        <NumberInput
                            value={settings.initialDistanceMm}
                            onChange={(value) => onChange({ initialDistanceMm: value })}
                            step={0.1}
                            showStepper={false}
                            className={compactInputClass}
                        />
                        {unitHint('mm')}
                    </div>
                </label>
                <label className="space-y-1 min-w-0">
                    <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }}>Repeat Interval</div>
                    <div className="relative">
                        <NumberInput
                            value={settings.patternIntervalMm}
                            onChange={(value) => onChange({ patternIntervalMm: value })}
                            step={0.1}
                            showStepper={false}
                            className={compactInputClass}
                        />
                        {unitHint('mm')}
                    </div>
                </label>
            </div>

            {/* Row 3: Initial Pattern | Repeating Pattern */}
            <div className="grid grid-cols-2 gap-1.5 items-start">
                {renderPatternSelect('Initial Pattern', settings.initialPattern, (initialPattern) => onChange({ initialPattern }))}
                {renderPatternSelect('Repeating Pattern', settings.repeatingPattern, (repeatingPattern) => onChange({ repeatingPattern }))}
            </div>

            {/* Row 4: Seed Spacing (full width) */}
            <label className="space-y-1 min-w-0">
                <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }}>Cluster Spacing</div>
                <div className="grid grid-cols-3 gap-1.5">
                    {([['Low', 2], ['Mid', 5], ['High', 10]] as const).map(([label, value]) => {
                        const isActive = settings.seedSpacingMm === value;
                        return (
                            <button
                                key={label}
                                type="button"
                                className="h-9 rounded-md border text-[12px] font-semibold transition-colors"
                                style={isActive
                                    ? {
                                        borderColor: 'color-mix(in srgb, var(--accent), white 10%)',
                                        background: 'color-mix(in srgb, var(--accent), var(--surface-1) 84%)',
                                        color: 'color-mix(in srgb, var(--accent), var(--text-strong) 25%)',
                                    }
                                    : {
                                        borderColor: 'var(--border-subtle)',
                                        background: 'var(--surface-1)',
                                        color: 'var(--text-muted)',
                                    }}
                                onClick={() => onChange({ seedSpacingMm: value })}
                            >
                                {label}
                            </button>
                        );
                    })}
                </div>
            </label>

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

            <div className="h-2" />

            <button
                type="button"
                onClick={onAutoBrace}
                className="w-full !h-10 rounded-md border px-3 text-[12px] font-semibold inline-flex items-center justify-center gap-2 transition-colors"
                style={{
                    borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 30%)',
                    background: 'color-mix(in srgb, var(--accent), var(--surface-1) 86%)',
                    color: 'var(--accent)',
                }}
            >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14.5 3.5 12 6l2.5 2.5L17 6l-2.5-2.5z" />
                    <path d="M9.5 14.5 7 17l2.5 2.5L12 17l-2.5-2.5z" />
                    <path d="M15 13l-3 3 2 2 3-3-2-2z" />
                    <path d="M6 8l-3 3 2 2 3-3-2-2z" />
                    <path d="M8 6l2-2" />
                    <path d="M16 16l2 2" />
                </svg>
                Apply Auto Brace
            </button>
        </div>
    );
}
