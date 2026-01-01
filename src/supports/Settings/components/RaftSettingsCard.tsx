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

    return (
        <div className="bg-neutral-750 rounded p-1 mb-1">
            <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-neutral-300">Raft</span>
                <div className="flex items-center gap-1">
                    <select
                        value={settings.bottomMode}
                        onChange={(e) => onChange({ bottomMode: e.target.value as any })}
                        className="h-[18px] px-1 text-[10px] bg-neutral-900 text-neutral-200 rounded border border-neutral-700 focus:ring-1 focus:ring-blue-500"
                    >
                        <option value="off">Off</option>
                        <option value="solid">Solid</option>
                        <option value="line">Line</option>
                    </select>

                    <label className="flex items-center gap-2 cursor-pointer">
                        <span className="text-[9px] text-neutral-500 uppercase tracking-wide">wall</span>
                        <input
                            type="checkbox"
                            checked={settings.bottomMode === 'off' ? false : settings.wallEnabled}
                            disabled={settings.bottomMode === 'off'}
                            onChange={(e) => onChange({ wallEnabled: e.target.checked })}
                            className="w-3 h-3 rounded border-neutral-700 bg-neutral-900 text-blue-600 focus:ring-1 focus:ring-blue-500 disabled:opacity-40"
                        />
                    </label>
                </div>
            </div>

            {settings.bottomMode !== 'off' && (
                <div className="grid grid-cols-3 gap-1.5">
                    {settings.bottomMode === 'solid' && (
                        <>
                            <label className="flex flex-col gap-0.5" {...makeFocusHandlers('raft.thickness')}>
                                <span className="text-[9px] text-neutral-400">Thickness</span>
                                <NumberInput
                                    value={settings.thickness}
                                    onChange={(val) => onChange({ thickness: val })}
                                    className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                                />
                            </label>
                            <label className="flex flex-col gap-0.5" {...makeFocusHandlers('raft.chamferAngle')}>
                                <span className="text-[9px] text-neutral-400">Chamfer</span>
                                <NumberInput
                                    value={settings.chamferAngle}
                                    onChange={(val) => onChange({ chamferAngle: val })}
                                    className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                                />
                            </label>
                        </>
                    )}

                    {settings.bottomMode === 'line' && (
                        <>
                            <label className="flex flex-col gap-0.5" {...makeFocusHandlers('raft.lineWidthMm')}>
                                <span className="text-[9px] text-neutral-400">Line W</span>
                                <NumberInput
                                    value={settings.lineWidthMm}
                                    onChange={(val) => onChange({ lineWidthMm: val })}
                                    className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                                />
                            </label>
                            <label className="flex flex-col gap-0.5" {...makeFocusHandlers('raft.lineHeightMm')}>
                                <span className="text-[9px] text-neutral-400">Line H</span>
                                <NumberInput
                                    value={settings.lineHeightMm}
                                    onChange={(val) => onChange({ lineHeightMm: val })}
                                    className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                                />
                            </label>
                        </>
                    )}

                    {settings.wallEnabled && (
                        <>
                            <label className="flex flex-col gap-0.5" {...makeFocusHandlers('raft.wallHeight')}>
                                <span className="text-[9px] text-neutral-400">Wall H</span>
                                <NumberInput
                                    value={settings.wallHeight}
                                    onChange={(val) => onChange({ wallHeight: val })}
                                    className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                                />
                            </label>
                            <label className="flex flex-col gap-0.5" {...makeFocusHandlers('raft.wallThickness')}>
                                <span className="text-[9px] text-neutral-400">Wall T</span>
                                <NumberInput
                                    value={settings.wallThickness}
                                    onChange={(val) => onChange({ wallThickness: val })}
                                    className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                                />
                            </label>
                            <label className="flex flex-col gap-0.5" {...makeFocusHandlers('raft.crenulationGapWidth')}>
                                <span className="text-[9px] text-neutral-400">Gap W</span>
                                <NumberInput
                                    value={settings.crenulationGapWidth}
                                    onChange={(val) => onChange({ crenulationGapWidth: val })}
                                    className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                                />
                            </label>
                            <label className="flex flex-col gap-0.5">
                                <span className="text-[9px] text-neutral-400">Gap Space</span>
                                <NumberInput
                                    value={settings.crenulationSpacing}
                                    onChange={(val) => onChange({ crenulationSpacing: val })}
                                    className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                                />
                            </label>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
