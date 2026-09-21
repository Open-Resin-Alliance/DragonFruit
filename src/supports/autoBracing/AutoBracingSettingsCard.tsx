"use client";

import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { NumberInput } from '@/components/ui/NumberInput';
import { Button, Toast, ToastViewport } from '@/components/atoms';
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
const compactInputClass = 'ui-input w-full h-[36px] px-3 py-2 text-base text-center no-spinners !bg-[var(--surface-0)]';
const compactFieldLabelClass = 'text-[11px] font-medium leading-tight';
// Same active-state styling as the standard segmented selector (Cut Panel).
const activeModeStyle: React.CSSProperties = {
    borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 30%)',
    background: 'color-mix(in srgb, var(--accent), var(--surface-1) 85%)',
    color: 'var(--text-strong)',
};

export function AutoBracingSettingsCard({
    settings,
    onChange,
    onAutoBrace,
    status,
}: AutoBracingSettingsCardProps) {
    const { _ } = useLingui();
    // Zigzag chains step by their own rise, not the fixed interval — when
    // both patterns are zigzag the interval does nothing and is disabled.
    const intervalDisabled = settings.initialPattern === 'zigZag' && settings.repeatingPattern === 'zigZag';
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
                        label: pattern === 'singleDiagonal' ? 'Single Diagonal' : pattern === 'zigZag' ? 'Zig Zag' : 'Cross Diagonal',
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
                    <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }}>{_(msg`Brace Diameter`)}</div>
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
                    <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }}>{_(msg`Max Brace Distance`)}</div>
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
                    <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }}>{_(msg`Initial Distance`)}</div>
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
                <label className="space-y-1 min-w-0" style={intervalDisabled ? { opacity: 0.45 } : undefined}>
                    <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }}>{_(msg`Repeat Interval`)}</div>
                    <div className="relative" title={intervalDisabled ? _(msg`Zigzag chains step by their own rise — interval has no effect`) : undefined}>
                        <NumberInput
                            value={settings.patternIntervalMm}
                            onChange={(value) => onChange({ patternIntervalMm: value })}
                            step={0.1}
                            showStepper={false}
                            disabled={intervalDisabled}
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
                <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }}>{_(msg`Cluster Spacing`)}</div>
                <div className="grid grid-cols-3 gap-1.5">
                    {([['Low', 2], ['Mid', 5], ['High', 10]] as const).map(([label, value]) => {
                        const isActive = settings.seedSpacingMm === value;
                        return (
                            <button
                                key={label}
                                type="button"
                                className="ui-button ui-button-secondary !h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
                                style={isActive ? activeModeStyle : { background: 'var(--surface-0)' }}
                                onClick={() => onChange({ seedSpacingMm: value })}
                            >
                                {label}
                            </button>
                        );
                    })}
                </div>
            </label>

            {status && (
                <ToastViewport zIndex={126} offset="1.25rem">
                    <Toast
                        tone={status.kind === 'success' ? 'success' : status.kind === 'warning' ? 'warning' : 'error'}
                        animated
                        visible
                        className="flex items-center gap-2"
                    >
                        {status.message}
                    </Toast>
                </ToastViewport>
            )}

            <div className="h-2" />

            <button
                type="button"
                onClick={onAutoBrace}
                className="ui-button w-full !h-8 text-[11px]"
                style={{
                    borderColor: 'var(--accent)',
                    background: 'color-mix(in srgb, var(--accent), var(--surface-0) 86%)',
                    color: 'var(--accent)',
                }}
            >
                {_(msg`Apply Bracing`)}
            </button>
        </div>
    );
}
