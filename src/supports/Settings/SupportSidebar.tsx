"use client";


import React, { useState, useEffect } from 'react';
import { usePresetHotkeys } from '@/hotkeys/usePresetHotkeys';
import {
    getSettings,
    subscribeToSettings,
    saveSettingsToLocalStorage,
    loadSettingsFromLocalStorage,
    setSettings,
    updateTipProfile,
    updateShaftProfile,
    updateRootsProfile,
    updateJointProfile,
} from './state';
import { checkPresetDrift } from './presets';
import { createDefaultSettings } from './types';
import {
    PresetSelector,
    RaftSettingsCard,
    GridSettingsCard,
    SupportKindTabs,
} from './components';
import { NumberInput } from '@/components/ui/NumberInput';
import { SupportAnatomyPreviewSlot } from './AnatomyPreview/SupportAnatomyPreviewSlot';
import { setAnatomyPreviewActiveSettingKey, subscribeToAnatomyPreviewState, getAnatomyPreviewState } from './AnatomyPreview/previewState';
import {
    getSupportKindSnapshot,
    setActiveSupportKind,
    subscribeToSupportKindState,
} from './supportKindState';
import {
    getRaftSettings,
    subscribeToRaftStore,
    setRaftSettings,
    updateRaftSettings,
} from '../Rafts/Crenelated/RaftState';
import { updateGridSettings } from './state';
import { DEFAULT_RAFT_SETTINGS } from '../Rafts/Crenelated/RaftDefaults';

/**
 * SupportSidebar
 * 
 * Main settings panel for support mode.
 * Displays presets and editable settings for tip, shaft, roots, base flare, and grid.
 */
