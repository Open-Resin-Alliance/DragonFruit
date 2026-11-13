"use client";

import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { Trash2, WandSparkles } from 'lucide-react';
import { NumberInput } from '@/components/ui/NumberInput';
import { Button, Toast, ToastViewport } from '@/components/atoms';
import { CENTERED_SELECT_PADDING, SelectDropdown } from '@/components/ui/SelectDropdown';
import {
    AUTO_BRACING_PATTERN_OPTIONS,
    type AutoBracingSettings,
    type AutoBracingPattern,
} from './settings';

interface AutoBracingSettingsCardProps {
    settings: AutoBracingSettings;
    onChange: (patch: Partial<AutoBracingSettings>) => void;
    onAutoBrace: () => void;
    /** Removes every brace of the model the Studio is working on. */
    onClearBraces: () => void;
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
    onClearBraces,
    status,
}: AutoBracingSettingsCardProps) {
    const { _ } = useLingui();
    // Initial zigzag climbs continuously to maxZ without discrete repeating tiers,
    // so both Repeating Pattern and Repeat Interval have no effect when initialPattern === 'zigZag'.
    const repeatingDisabled = settings.initialPattern === 'zigZag';
    const repeatingDisabledTitle = repeatingDisabled
        ? _(msg`Initial Zig Zag climbs continuously to the top — repeating tiers have no effect`)
        : undefined;

    const renderPatternSelect = (
        label: string,
        value: AutoBracingPattern,
        onPatternChange: (pattern: AutoBracingPattern) => void,
        disabled = false,
        title?: string,
    ) => {
        return (
            <label className="space-y-1 min-w-0" style={disabled ? { opacity: 0.45 } : undefined} title={title}>
                <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }}>{label}</div>
                <SelectDropdown
                    value={value}
                    onChange={(nextValue) => onPatternChange(nextValue as AutoBracingPattern)}
                    disabled={disabled}
                    title={title}
                    options={AUTO_BRACING_PATTERN_OPTIONS.map((pattern) => ({
                        value: pattern,
                        label: pattern === 'singleDiagonal' ? _(msg`Single Diagonal`) : pattern === 'zigZag' ? _(msg`Zig Zag`) : _(msg`Crosses`),
                    }))}
                    className="min-w-0 space-y-0"
                    selectClassName="h-[36px] py-2 text-base"
                    // Same centring as the Auto Support panel's preset selector:
                    // equal insets either side of the label, so it sits on the
                    // control's centre instead of clear of the chevron.
                    selectStyle={CENTERED_SELECT_PADDING}
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
                <label className="space-y-1 min-w-0" style={repeatingDisabled ? { opacity: 0.45 } : undefined}>
                    <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }}>{_(msg`Repeat Interval`)}</div>
                    <div className="relative" title={repeatingDisabledTitle}>
                        <NumberInput
                            value={settings.patternIntervalMm}
                            onChange={(value) => onChange({ patternIntervalMm: value })}
                            step={0.1}
                            showStepper={false}
                            disabled={repeatingDisabled}
                            className={compactInputClass}
                        />
                        {unitHint('mm')}
                    </div>
                </label>
            </div>

            {/* Row 3: Initial Pattern | Repeating Pattern */}
            <div className="grid grid-cols-2 gap-1.5 items-start">
                {renderPatternSelect(_(msg`Initial Pattern`), settings.initialPattern, (initialPattern) => onChange({ initialPattern }))}
                {renderPatternSelect(
                    _(msg`Repeating Pattern`),
                    settings.repeatingPattern,
                    (repeatingPattern) => onChange({ repeatingPattern }),
                    repeatingDisabled,
                    repeatingDisabledTitle,
                )}
            </div>

            {/* Row 4: Seed Spacing (full width) */}
            <label className="space-y-1 min-w-0">
                <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }}>{_(msg`Cluster Spacing`)}</div>
                <div className="grid grid-cols-3 gap-1.5">
                    {([
                        [msg({ message: 'Low', context: 'Cluster spacing' }), 2],
                        [msg({ message: 'Mid', context: 'Cluster spacing' }), 5],
                        [msg({ message: 'High', context: 'Cluster spacing' }), 10],
                    ] as const).map(([label, value]) => {
                        const isActive = settings.seedSpacingMm === value;
                        return (
                            <Button
                                key={value}
                                variant="secondary"
                                size="auto"
                                className="!h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
                                style={isActive ? activeModeStyle : { background: 'var(--surface-0)' }}
                                onClick={() => onChange({ seedSpacingMm: value })}
                            >
                                {_(label)}
                            </Button>
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

            <div className="flex items-stretch gap-1.5">
                <Button
                    size="auto"
                    onClick={onAutoBrace}
                    className="flex flex-1 items-center justify-center gap-1 !h-8 text-[11px]"
                    style={{
                        borderColor: 'var(--accent)',
                        background: 'color-mix(in srgb, var(--accent), var(--surface-0) 86%)',
                        color: 'var(--accent)',
                    }}
                >
                    <WandSparkles className="h-3.5 w-3.5 shrink-0" />
                    {_(msg`Apply`)}
                </Button>
                <Button
                    size="auto"
                    onClick={onClearBraces}
                    className="flex flex-1 items-center justify-center gap-1 !h-8 text-[11px]"
                    style={{
                        borderColor: 'color-mix(in srgb, var(--danger), var(--border-subtle) 40%)',
                        background: 'color-mix(in srgb, var(--danger), var(--surface-0) 88%)',
                        color: 'var(--danger)',
                    }}
                >
                    <Trash2 className="h-3.5 w-3.5 shrink-0" />
                    {_(msg`Clear All`)}
                </Button>
            </div>
        </div>
    );
}
