"use client";

import React from 'react';
import { RaftSettings } from '../../Rafts/Crenelated/RaftTypes';
import { NumberInput } from '@/components/ui/NumberInput';
import { setAnatomyPreviewActiveSettingKey } from '../AnatomyPreview/previewState';

interface RaftSettingsCardProps {
    settings: RaftSettings;
    onChange: (settings: Partial<RaftSettings>) => void;
}

export function RaftSettingsCard({ settings, onChange }: RaftSettingsCardProps) {
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

    const compactInputClass = 'ui-input w-full h-[36px] px-3 py-2 text-base no-spinners';

    return (
        <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Raft</span>
                <div className="flex items-center gap-2">
                    <select
                        value={settings.bottomMode}
                        onChange={(e) => onChange({ bottomMode: e.target.value as any })}
                        className="ui-input h-[36px] px-3 py-2 text-base"
                    >
                        <option value="off">Off</option>
                        <option value="solid">Solid</option>
                        <option value="line">Line</option>
                    </select>

                    <label className="flex items-center gap-2 cursor-pointer">
                        <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Wall</span>
                        <input
                            type="checkbox"
                            checked={settings.bottomMode === 'off' ? false : settings.wallEnabled}
                            disabled={settings.bottomMode === 'off'}
                            onChange={(e) => onChange({ wallEnabled: e.target.checked })}
                            className="ui-checkbox disabled:opacity-40"
                        />
                    </label>
                </div>
            </div>

            {settings.bottomMode !== 'off' && (
                <div className="grid grid-cols-2 gap-2 items-start">
                    {settings.bottomMode === 'solid' && (
                        <>
                            <label className="flex flex-col gap-0.5" {...makeFocusHandlers('raft.thickness')}>
                                <span className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>Thickness</span>
                                <NumberInput
                                    value={settings.thickness}
                                    onChange={(val) => onChange({ thickness: val })}
                                    className={compactInputClass}
                                />
                            </label>
                            <label className="flex flex-col gap-0.5" {...makeFocusHandlers('raft.chamferAngle')}>
                                <span className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>Chamfer angle</span>
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
                                <span className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>Line width</span>
                                <NumberInput
                                    value={settings.lineWidthMm}
                                    onChange={(val) => onChange({ lineWidthMm: val })}
                                    className={compactInputClass}
                                />
                            </label>
                            <label className="flex flex-col gap-0.5" {...makeFocusHandlers('raft.lineHeightMm')}>
                                <span className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>Line height</span>
                                <NumberInput
                                    value={settings.lineHeightMm}
                                    onChange={(val) => onChange({ lineHeightMm: val })}
                                    className={compactInputClass}
                                />
                            </label>
                        </>
                    )}

                    {settings.wallEnabled && (
                        <>
                            <label className="flex flex-col gap-0.5" {...makeFocusHandlers('raft.wallHeight')}>
                                <span className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>Wall height</span>
                                <NumberInput
                                    value={settings.wallHeight}
                                    onChange={(val) => onChange({ wallHeight: val })}
                                    className={compactInputClass}
                                />
                            </label>
                            <label className="flex flex-col gap-0.5" {...makeFocusHandlers('raft.wallThickness')}>
                                <span className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>Wall thickness</span>
                                <NumberInput
                                    value={settings.wallThickness}
                                    onChange={(val) => onChange({ wallThickness: val })}
                                    className={compactInputClass}
                                />
                            </label>
                            <label className="flex flex-col gap-0.5" {...makeFocusHandlers('raft.crenulationGapWidth')}>
                                <span className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>Gap width</span>
                                <NumberInput
                                    value={settings.crenulationGapWidth}
                                    onChange={(val) => onChange({ crenulationGapWidth: val })}
                                    className={compactInputClass}
                                />
                            </label>
                            <label className="flex flex-col gap-0.5" {...makeFocusHandlers('raft.crenulationSpacing')}>
                                <span className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>Gap spacing</span>
                                <NumberInput
                                    value={settings.crenulationSpacing}
                                    onChange={(val) => onChange({ crenulationSpacing: val })}
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