export function SupportSidebar() {
    usePresetHotkeys();
    const [settings, setLocalSettings] = useState(() => getSettings());
    const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
    const isAdaptiveConeAngle = (settings.tip.coneAngleMode ?? 'normal') === 'adaptive';
    const supportKindState = React.useSyncExternalStore(subscribeToSupportKindState, getSupportKindSnapshot, getSupportKindSnapshot);
    const activeKind = supportKindState.kind;
    const raftSettings = React.useSyncExternalStore(subscribeToRaftStore, getRaftSettings, getRaftSettings);
    const previewState = React.useSyncExternalStore(subscribeToAnatomyPreviewState, getAnatomyPreviewState, getAnatomyPreviewState);
    const activeKey = previewState.activeSettingKey;

    const makeRowFocusHandlers = React.useCallback((key: string) => {
        return {
            onFocusCapture: () => {
                setAnatomyPreviewActiveSettingKey(key);
            },
            onBlurCapture: (e: React.FocusEvent<HTMLDivElement>) => {
                const next = e.relatedTarget as Node | null;
                if (next && e.currentTarget.contains(next)) return;
                setAnatomyPreviewActiveSettingKey(null);
            },
        };
    }, []);

    useEffect(() => {
        const RAFT_STORAGE_KEY = 'raft-settings';

        loadSettingsFromLocalStorage();
        try {
            const storedRaft = localStorage.getItem(RAFT_STORAGE_KEY);
            if (storedRaft) {
                const parsed = JSON.parse(storedRaft);
                setRaftSettings(parsed);
            }
        } catch (err) {
            console.error('[SupportSidebar] Failed to load raft settings:', err);
        }

        setLocalSettings(getSettings());

        const unsubscribeSettings = subscribeToSettings(() => {
            const current = getSettings();
            setLocalSettings(current);
            checkPresetDrift(current);
        });
        return () => {
            unsubscribeSettings();
        };
    }, []);

    const handleSave = React.useCallback(() => {
        const RAFT_STORAGE_KEY = 'raft-settings';
        setSaveStatus('idle');

        try {
            saveSettingsToLocalStorage();
            localStorage.setItem(RAFT_STORAGE_KEY, JSON.stringify(getRaftSettings()));
            setSaveStatus('saved');
        } catch (err) {
            console.error('[SupportSidebar] Failed to save settings:', err);
            setSaveStatus('error');
        }

        window.setTimeout(() => {
            setSaveStatus('idle');
        }, 2000);
    }, []);

    const handleRestoreDefaults = React.useCallback(() => {
        const RAFT_STORAGE_KEY = 'raft-settings';
        try {
            localStorage.removeItem('support-settings');
            localStorage.removeItem(RAFT_STORAGE_KEY);
        } catch (err) {
            console.error('[SupportSidebar] Failed to clear saved settings:', err);
        }

        setSettings(createDefaultSettings());
        setRaftSettings(DEFAULT_RAFT_SETTINGS);
        setAnatomyPreviewActiveSettingKey(null);
    }, []);

    const getInputProps = (key: string, baseClass: string) => {
        const isActive = activeKey === key;
        if (isActive) {
            return {
                className: `${baseClass} ring-2`,
                style: {
                    borderColor: '#FD5290',
                    '--tw-ring-color': '#FD5290',
                } as React.CSSProperties
            };
        }
        return { className: baseClass };
    };

    return (
        <div className="h-full w-full flex flex-col">
            <div className="px-1 py-1 border-b border-neutral-800">
                <SupportKindTabs
                    value={activeKind}
                    onChange={(kind) => {
                        setAnatomyPreviewActiveSettingKey(null);
                        setActiveSupportKind(kind);
                    }}
                />
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-1 pb-24 pt-2 space-y-2">
                {activeKind === 'raft' ? (
                    <div className="space-y-2">
                        <div className="w-full h-[300px] bg-transparent border border-neutral-700 rounded overflow-hidden">
                            <SupportAnatomyPreviewSlot />
                        </div>
                        <RaftSettingsCard
                            settings={raftSettings}
                            onChange={(partial) => updateRaftSettings(partial)}
                        />
                    </div>
                ) : activeKind === 'grid' ? (
                    <div className="space-y-2">
                        <div className="w-full h-[300px] bg-transparent border border-neutral-700 rounded overflow-hidden">
                            <SupportAnatomyPreviewSlot />
                        </div>
                        <GridSettingsCard
                            grid={settings.grid}
                            onChange={(partial) => updateGridSettings(partial)}
                        />
                    </div>
                ) : (
                    <div className="flex gap-1">
                        <div className="w-[110px] flex-shrink-0 bg-transparent border border-neutral-700 rounded overflow-hidden flex flex-col">
                            <SupportAnatomyPreviewSlot />
                        </div>

                        <div className="flex-1 min-w-0 px-0 py-0">
                            <div className="space-y-0.5">
                                <div className="text-[10px] font-semibold text-neutral-300 uppercase tracking-wide">Settings</div>

                                <div className="space-y-1">
                                    <div className="space-y-0.5" {...makeRowFocusHandlers('tip.contactDiameterMm')}>
                                        <div className="text-[9px] leading-none text-neutral-300">Contact diameter</div>
                                        <NumberInput
                                            value={settings.tip.contactDiameterMm}
                                            onChange={(val) => updateTipProfile({ contactDiameterMm: val })}
                                            {...getInputProps(
                                                'tip.contactDiameterMm',
                                                "w-full h-[22px] px-2 py-0 text-[11px] leading-none bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                                            )}
                                        />
                                    </div>

                                    {(activeKind === 'trunk' || activeKind === 'branch' || activeKind === 'leaf' || activeKind === 'stick') && (
                                        <div className="space-y-0.5" {...makeRowFocusHandlers('tip.lengthMm')}>
                                            <div className="text-[9px] leading-none text-neutral-300">Contact cone length</div>
                                            <NumberInput
                                                value={settings.tip.lengthMm}
                                                onChange={(val) => updateTipProfile({ lengthMm: val })}
                                                {...getInputProps(
                                                    'tip.lengthMm',
                                                    "w-full h-[22px] px-2 py-0 text-[11px] leading-none bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                                                )}
                                            />
                                        </div>
                                    )}

                                    {(activeKind === 'trunk' || activeKind === 'branch' || activeKind === 'leaf' || activeKind === 'stick') && (
                                        <div className="space-y-0.5" {...makeRowFocusHandlers('tip.coneAngleMode')}>
                                            <div
                                                className={
                                                    isAdaptiveConeAngle
                                                        ? 'grid grid-cols-[1fr_72px] gap-1 items-center'
                                                        : 'flex items-center'
                                                }
                                            >
                                                <div className="text-[9px] leading-none text-neutral-300">Cone Control Angle</div>
                                                {isAdaptiveConeAngle && (
                                                    <div className="text-[9px] leading-none text-neutral-400">Offset (deg)</div>
                                                )}
                                            </div>
                                            <div
                                                className={
                                                    isAdaptiveConeAngle
                                                        ? 'grid grid-cols-[1fr_72px] gap-1 items-center'
                                                        : 'flex items-center gap-1'
                                                }
                                            >
                                                <select
                                                    value={settings.tip.coneAngleMode ?? 'normal'}
                                                    onChange={(e) => updateTipProfile({ coneAngleMode: e.target.value as any })}
                                                    className={`${isAdaptiveConeAngle ? 'w-full' : 'flex-1'} min-w-0 h-[22px] px-1 py-0 text-[11px] leading-none bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none truncate`}
                                                >
                                                    <option value="normal">Normal</option>
                                                    <option value="locked">Locked</option>
                                                    <option value="adaptive">Adaptive</option>
                                                </select>

                                                {isAdaptiveConeAngle && (
                                                    <NumberInput
                                                        value={settings.tip.adaptiveConeAngleOffsetDeg ?? 30}
                                                        onChange={(val) => updateTipProfile({ adaptiveConeAngleOffsetDeg: val })}
                                                        aria-label="Adaptive offset (deg)"
                                                        title="Adaptive offset (deg)"
                                                        className="w-full h-[22px] px-2 py-0 text-[11px] leading-none bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                                                    />
                                                )}
                                            </div>
                                        </div>
                                    )}

                                    {(activeKind === 'trunk' || activeKind === 'branch' || activeKind === 'stick') && (
                                        <div className="space-y-0.5" {...makeRowFocusHandlers('shaft.diameterMm')}>
                                            <div className="text-[9px] leading-none text-neutral-300">Trunk diameter</div>
                                            <NumberInput
                                                value={settings.shaft.diameterMm}
                                                onChange={(val) => updateShaftProfile({ diameterMm: val })}
                                                {...getInputProps(
                                                    'shaft.diameterMm',
                                                    "w-full h-[22px] px-2 py-0 text-[11px] leading-none bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                                                )}
                                            />
                                        </div>
                                    )}

                                    {(activeKind === 'trunk' || activeKind === 'branch') && (
                                        <div className="space-y-0.5" {...makeRowFocusHandlers('joint.defaultJointCount')}>
                                            <div className="text-[9px] leading-none text-neutral-300">Default joints</div>
                                            <NumberInput
                                                value={settings.joint.defaultJointCount}
                                                onChange={(val) => updateJointProfile({ defaultJointCount: val })}
                                                className="w-full h-[22px] px-2 py-0 text-[11px] leading-none bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                                            />
                                        </div>
                                    )}

                                    {activeKind === 'trunk' && (
                                        <>
                                            <div className="pt-0.5 border-t border-neutral-700/60" />

                                            <div className="text-[10px] font-semibold text-neutral-300 uppercase tracking-wide">Roots</div>

                                            <div className="space-y-0.5" {...makeRowFocusHandlers('roots.diameterMm')}>
                                                <div className="text-[9px] leading-none text-neutral-300">Roots diameter</div>
                                                <NumberInput
                                                    value={settings.roots.diameterMm}
                                                    onChange={(val) => updateRootsProfile({ diameterMm: val })}
                                                    className="w-full h-[22px] px-2 py-0 text-[11px] leading-none bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                                                />
                                            </div>

                                            <div className="space-y-0.5" {...makeRowFocusHandlers('roots.diskHeightMm')}>
                                                <div className="text-[9px] leading-none text-neutral-300">Disk height</div>
                                                <NumberInput
                                                    value={settings.roots.diskHeightMm}
                                                    onChange={(val) => updateRootsProfile({ diskHeightMm: val })}
                                                    className="w-full h-[22px] px-2 py-0 text-[11px] leading-none bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                                                />
                                            </div>

                                            <div className="space-y-0.5" {...makeRowFocusHandlers('roots.coneHeightMm')}>
                                                <div className="text-[9px] leading-none text-neutral-300">Cone height</div>
                                                <NumberInput
                                                    value={settings.roots.coneHeightMm}
                                                    onChange={(val) => updateRootsProfile({ coneHeightMm: val })}
                                                    className="w-full h-[22px] px-2 py-0 text-[11px] leading-none bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                                                />
                                            </div>
                                        </>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {activeKind === 'trunk' && (
                    <div className="w-full overflow-hidden">
                        <div className="bg-neutral-900/40 rounded border border-neutral-700">
                            <PresetSelector />
                        </div>
                    </div>
                )}

                {activeKind === 'trunk' && (
                    <div className="text-[10px] text-neutral-400 bg-neutral-900/40 rounded p-1.5 border border-neutral-700">
                        <div className="font-medium text-neutral-300 mb-0.5">Placement</div>
                        <p className="leading-tight">
                            Click model to place support. Tip aligns to surface, base drops to plate.
                        </p>
                    </div>
                )}
            </div>

            <div className="px-1 pb-2">
                <div className="border-t border-neutral-800 pt-2 bg-neutral-900">
                    {saveStatus !== 'idle' && (
                        <div
                            className={
                                saveStatus === 'saved'
                                    ? 'mb-1 text-[10px] text-green-400'
                                    : 'mb-1 text-[10px] text-red-400'
                            }
                        >
                            {saveStatus === 'saved' ? 'Saved' : 'Save failed'}
                        </div>
                    )}
                    <div className="grid grid-cols-2 gap-1">
                        <button
                            type="button"
                            onClick={handleSave}
                            className="h-[28px] text-[11px] bg-neutral-800 text-neutral-200 rounded border border-neutral-700 hover:bg-neutral-700"
                        >
                            Save
                        </button>
                        <button
                            type="button"
                            onClick={handleRestoreDefaults}
                            className="h-[28px] text-[11px] bg-neutral-800 text-neutral-200 rounded border border-neutral-700 hover:bg-neutral-700"
                        >
                            Restore Defaults
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
