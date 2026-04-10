"use client";


import React, { useState, useEffect, useSyncExternalStore } from 'react';
import { Save, RotateCcw, Sparkles, Wrench, WandSparkles, Sailboat, Grid3X3, Pickaxe } from 'lucide-react';
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
    updateGridSettings,
    updateAutoBracingSettings,
} from './state';
import {
    subscribe as subscribeToSupportState,
    getSnapshot as getSupportSnapshot,
    resolveEditableSupportTarget,
    getSupportSettingsForTarget,
    applySettingsToSupportTarget,
    type EditableSupportTarget,
} from '../state';
import { checkPresetDrift, findMatchingPresetIdForSettings, getPresetById } from './presets';
import { createDefaultSettings, type SupportSettings } from './types';
import { areSupportGeometrySettingsEqual } from './supportSettingsCodec';
import { captureSupportEditSnapshot, pushSupportEditHistory, type SupportEditHistorySnapshot } from '../history/supportEditHistory';
import {
    PresetSelector,
    RaftSettingsCard,
    GridSettingsCard,
    SupportKindTabs,
} from './components';
import { Button, Card, CardHeader, IconButton } from '@/components/ui/primitives';
import { NumberInput } from '@/components/ui/NumberInput';
import { SelectDropdown } from '@/components/ui/SelectDropdown';
import { SupportAnatomyPreviewSlot } from './AnatomyPreview/SupportAnatomyPreviewSlot';
import { AutoBracingSettingsCard } from '../autoBracing/AutoBracingSettingsCard';
import { CurveSettingsCard, getCurveSettingsSelection } from '../Curves/CurveSettingsCard';
import { runAutoBracing } from '../autoBracing/autoBrace';
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
import { DEFAULT_RAFT_SETTINGS } from '../Rafts/Crenelated/RaftDefaults';
import type { SupportKind } from './supportKindState';

const INPUT_CLASS = 'ui-input h-8 w-full px-2.5 text-xs sm:text-sm no-spinners';
const SECTION_CARD_STYLE: React.CSSProperties = {
    borderColor: 'var(--border-subtle)',
    background: 'var(--surface-1)',
};
const ACCENT_CARD_STYLE: React.CSSProperties = {
    borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 76%)',
    background: 'color-mix(in srgb, var(--accent), var(--surface-1) 95%)',
};

const KIND_META: Record<SupportKind, { label: string; icon: typeof Pickaxe }> = {
    trunk: { label: 'Trunk', icon: Pickaxe },
    branch: { label: 'Branch', icon: Wrench },
    leaf: { label: 'Leaf', icon: Sparkles },
    twig: { label: 'Twig', icon: WandSparkles },
    raft: { label: 'Raft', icon: Sailboat },
    grid: { label: 'Grid', icon: Grid3X3 },
    stick: { label: 'Bracing', icon: WandSparkles },
};

function normalizeTabKind(kind: SupportKind): SupportKind {
    if (kind === 'branch' || kind === 'leaf' || kind === 'twig') {
        return 'trunk';
    }
    return kind;
}

function hasMeaningfulSupportEditChange(
    before: SupportEditHistorySnapshot,
    after: SupportEditHistorySnapshot,
): boolean {
    const beforeSupport = {
        ...before.support,
        selectedId: null,
        selectedCategory: null,
        hoveredId: null,
        hoveredCategory: 'none' as const,
    };
    const afterSupport = {
        ...after.support,
        selectedId: null,
        selectedCategory: null,
        hoveredId: null,
        hoveredCategory: 'none' as const,
    };

    if (JSON.stringify(beforeSupport) !== JSON.stringify(afterSupport)) {
        return true;
    }

    const beforeKickstand = {
        ...before.kickstand,
        selectedId: null,
    };
    const afterKickstand = {
        ...after.kickstand,
        selectedId: null,
    };

    return JSON.stringify(beforeKickstand) !== JSON.stringify(afterKickstand);
}

