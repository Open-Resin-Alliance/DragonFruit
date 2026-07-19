"use client";

import React from 'react';
import { NumberInput } from '@/components/ui/NumberInput';
import {
    AUTO_SUPPORT_CONSTRAINTS,
    type AutoSupportSettings,
} from './settings';

interface AutoSupportSettingsCardProps {
    settings: AutoSupportSettings;
    onChange: (patch: Partial<AutoSupportSettings>) => void;
    onAutoSupport: () => void;
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

export function AutoSupportSettingsCard({
    settings,
    onChange,
    onAutoSupport,
    status,
}: AutoSupportSettingsCardProps) {
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

    return (
        <div className="space-y-1.5">
            {/* Row 0: Enabled Toggle | Prioritize Intersection */}
            <div className="grid grid-cols-2 gap-1.5 items-start">
                <ToggleButton
                    checked={settings.enabled}
                    onChange={() => onChange({ enabled: !settings.enabled })}
                    label="Auto-Support"
                />
                <ToggleButton
                    checked={settings.prioritizeIntersection}
                    onChange={() => onChange({ prioritizeIntersection: !settings.prioritizeIntersection })}
                    label="Prioritize Both"
                />
            </div>

            {/* Row 1: Min Island Area | Tip Influence Radius */}
            <div className="grid grid-cols-2 gap-1.5 items-start">
                <label className="space-y-1 min-w-0">
                    <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }}>Min Island Area</div>
                    <div className="relative">
                        <NumberInput
                            value={settings.minIslandAreaMm2}
                            onChange={(value) => onChange({ minIslandAreaMm2: value })}
                            step={0.01}
                            showStepper={false}
                            className={compactInputClass}
                        />
                        {unitHint('mm²')}
                    </div>
                </label>
                <label className="space-y-1 min-w-0">
                    <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }}>Tip Influence</div>
                    <div className="relative">
                        <NumberInput
                            value={settings.tipInfluenceRadiusMm}
                            onChange={(value) => onChange({ tipInfluenceRadiusMm: value })}
                            step={0.1}
                            showStepper={false}
                            className={compactInputClass}
                        />
                        {unitHint('mm')}
                    </div>
                </label>
            </div>

            {/* Row 2: Cluster Radius | Min Trunk Separation */}
            <div className="grid grid-cols-2 gap-1.5 items-start">
                <label className="space-y-1 min-w-0">
                    <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }}>Cluster Radius</div>
                    <div className="relative">
                        <NumberInput
                            value={settings.clusterRadiusMm}
                            onChange={(value) => onChange({ clusterRadiusMm: value })}
                            step={0.5}
                            showStepper={false}
                            className={compactInputClass}
                        />
                        {unitHint('mm')}
                    </div>
                </label>
                <label className="space-y-1 min-w-0">
                    <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }}>Min Separation</div>
                    <div className="relative">
                        <NumberInput
                            value={settings.minTrunkSeparationMm}
                            onChange={(value) => onChange({ minTrunkSeparationMm: value })}
                            step={0.5}
                            showStepper={false}
                            className={compactInputClass}
                        />
                        {unitHint('mm')}
                    </div>
                </label>
            </div>

            {/* Row 3: Max Branch Reach | Max Branch Angle */}
            <div className="grid grid-cols-2 gap-1.5 items-start">
                <label className="space-y-1 min-w-0">
                    <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }}>Max Branch Reach</div>
                    <div className="relative">
                        <NumberInput
                            value={settings.maxBranchReachMm}
                            onChange={(value) => onChange({ maxBranchReachMm: value })}
                            step={0.5}
                            showStepper={false}
                            className={compactInputClass}
                        />
                        {unitHint('mm')}
                    </div>
                </label>
                <label className="space-y-1 min-w-0">
                    <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }}>Max Branch Angle</div>
                    <div className="relative">
                        <NumberInput
                            value={settings.maxBranchAngleDeg}
                            onChange={(value) => onChange({ maxBranchAngleDeg: value })}
                            step={1}
                            showStepper={false}
                            className={compactInputClass}
                        />
                        {unitHint('°')}
                    </div>
                </label>
            </div>

            {/* Row 5: Density Factor */}
            <label className="space-y-1 min-w-0">
                <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }}>Density Factor</div>
                <div className="relative">
                    <NumberInput
                        value={settings.densityFactor}
                        onChange={(value) => onChange({ densityFactor: value })}
                        step={0.1}
                        showStepper={false}
                        className={compactInputClass}
                    />
                    {unitHint('×')}
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
                onClick={onAutoSupport}
                className="w-full !h-10 rounded-md border px-3 text-[12px] font-semibold inline-flex items-center justify-center gap-2 transition-colors"
                style={{
                    borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 30%)',
                    background: 'color-mix(in srgb, var(--accent), var(--surface-1) 86%)',
                    color: 'var(--accent)',
                }}
            >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                </svg>
                Run Auto-Support
            </button>
        </div>
    );
}
