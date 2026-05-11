"use client";

import React from 'react';
import { RaftSettings } from '../../Rafts/Crenelated/RaftTypes';
import { NumberInput } from '@/components/ui/NumberInput';
import { SelectDropdown } from '@/components/ui/SelectDropdown';
import { setAnatomyPreviewActiveSettingKey } from '../AnatomyPreview/previewState';

interface RaftSettingsCardProps {
    settings: RaftSettings;
    onChange: (settings: Partial<RaftSettings>) => void;
    activeModelId?: string | null;
    selectedModelIds?: string[];
}

export function RaftSettingsCard({ settings, onChange, activeModelId, selectedModelIds }: RaftSettingsCardProps) {
    if (!settings) return null;

    const makeFocusHandlers = React.useCallback((key: string) => {
        return {
            onFocusCapture: () => {
                setAnatomyPreviewActiveSettingKey(key);
            },
            onBlurCapture: (e: React.FocusEvent<HTMLElement>) => {
                const next = e.relatedTarget as Node | null;
                if (next && e.currentTarget.contains(next)) return;
                setAnatomyPreviewActiveSettingKey(null);
            },
        };
    }, []);

    const ModeButton = ({
        active,
        children,
        onClick,
        className = '',
    }: {
        active: boolean;
        children: React.ReactNode;
        onClick: () => void;
        className?: string;
    }) => (
        <button
            type="button"
            onClick={onClick}
            className={`min-h-[36px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors ${className}`}
            style={active
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
        >
            {children}
        </button>
    );

    const ToggleButton = ({
        checked,
        onChange,
        label,
        tone = 'primary',
    }: {
        checked: boolean;
        onChange: () => void;
        label: string;
        tone?: 'primary' | 'secondary';
    }) => (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            onClick={onChange}
            className="ui-input w-full h-[36px] px-2.5 leading-tight text-sm inline-flex items-center justify-between"
            style={checked
                ? {
                    borderColor: `color-mix(in srgb, ${tone === 'primary' ? 'var(--accent)' : 'var(--accent-secondary)'}, var(--border-subtle) 36%)`,
                    background: `color-mix(in srgb, ${tone === 'primary' ? 'var(--accent)' : 'var(--accent-secondary)'}, var(--surface-1) 90%)`,
                    color: tone === 'primary'
                        ? 'color-mix(in srgb, var(--accent), var(--text-strong) 25%)'
                        : 'color-mix(in srgb, var(--accent-secondary), var(--text-strong) 28%)',
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
                style={{ background: checked ? (tone === 'primary' ? 'var(--accent)' : 'var(--accent-secondary)') : 'var(--surface-2)' }}
            >
                <span className={`h-4 w-4 rounded-full bg-white transition-transform ${checked ? 'translate-x-4' : 'translate-x-0'}`} />
            </span>
        </button>
    );

    const compactInputClass = 'ui-input w-full h-[36px] px-3 py-2 text-base no-spinners';

    const isWallEnabled = settings.bottomMode === 'solid' && settings.wallEnabled;

    return (
        <div className="space-y-2.5">
            <div className="space-y-1.5">
                <div className="grid grid-cols-3 gap-1.5">
                    <ModeButton active={settings.bottomMode === 'off'} onClick={() => onChange({ bottomMode: 'off' })}>Off</ModeButton>
                    <ModeButton active={settings.bottomMode === 'solid'} onClick={() => onChange({ bottomMode: 'solid' })}>Solid</ModeButton>
                    <ModeButton active={settings.bottomMode === 'line'} onClick={() => onChange({ bottomMode: 'line' })}>Line</ModeButton>
                </div>
                {settings.bottomMode === 'solid' && (
                    <ToggleButton
                        checked={isWallEnabled}
                        onChange={() => onChange({ wallEnabled: !isWallEnabled })}
                        label="Wall"
                        tone="secondary"
                    />
                )}
            </div>

            {settings.bottomMode !== 'off' && (
                <div className="grid grid-cols-2 gap-1.5 items-start">
                    {settings.bottomMode === 'solid' && (
                        <>
                            <label className="flex flex-col gap-0.5" {...makeFocusHandlers('raft.thickness')}>
                                <span className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Thickness</span>
                                <NumberInput
                                    value={settings.thickness}
                                    onChange={(val) => onChange({ thickness: val })}
                                    step={0.1}
                                    className={compactInputClass}
                                />
                            </label>
                            <label className="flex flex-col gap-0.5" {...makeFocusHandlers('raft.chamferAngle')}>
                                <span className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Chamfer Angle</span>
                                <NumberInput
                                    value={settings.chamferAngle}
                                    onChange={(val) => onChange({ chamferAngle: val })}
                                    className={compactInputClass}
                                />
                            </label>
                        </>
                    )}

                    {settings.bottomMode === 'line' && (
                        <>
                            <label className="flex flex-col gap-0.5" {...makeFocusHandlers('raft.lineWidthMm')}>
                                <span className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Line Width</span>
                                <NumberInput
                                    value={settings.lineWidthMm}
                                    onChange={(val) => onChange({ lineWidthMm: val })}
                                    step={0.1}
                                    className={compactInputClass}
                                />
                            </label>
                            <label className="flex flex-col gap-0.5" {...makeFocusHandlers('raft.lineHeightMm')}>
                                <span className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Line Height</span>
                                <NumberInput
                                    value={settings.lineHeightMm}
                                    onChange={(val) => onChange({ lineHeightMm: val })}
                                    step={0.1}
                                    className={compactInputClass}
                                />
                            </label>
                        </>
                    )}

                    {isWallEnabled && (
                        <>
                            <label className="flex flex-col gap-0.5" {...makeFocusHandlers('raft.wallHeight')}>
                                <span className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Wall Height</span>
                                <NumberInput
                                    value={settings.wallHeight}
                                    onChange={(val) => onChange({ wallHeight: val })}
                                    step={0.1}
                                    className={compactInputClass}
                                />
                            </label>
                            <label className="flex flex-col gap-0.5" {...makeFocusHandlers('raft.wallThickness')}>
                                <span className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Wall Thickness</span>
                                <NumberInput
                                    value={settings.wallThickness}
                                    onChange={(val) => onChange({ wallThickness: val })}
                                    step={0.1}
                                    className={compactInputClass}
                                />
                            </label>
                            <label className="flex flex-col gap-0.5" {...makeFocusHandlers('raft.crenulationGapWidth')}>
                                <span className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Gap Width</span>
                                <NumberInput
                                    value={settings.crenulationGapWidth}
                                    onChange={(val) => onChange({ crenulationGapWidth: val })}
                                    step={0.1}
                                    className={compactInputClass}
                                />
                            </label>
                            <label className="flex flex-col gap-0.5" {...makeFocusHandlers('raft.crenulationSpacing')}>
                                <span className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Gap Spacing</span>
                                <NumberInput
                                    value={settings.crenulationSpacing}
                                    onChange={(val) => onChange({ crenulationSpacing: val })}
                                    step={0.1}
                                    className={compactInputClass}
                                />
                            </label>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