function formatSupportKindLabel(kind: EditableSupportTarget['kind']): string {
    return `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
}

function Section({
    title,
    children,
    accent = false,
    className,
}: {
    title: string;
    children: React.ReactNode;
    accent?: boolean;
    className?: string;
}) {
    return (
        <div className={`rounded-md border p-2 ${className ?? ''}`} style={accent ? ACCENT_CARD_STYLE : SECTION_CARD_STYLE}>
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                {title}
            </div>
            {children}
        </div>
    );
}

function fieldFocusProps(
    key: string,
    onFocus?: () => void,
    onBlur?: (e: React.FocusEvent<HTMLDivElement>) => void,
) {
    return {
        onFocusCapture: onFocus,
        onBlurCapture: onBlur,
        'data-setting-key': key,
    };
}

/**
 * SupportSidebar
 * 
 * Main settings panel for support mode.
 * Displays presets and editable settings for tip, shaft, roots, base flare, and grid.
 */
export function SupportSidebar() {
    usePresetHotkeys();
    const settings = useSyncExternalStore(subscribeToSettings, getSettings, getSettings);
    const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
    const [autoBraceStatus, setAutoBraceStatus] = useState<{ kind: 'success' | 'warning' | 'error'; message: string } | null>(null);
    const [expanded, setExpanded] = React.useState(true);
    const saveStatusTimeoutRef = React.useRef<number | null>(null);
    const autoBraceStatusTimeoutRef = React.useRef<number | null>(null);
    const isAdaptiveConeAngle = (settings.tip.coneAngleMode ?? 'normal') === 'adaptive';
    const supportKindState = React.useSyncExternalStore(subscribeToSupportKindState, getSupportKindSnapshot, getSupportKindSnapshot);
    const activeKind = supportKindState.kind;
    const useAdaptiveIconCompactDisplay = isAdaptiveConeAngle && activeKind === 'trunk';
    const tabKind = normalizeTabKind(activeKind);
    const activeKindMeta = KIND_META[activeKind];
    const raftSettings = React.useSyncExternalStore(subscribeToRaftStore, getRaftSettings, getRaftSettings);
    const supportState = React.useSyncExternalStore(subscribeToSupportState, getSupportSnapshot, getSupportSnapshot);
    const previewState = React.useSyncExternalStore(subscribeToAnatomyPreviewState, getAnatomyPreviewState, getAnatomyPreviewState);
    const activeKey = previewState.activeSettingKey;
    const curveSelection = getCurveSettingsSelection(supportState);
    const showCurvePage = curveSelection !== null;
    const selectedCategory = supportState.selectedCategory ?? undefined;
    const editableTarget = React.useMemo(
        () => resolveEditableSupportTarget(supportState.selectedId, selectedCategory),
        [supportState, selectedCategory],
    );
    const selectedSupportSettings = React.useMemo(() => {
        if (!editableTarget) return null;
        return getSupportSettingsForTarget(editableTarget);
    }, [editableTarget, supportState]);
    const selectedPresetIdOverride = React.useMemo(() => {
        if (!editableTarget || !selectedSupportSettings) return undefined;
        return findMatchingPresetIdForSettings(selectedSupportSettings);
    }, [editableTarget, selectedSupportSettings]);
    const [optimisticPresetId, setOptimisticPresetId] = React.useState<string | null>(null);
    const effectivePresetIdOverride = optimisticPresetId ?? selectedPresetIdOverride;
    const isHydratingSelectedSupportRef = React.useRef(false);
    const lastEditableTargetKeyRef = React.useRef<string | null>(null);
    const skipFirstApplyForTargetKeyRef = React.useRef<string | null>(null);
    const latestSettingsRef = React.useRef(settings);
    const editSessionTargetRef = React.useRef<EditableSupportTarget | null>(null);
    const editSessionTargetKeyRef = React.useRef<string | null>(null);
    const editSessionBeforeSnapshotRef = React.useRef<SupportEditHistorySnapshot | null>(null);
    const editSessionLatestSettingsRef = React.useRef<SupportSettings | null>(null);
    const globalSettingsBeforeSupportEditRef = React.useRef<SupportSettings | null>(null);
    const supportEditSessionDirtyRef = React.useRef(false);

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

        checkPresetDrift(getSettings());

        const unsubscribeSettings = subscribeToSettings(() => {
            checkPresetDrift(getSettings());
        });
        return () => {
            unsubscribeSettings();
        };
    }, []);

    React.useEffect(() => {
        latestSettingsRef.current = settings;
    }, [settings]);

    const commitPendingSettingsSession = React.useCallback((target: EditableSupportTarget | null) => {
        if (!target) return;

        const before = editSessionBeforeSnapshotRef.current;

        if (!supportEditSessionDirtyRef.current) {
            editSessionBeforeSnapshotRef.current = null;
            editSessionLatestSettingsRef.current = null;
            return;
        }

        const latestSettings = editSessionLatestSettingsRef.current ?? getSettings();
        const persisted = getSupportSettingsForTarget(target);
        if (!persisted || !areSupportGeometrySettingsEqual(persisted, latestSettings)) {
            applySettingsToSupportTarget(target, latestSettings);
        }

        if (before) {
            const after = captureSupportEditSnapshot();
            if (hasMeaningfulSupportEditChange(before, after)) {
                pushSupportEditHistory(
                    `Adjust ${formatSupportKindLabel(target.kind)} Settings`,
                    before,
                    after,
                );
            }
        }

        editSessionBeforeSnapshotRef.current = null;
        editSessionLatestSettingsRef.current = null;
        supportEditSessionDirtyRef.current = false;
    }, []);

    React.useEffect(() => {
        const nextTarget = editableTarget;
        const nextKey = nextTarget ? `${nextTarget.kind}:${nextTarget.id}` : null;
        const prevTarget = editSessionTargetRef.current;
        const prevKey = editSessionTargetKeyRef.current;

        const enteringSupportEdit = !prevTarget && !!nextTarget;
        const leavingSupportEdit = !!prevTarget && !nextTarget;

        if (enteringSupportEdit && globalSettingsBeforeSupportEditRef.current === null) {
            globalSettingsBeforeSupportEditRef.current = getSettings();
        }

        if (prevTarget && prevKey !== nextKey) {
            commitPendingSettingsSession(prevTarget);
        }

        if (nextTarget && prevKey !== nextKey) {
            editSessionBeforeSnapshotRef.current = captureSupportEditSnapshot();
            supportEditSessionDirtyRef.current = false;
            editSessionLatestSettingsRef.current = getSupportSettingsForTarget(nextTarget) ?? getSettings();
        }

        editSessionTargetRef.current = nextTarget;
        editSessionTargetKeyRef.current = nextKey;

        if (leavingSupportEdit && globalSettingsBeforeSupportEditRef.current) {
            setSettings(globalSettingsBeforeSupportEditRef.current);
            globalSettingsBeforeSupportEditRef.current = null;
        }

        if (leavingSupportEdit && activeKind !== 'trunk') {
            setActiveSupportKind('trunk');
        }
    }, [editableTarget, commitPendingSettingsSession]);

    React.useEffect(() => {
        return () => {
            if (saveStatusTimeoutRef.current !== null) {
                window.clearTimeout(saveStatusTimeoutRef.current);
                saveStatusTimeoutRef.current = null;
            }
            if (autoBraceStatusTimeoutRef.current !== null) {
                window.clearTimeout(autoBraceStatusTimeoutRef.current);
                autoBraceStatusTimeoutRef.current = null;
            }

            commitPendingSettingsSession(editSessionTargetRef.current);

            if (globalSettingsBeforeSupportEditRef.current) {
                setSettings(globalSettingsBeforeSupportEditRef.current);
                globalSettingsBeforeSupportEditRef.current = null;
            }
        };
    }, [commitPendingSettingsSession]);

    React.useEffect(() => {
        const targetKey = editableTarget ? `${editableTarget.kind}:${editableTarget.id}` : null;

        if (!editableTarget) {
            lastEditableTargetKeyRef.current = null;
            return;
        }

        if (!selectedSupportSettings) {
            return;
        }

        const selectionChanged = targetKey !== lastEditableTargetKeyRef.current;
        const geometryDiffers = !areSupportGeometrySettingsEqual(settings, selectedSupportSettings);

        if (!selectionChanged) {
            return;
        }

        skipFirstApplyForTargetKeyRef.current = targetKey;

        if (geometryDiffers) {
            isHydratingSelectedSupportRef.current = true;
            setSettings({
                ...settings,
                tip: { ...settings.tip, ...selectedSupportSettings.tip },
                shaft: { ...settings.shaft, ...selectedSupportSettings.shaft },
                roots: { ...settings.roots, ...selectedSupportSettings.roots },
                baseFlare: { ...settings.baseFlare, ...selectedSupportSettings.baseFlare },
            });
        }

        if (selectionChanged && activeKind !== editableTarget.kind) {
            setActiveSupportKind(editableTarget.kind);
        }

        lastEditableTargetKeyRef.current = targetKey;
    }, [editableTarget, selectedSupportSettings, settings, activeKind]);

    React.useEffect(() => {
        if (!editableTarget) return;

        const targetKey = `${editableTarget.kind}:${editableTarget.id}`;
        if (skipFirstApplyForTargetKeyRef.current === targetKey) {
            skipFirstApplyForTargetKeyRef.current = null;
            return;
        }

        const persistedSelectionSettings = getSupportSettingsForTarget(editableTarget);

        if (!persistedSelectionSettings) return;

        if (isHydratingSelectedSupportRef.current) {
            // Only swallow the cycle when hydration has already converged.
            // If settings diverge (e.g. quick preset click right after selection),
            // allow apply so we don't lose that edit.
            if (areSupportGeometrySettingsEqual(persistedSelectionSettings, settings)) {
                isHydratingSelectedSupportRef.current = false;
                return;
            }
            isHydratingSelectedSupportRef.current = false;
        }
        if (areSupportGeometrySettingsEqual(persistedSelectionSettings, settings)) return;

        supportEditSessionDirtyRef.current = true;
        editSessionLatestSettingsRef.current = settings;
        applySettingsToSupportTarget(editableTarget, settings);
    }, [editableTarget, settings]);

    React.useEffect(() => {
        if (!editableTarget) {
            if (optimisticPresetId !== null) {
                setOptimisticPresetId(null);
            }
            return;
        }

        if (optimisticPresetId === null) return;

        // Clear optimistic selection only when support-derived matching catches up
        // to the same preset id. This avoids dropping the visible active tile
        // back to a stale preset during in-flight store updates.
        if (selectedPresetIdOverride === optimisticPresetId) {
            setOptimisticPresetId(null);
        }
    }, [editableTarget, optimisticPresetId, selectedPresetIdOverride]);

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

        if (saveStatusTimeoutRef.current !== null) {
            window.clearTimeout(saveStatusTimeoutRef.current);
        }
        saveStatusTimeoutRef.current = window.setTimeout(() => {
            setSaveStatus('idle');
            saveStatusTimeoutRef.current = null;
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

    const handleAutoBrace = React.useCallback(() => {
        try {
            const result = runAutoBracing();
            if (!result.changed) {
                setAutoBraceStatus({ kind: 'warning', message: result.message });
            } else if (result.skippedSupportCount > 0) {
                setAutoBraceStatus({ kind: 'warning', message: result.message });
            } else {
                setAutoBraceStatus({ kind: 'success', message: result.message });
            }
        } catch (err) {
            console.error('[SupportSidebar] Auto Brace failed:', err);
            setAutoBraceStatus({ kind: 'error', message: 'Auto Brace failed. Check console for details.' });
        }

        if (autoBraceStatusTimeoutRef.current !== null) {
            window.clearTimeout(autoBraceStatusTimeoutRef.current);
        }
        autoBraceStatusTimeoutRef.current = window.setTimeout(() => {
            setAutoBraceStatus(null);
            autoBraceStatusTimeoutRef.current = null;
        }, 2800);
    }, []);

    const getInputProps = React.useCallback((key: string, baseClass: string) => {
        const isActive = activeKey === key;
        if (isActive) {
            return {
                className: `${baseClass} ring-2`,
                style: {
                    borderColor: 'var(--accent)',
                    boxShadow: '0 0 0 1px color-mix(in srgb, var(--accent), white 8%) inset, 0 0 0 2px color-mix(in srgb, var(--accent), transparent 72%)',
                } as React.CSSProperties
            };
        }
        return { className: baseClass };
    }, [activeKey]);

    const compactInputClass = INPUT_CLASS;

    const renderPreviewBox = (heightClass: string, widthClass: string = 'w-full') => (
        <div
            data-no-drag="true"
            className={`relative ${widthClass} ${heightClass} rounded-md border overflow-hidden`}
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
        >
            <SupportAnatomyPreviewSlot />
        </div>
    );

    const sectionScrollClass = 'max-h-[calc(100vh-var(--topbar-height)-190px)] overflow-y-auto custom-scrollbar pr-1';
    const compactFieldLabelClass = 'text-[11px] font-medium leading-tight';
    const supportGeometryFields = (
        <div className="space-y-2.5">
            <div className="space-y-1 min-w-0" {...makeRowFocusHandlers('tip.contactDiameterMm')}>
                <div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Contact Diameter (mm)</div>
                <NumberInput
                    value={settings.tip.contactDiameterMm}
                    onChange={(val) => updateTipProfile({ contactDiameterMm: val })}
                    step={0.1}
                    {...getInputProps('tip.contactDiameterMm', compactInputClass)}
                />
            </div>

            {(activeKind === 'trunk' || activeKind === 'branch' || activeKind === 'leaf') && (
                <div className="space-y-1 min-w-0" {...makeRowFocusHandlers('tip.lengthMm')}>
                    <div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Contact Cone Length (mm)</div>
                    <NumberInput
                        value={settings.tip.lengthMm}
                        onChange={(val) => updateTipProfile({ lengthMm: val })}
                        step={0.1}
                        {...getInputProps('tip.lengthMm', compactInputClass)}
                    />
                </div>
            )}

            {(activeKind === 'trunk' || activeKind === 'branch' || activeKind === 'leaf') && (
                <div className="space-y-1 min-w-0" {...fieldFocusProps('tip.coneAngleMode', () => setAnatomyPreviewActiveSettingKey('tip.coneAngleMode'), (e) => {
                    const next = e.relatedTarget as Node | null;
                    if (next && e.currentTarget.contains(next)) return;
                    setAnatomyPreviewActiveSettingKey(null);
                })}>
                    <div
                        className={isAdaptiveConeAngle ? 'grid grid-cols-[1fr_82px] gap-1 items-center' : 'flex items-center'}
                    >
                        <div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Cone Angle</div>
                        {isAdaptiveConeAngle && (
                            <div className="justify-self-start text-[11px] text-left" style={{ color: 'var(--text-muted)' }}>Offset</div>
                        )}
                    </div>
                    <div
                        className={isAdaptiveConeAngle ? 'grid grid-cols-[1fr_82px] gap-1 items-center' : 'flex items-center gap-1'}
                    >
                        <SelectDropdown
                            value={settings.tip.coneAngleMode ?? 'normal'}
                            onChange={(value) => updateTipProfile({ coneAngleMode: value as 'normal' | 'locked' | 'adaptive' })}
                            options={[
                                { value: 'normal', label: 'Normal' },
                                { value: 'locked', label: 'Locked' },
                                { value: 'adaptive', label: 'Adaptive' },
                            ]}
                            className={`${isAdaptiveConeAngle ? 'w-full' : 'flex-1'} min-w-0 space-y-0`}
                            selectClassName={`${isAdaptiveConeAngle ? 'w-full' : 'flex-1'} min-w-0 h-8 px-2.5 pr-10 text-xs sm:text-sm truncate`}
                            menuClassName="!min-w-[9.5rem]"
                            selectedDisplay={useAdaptiveIconCompactDisplay ? <WandSparkles className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} aria-label="Adaptive mode" /> : undefined}
                            hideSelectedText={useAdaptiveIconCompactDisplay}
                            selectedDisplayAlignment={useAdaptiveIconCompactDisplay ? 'center' : 'left'}
                            selectedDisplayOffsetX={useAdaptiveIconCompactDisplay ? -7 : 0}
                            selectStyle={activeKey === 'tip.coneAngleMode'
                                ? {
                                    borderColor: 'var(--accent)',
                                    boxShadow: '0 0 0 1px color-mix(in srgb, var(--accent), white 8%) inset, 0 0 0 2px color-mix(in srgb, var(--accent), transparent 72%)',
                                }
                                : undefined}
                        />

                        {isAdaptiveConeAngle && (
                            <NumberInput
                                value={settings.tip.adaptiveConeAngleOffsetDeg ?? 30}
                                onChange={(val) => updateTipProfile({ adaptiveConeAngleOffsetDeg: val })}
                                aria-label="Adaptive offset (deg)"
                                title="Adaptive offset (deg)"
                                {...getInputProps('tip.adaptiveConeAngleOffsetDeg', compactInputClass)}
                            />
                        )}
                    </div>
                </div>
            )}

            {(activeKind === 'trunk' || activeKind === 'branch') && (
                <div className="space-y-1 min-w-0" {...makeRowFocusHandlers('shaft.diameterMm')}>
                    <div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Trunk Diameter (mm)</div>
                    <NumberInput
                        value={settings.shaft.diameterMm}
                        onChange={(val) => updateShaftProfile({ diameterMm: val })}
                        step={0.1}
                        {...getInputProps('shaft.diameterMm', compactInputClass)}
                    />
                </div>
            )}

            {activeKind === 'trunk' && (
                <>
                    <div className="h-px" style={{ background: 'var(--border-subtle)' }} />
                    <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Roots</div>

                    <div className="space-y-1 min-w-0" {...makeRowFocusHandlers('roots.diameterMm')}>
                        <div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Roots Diameter (mm)</div>
                        <NumberInput
                            value={settings.roots.diameterMm}
                            onChange={(val) => updateRootsProfile({ diameterMm: val })}
                            step={0.1}
                            {...getInputProps('roots.diameterMm', compactInputClass)}
                        />
                    </div>

                    <div className="space-y-2">
                        <div className="space-y-1 min-w-0" {...makeRowFocusHandlers('roots.diskHeightMm')}>
                            <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }}>Disk Height (mm)</div>
                            <NumberInput
                                value={settings.roots.diskHeightMm}
                                onChange={(val) => updateRootsProfile({ diskHeightMm: val })}
                                step={0.1}
                                {...getInputProps('roots.diskHeightMm', compactInputClass)}
                            />
                        </div>

                        <div className="space-y-1 min-w-0" {...makeRowFocusHandlers('roots.coneHeightMm')}>
                            <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }}>Cone Height (mm)</div>
                            <NumberInput
                                value={settings.roots.coneHeightMm}
                                onChange={(val) => updateRootsProfile({ coneHeightMm: val })}
                                step={0.1}
                                {...getInputProps('roots.coneHeightMm', compactInputClass)}
                            />
                        </div>
                    </div>
                </>
            )}
        </div>
    );

    const activeKindIcon = activeKindMeta.icon;
    const ActiveKindIcon = activeKindIcon;

    return (
        <Card>
            <CardHeader
                left={(
                    <>
                        <IconButton
                            onClick={() => setExpanded((prev) => !prev)}
                            className="!p-0.5"
                            title={expanded ? 'Collapse card' : 'Expand card'}
                        >
                            <svg
                                className="w-3 h-3 transform transition-transform"
                                style={{ color: expanded ? 'var(--accent)' : 'var(--text-muted)' }}
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                            >
                                {expanded ? (
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                                ) : (
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                )}
                            </svg>
                        </IconButton>
                        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Support Studio</h3>
                    </>
                )}
                right={(
                    <div className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5" style={{ borderColor: 'var(--border-subtle)' }}>
                        <ActiveKindIcon className="h-3 w-3" style={{ color: 'var(--accent)' }} />
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{activeKindMeta.label}</span>
                    </div>
                )}
            />

            {expanded && (
                <div className="px-2 pb-2 space-y-2 sm:px-2.5 sm:pb-2.5">
                    <div className={sectionScrollClass}>
                        <div className="space-y-2">
                            {showCurvePage ? (
                                <>
                                    <Section title="Curves" accent>
                                        <CurveSettingsCard embedded />
                                    </Section>
                                </>
                            ) : (
                                <>
                                    <Section title="Support type" accent>
                                        <SupportKindTabs
                                            value={tabKind}
                                            onChange={(kind) => {
                                                setAnatomyPreviewActiveSettingKey(null);
                                                setActiveSupportKind(kind);
                                            }}
                                        />
                                    </Section>

                                    {activeKind === 'raft' ? (
                                        <>
                                            <Section title="Anatomy preview">
                                                {renderPreviewBox('h-[220px]')}
                                            </Section>
                                            <Section title="Raft settings">
                                                <RaftSettingsCard
                                                    settings={raftSettings}
                                                    onChange={(partial) => updateRaftSettings(partial)}
                                                />
                                            </Section>
                                        </>
                                    ) : activeKind === 'grid' ? (
                                        <>
                                            <Section title="Anatomy preview">
                                                {renderPreviewBox('h-[220px]')}
                                            </Section>
                                            <Section title="Grid settings">
                                                <GridSettingsCard
                                                    grid={settings.grid}
                                                    onChange={(partial) => updateGridSettings(partial)}
                                                />
                                            </Section>
                                        </>
                                    ) : activeKind === 'stick' ? (
                                        <>
                                            <Section title="Anatomy preview">
                                                {renderPreviewBox('h-[250px]')}
                                            </Section>
                                            <Section title="Auto bracing">
                                                <AutoBracingSettingsCard
                                                    settings={settings.autoBracing}
                                                    onChange={(partial) => updateAutoBracingSettings(partial)}
                                                    onAutoBrace={handleAutoBrace}
                                                    status={autoBraceStatus}
                                                />
                                            </Section>
                                        </>
                                    ) : activeKind === 'trunk' ? (
                                        <>
                                            <div className="flex gap-2 items-stretch">
                                                <div className="flex-1 min-w-0 rounded-md border p-2 flex flex-col" style={SECTION_CARD_STYLE}>
                                                    <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                                                        Anatomy preview
                                                    </div>
                                                    {renderPreviewBox('flex-1 min-h-[340px]')}
                                                </div>

                                                <div className="flex-1 min-w-0 rounded-md border p-2" style={SECTION_CARD_STYLE}>
                                                    <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                                                        Support geometry
                                                    </div>
                                                    {supportGeometryFields}
                                                </div>
                                            </div>

                                            <div className="rounded-md border p-2" style={SECTION_CARD_STYLE}>
                                                <PresetSelector
                                                    selectedPresetIdOverride={effectivePresetIdOverride}
                                                    disableGlobalPresetActivation={Boolean(editableTarget)}
                                                    onPresetSelected={(presetId) => {
                                                        const liveSupportState = getSupportSnapshot();
                                                        const liveTarget = resolveEditableSupportTarget(
                                                            liveSupportState.selectedId,
                                                            liveSupportState.selectedCategory ?? undefined,
                                                        );

                                                        if (liveTarget) {
                                                            const preset = getPresetById(presetId);
                                                            if (preset) {
                                                                const current = getSettings();

                                                                supportEditSessionDirtyRef.current = true;
                                                                const nextSettings: SupportSettings = {
                                                                    ...preset.settings,
                                                                    grid: {
                                                                        ...current.grid,
                                                                    },
                                                                    tip: {
                                                                        ...preset.settings.tip,
                                                                        coneAngleMode: current.tip.coneAngleMode,
                                                                        adaptiveConeAngleOffsetDeg: current.tip.adaptiveConeAngleOffsetDeg,
                                                                        coneAngleDeg: current.tip.coneAngleDeg,
                                                                    },
                                                                    autoBracing: {
                                                                        ...current.autoBracing,
                                                                    },
                                                                };
                                                                editSessionLatestSettingsRef.current = nextSettings;
                                                                setSettings(nextSettings);
                                                                applySettingsToSupportTarget(liveTarget, nextSettings);
                                                            }
                                                        }

                                                        if (!liveTarget) return;
                                                        setOptimisticPresetId(presetId);
                                                    }}
                                                />
                                            </div>
                                        </>
                                    ) : (
                                        <>
                                            <Section title="Anatomy preview">
                                                {renderPreviewBox('h-[250px]')}
                                            </Section>

                                            <Section title="Support geometry">
                                                {supportGeometryFields}
                                            </Section>

                                            {/* Placement notes removed per design request */}
                                        </>
                                    )}
                                </>
                            )}
                        </div>
                    </div>

                    {activeKind !== 'trunk' ? (
                        <Section title="Actions" accent>
                            {saveStatus !== 'idle' && (
                                <div
                                    className="mb-2 text-[10px]"
                                    style={{ color: saveStatus === 'saved' ? '#34d399' : '#f87171' }}
                                >
                                    {saveStatus === 'saved' ? 'Saved' : 'Save failed'}
                                </div>
                            )}

                            <div className="grid grid-cols-2 gap-1.5">
                                <Button
                                    type="button"
                                    onClick={handleSave}
                                    variant="primary"
                                    size="md"
                                    className="w-full !h-10 !text-sm !font-semibold !inline-flex !items-center !justify-center !gap-2"
                                >
                                    <Save className="h-4 w-4" />
                                    <span>Save</span>
                                </Button>

                                <Button
                                    type="button"
                                    onClick={handleRestoreDefaults}
                                    variant="accent"
                                    size="md"
                                    className="w-full !h-10 !text-sm !font-semibold !inline-flex !items-center !justify-center !gap-2"
                                >
                                    <RotateCcw className="h-4 w-4" />
                                    <span>Defaults</span>
                                </Button>
                            </div>
                        </Section>
                    ) : null}
                </div>
            )}
        </Card>
    );
}
