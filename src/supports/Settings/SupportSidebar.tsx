"use client";


import React, { useState, useEffect } from 'react';
import { Save, RotateCcw } from 'lucide-react';
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
import { Button } from '@/components/ui/primitives';
import { NumberInput } from '@/components/ui/NumberInput';
import { SupportAnatomyPreviewSlot } from './AnatomyPreview/SupportAnatomyPreviewSlot';
import { setAnatomyPreviewActiveSettingKey, setAnatomyPreviewShowTuner, subscribeToAnatomyPreviewState, getAnatomyPreviewState } from './AnatomyPreview/previewState';
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
    const [baseViewportScale, setBaseViewportScale] = useState(1);
    const [appliedCompactScale, setAppliedCompactScale] = useState(1);
    const [isCompactLayout, setIsCompactLayout] = useState(false);
    const viewportRef = React.useRef<HTMLDivElement | null>(null);
    const contentRef = React.useRef<HTMLDivElement | null>(null);
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

    const deriveViewportBaseScale = React.useCallback((viewportWidth: number, viewportHeight: number, contentHeight: number) => {
        let nextScale = 1;

        // Width-led compact tiers (panel-local, not full window)
        if (viewportWidth <= 410) nextScale = 0.97;
        if (viewportWidth <= 390) nextScale = 0.94;
        if (viewportWidth <= 370) nextScale = 0.91;
        if (viewportWidth <= 350) nextScale = 0.88;
        if (viewportWidth <= 330) nextScale = 0.84;
        if (viewportWidth <= 312) nextScale = 0.8;

        // Height pressure only matters when genuinely short
        if (viewportHeight <= 960) nextScale = Math.min(nextScale, 0.95);
        if (viewportHeight <= 860) nextScale = Math.min(nextScale, 0.9);
        if (viewportHeight <= 760) nextScale = Math.min(nextScale, 0.86);
        if (viewportHeight <= 680) nextScale = Math.min(nextScale, 0.8);

        // If there is meaningful vertical slack, recover readability (except on very small panes).
        const verticalSlack = viewportHeight - contentHeight;
        const isVerySmallPane = viewportWidth <= 335 || viewportHeight <= 700;
        if (!isVerySmallPane && verticalSlack > 120) {
            nextScale = Math.min(1, nextScale + 0.07);
        }
        if (!isVerySmallPane && verticalSlack > 220) {
            nextScale = Math.min(1, nextScale + 0.05);
        }

        // Tall+narrow columns should keep larger fonts when possible.
        const isTallNarrow = viewportHeight / Math.max(viewportWidth, 1) >= 1.9;
        if (isTallNarrow) {
            nextScale = Math.max(nextScale, 0.9);
        }

        return nextScale;
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

    React.useLayoutEffect(() => {
        const viewportEl = viewportRef.current;
        const contentEl = contentRef.current;
        if (!viewportEl || !contentEl) return;

        const computeFitScale = () => {
            const viewportWidth = viewportEl.clientWidth;
            const viewportHeight = viewportEl.clientHeight;
            const contentWidth = contentEl.scrollWidth;
            const contentHeight = contentEl.scrollHeight;

            if (viewportWidth <= 0 || viewportHeight <= 0 || contentWidth <= 0 || contentHeight <= 0) return;

            const fitWidthScale = viewportWidth / contentWidth;
            const fitHeightSafety = viewportHeight <= 950 ? 10 : 6;
            const fitHeightScale = Math.max(0.45, (viewportHeight - fitHeightSafety) / contentHeight);
            const fitScale = Math.min(1, fitWidthScale, fitHeightScale);
            const nextBaseScale = deriveViewportBaseScale(viewportWidth, viewportHeight, contentHeight);

            let windowScaleCap = 1;
            if (typeof window !== 'undefined') {
                const vw = window.innerWidth;
                const vh = window.innerHeight;
                if (vw <= 2000 || vh <= 950) windowScaleCap = 0.88;
                if (vw <= 1850 || vh <= 900) windowScaleCap = 0.84;
                if (vw <= 1700 || vh <= 840) windowScaleCap = 0.8;
            }

            if (Math.abs(nextBaseScale - baseViewportScale) > 0.01) {
                setBaseViewportScale(nextBaseScale);
            }

            const minScaleFloor = viewportWidth <= 320 || viewportHeight <= 660
                ? 0.54
                : viewportWidth <= 350 || viewportHeight <= 740
                    ? 0.58
                    : 0.64;

            const nextScale = Math.max(minScaleFloor, Math.min(nextBaseScale, fitScale, windowScaleCap));
            const nextCompactLayout = nextScale < 0.9 || viewportHeight <= 880;

            if (Math.abs(nextScale - appliedCompactScale) > 0.01) {
                setAppliedCompactScale(nextScale);
            }

            setIsCompactLayout((prev) => (prev === nextCompactLayout ? prev : nextCompactLayout));
        };

        computeFitScale();
        const observer = new ResizeObserver(() => {
            computeFitScale();
        });
        observer.observe(viewportEl);
        observer.observe(contentEl);

        return () => {
            observer.disconnect();
        };
    }, [activeKind, appliedCompactScale, baseViewportScale, deriveViewportBaseScale]);

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
                    borderColor: 'var(--accent)',
                    '--tw-ring-color': 'var(--accent)',
                } as React.CSSProperties
            };
        }
        return { className: baseClass };
    };

    const compactInputClass = 'ui-input w-full h-[36px] px-3 py-2 text-base no-spinners';
    const renderPreviewBox = (heightClass: string, widthClass: string = 'w-full') => (
        <div
            data-no-drag="true"
            className={`relative ${widthClass} ${heightClass} rounded-md border overflow-hidden`}
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
        >
            <div className="absolute bottom-2.5 left-2.5 z-20">
                <button
                    type="button"
                    onClick={() => setAnatomyPreviewShowTuner(!previewState.showTuner)}
                    className="rounded-md border px-3 py-1.5 text-[12px] font-semibold transition-colors"
                    style={{
                        borderColor: previewState.showTuner ? 'var(--accent)' : 'var(--border-subtle)',
                        background: previewState.showTuner
                            ? 'color-mix(in srgb, var(--accent), var(--surface-0) 74%)'
                            : 'color-mix(in srgb, var(--surface-0), transparent 8%)',
                        color: previewState.showTuner ? 'var(--text-strong)' : 'var(--text-strong)',
                    }}
                    title="Toggle Anatomy Preview Tuner"
                >
                    Tuner
                </button>
            </div>
            <SupportAnatomyPreviewSlot />
        </div>
    );

    return (
        <div ref={viewportRef} className="h-full w-full overflow-hidden">
            <div
                ref={contentRef}
                className="h-full w-full flex flex-col"
                style={{
                    transform: `scale(${appliedCompactScale})`,
                    transformOrigin: 'top left',
                    width: `${100 / appliedCompactScale}%`,
                    height: `${100 / appliedCompactScale}%`,
                }}
            >
            <div className="px-2.5 py-2">
                <SupportKindTabs
                    value={activeKind}
                    onChange={(kind) => {
                        setAnatomyPreviewActiveSettingKey(null);
                        setActiveSupportKind(kind);
                    }}
                />
            </div>

            <div className="flex-1 min-h-0 overflow-hidden px-2.5 pb-3 pt-2 space-y-2.5">
                {activeKind === 'raft' ? (
                    <div className="space-y-2.5">
                        {renderPreviewBox('h-[212px]')}
                        <div className="rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                            <RaftSettingsCard
                                settings={raftSettings}
                                onChange={(partial) => updateRaftSettings(partial)}
                            />
                        </div>
                    </div>
                ) : activeKind === 'grid' ? (
                    <div className="space-y-2.5">
                        <div className="flex gap-2.5">
                            {renderPreviewBox('h-auto min-h-[220px]', 'flex-1 min-w-0')}
                            <div className="flex-1 min-w-0 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                                <GridSettingsCard
                                    grid={settings.grid}
                                    onChange={(partial) => updateGridSettings(partial)}
                                />
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="space-y-2.5">
                        <div className="flex gap-2.5">
                            {renderPreviewBox('h-auto min-h-[340px]', 'flex-1 min-w-0')}

                            <div className="flex-1 min-w-0 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                            <div className="space-y-2">
                                <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                                    Support Geometry
                                </div>

                                <div className="space-y-2 items-start">
                                    <div className="space-y-1 min-w-0" {...makeRowFocusHandlers('tip.contactDiameterMm')}>
                                        <div className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>Contact diameter</div>
                                        <NumberInput
                                            value={settings.tip.contactDiameterMm}
                                            onChange={(val) => updateTipProfile({ contactDiameterMm: val })}
                                            {...getInputProps(
                                                'tip.contactDiameterMm',
                                                compactInputClass
                                            )}
                                        />
                                    </div>

                                    {(activeKind === 'trunk' || activeKind === 'branch' || activeKind === 'leaf' || activeKind === 'stick') && (
                                        <div className="space-y-1 min-w-0" {...makeRowFocusHandlers('tip.lengthMm')}>
                                            <div className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>Contact cone length</div>
                                            <NumberInput
                                                value={settings.tip.lengthMm}
                                                onChange={(val) => updateTipProfile({ lengthMm: val })}
                                                {...getInputProps(
                                                    'tip.lengthMm',
                                                    compactInputClass
                                                )}
                                            />
                                        </div>
                                    )}

                                    {(activeKind === 'trunk' || activeKind === 'branch' || activeKind === 'leaf' || activeKind === 'stick') && (
                                        <div className="space-y-1 min-w-0" {...makeRowFocusHandlers('tip.coneAngleMode')}>
                                            <div
                                                className={
                                                    isAdaptiveConeAngle
                                                        ? 'grid grid-cols-[1fr_72px] gap-1 items-center'
                                                        : 'flex items-center'
                                                }
                                            >
                                                <div className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>Cone control angle</div>
                                                {isAdaptiveConeAngle && (
                                                    <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Offset (deg)</div>
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
                                                    className={`${isAdaptiveConeAngle ? 'w-full' : 'flex-1'} min-w-0 ui-input h-[36px] px-3 py-2 text-base truncate`}
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
                                                        className={compactInputClass}
                                                    />
                                                )}
                                            </div>
                                        </div>
                                    )}

                                    {(activeKind === 'trunk' || activeKind === 'branch' || activeKind === 'stick') && (
                                        <div className="space-y-1 min-w-0" {...makeRowFocusHandlers('shaft.diameterMm')}>
                                            <div className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>
                                                {activeKind === 'stick' ? 'Stick diameter' : 'Trunk diameter'}
                                            </div>
                                            <NumberInput
                                                value={settings.shaft.diameterMm}
                                                onChange={(val) => updateShaftProfile({ diameterMm: val })}
                                                {...getInputProps(
                                                    'shaft.diameterMm',
                                                    compactInputClass
                                                )}
                                            />
                                        </div>
                                    )}

                                    {(activeKind === 'trunk' || activeKind === 'branch') && (
                                        <div className="space-y-1 min-w-0" {...makeRowFocusHandlers('joint.defaultJointCount')}>
                                            <div className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>Default joints</div>
                                            <NumberInput
                                                value={settings.joint.defaultJointCount}
                                                onChange={(val) => updateJointProfile({ defaultJointCount: val })}
                                                className={compactInputClass}
                                            />
                                        </div>
                                    )}

                                    {activeKind === 'trunk' && (
                                        <>
                                            <div className="pt-1" />

                                            <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Roots</div>

                                            <div className="space-y-1 min-w-0" {...makeRowFocusHandlers('roots.diameterMm')}>
                                                <div className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>Roots diameter</div>
                                                <NumberInput
                                                    value={settings.roots.diameterMm}
                                                    onChange={(val) => updateRootsProfile({ diameterMm: val })}
                                                    className={compactInputClass}
                                                />
                                            </div>

                                            <div className="space-y-1 min-w-0" {...makeRowFocusHandlers('roots.diskHeightMm')}>
                                                <div className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>Disk height</div>
                                                <NumberInput
                                                    value={settings.roots.diskHeightMm}
                                                    onChange={(val) => updateRootsProfile({ diskHeightMm: val })}
                                                    className={compactInputClass}
                                                />
                                            </div>

                                            <div className="space-y-1 min-w-0" {...makeRowFocusHandlers('roots.coneHeightMm')}>
                                                <div className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>Cone height</div>
                                                <NumberInput
                                                    value={settings.roots.coneHeightMm}
                                                    onChange={(val) => updateRootsProfile({ coneHeightMm: val })}
                                                    className={compactInputClass}
                                                />
                                            </div>
                                        </>
                                    )}
                                </div>
                            </div>
                            </div>
                        </div>
                    </div>
                )}

                {activeKind === 'trunk' && (
                    <div className="w-full overflow-hidden">
                        <div className="rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                            <PresetSelector />
                        </div>
                    </div>
                )}

                {activeKind === 'trunk' && !isCompactLayout && (
                    <div className="rounded-md p-2 border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                        <div className="text-[10px] font-semibold uppercase tracking-wide mb-1" style={{ color: 'var(--text-muted)' }}>Placement</div>
                        <p className="leading-tight">
                            Click model to place support. Tip aligns to surface, base drops to plate.
                        </p>
                    </div>
                )}
            </div>

            <div className="px-2 pt-1 pb-2">
                {saveStatus !== 'idle' && (
                    <div
                        className="mb-1 text-[10px]"
                        style={{ color: saveStatus === 'saved' ? '#34d399' : '#f87171' }}
                    >
                        {saveStatus === 'saved' ? 'Saved' : 'Save failed'}
                    </div>
                )}
                <div className="grid grid-cols-2 gap-1.5">
                    <Button type="button" onClick={handleSave} variant="primary" size="sm" className="w-full !h-10 !text-[12px] !font-semibold !inline-flex !items-center !justify-center !gap-2">
                        <Save className="h-3.5 w-3.5" />
                        <span>Save</span>
                    </Button>
                    <Button type="button" onClick={handleRestoreDefaults} variant="accent" size="sm" className="w-full !h-10 !text-[12px] !font-semibold !inline-flex !items-center !justify-center !gap-2">
                        <RotateCcw className="h-3.5 w-3.5" />
                        <span>Restore Defaults</span>
                    </Button>
                </div>
            </div>
            </div>
        </div>
    );
}
