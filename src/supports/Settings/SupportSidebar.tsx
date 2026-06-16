"use client";


import React, { useState, useEffect, useLayoutEffect, useSyncExternalStore } from 'react';
import ReactDOM from 'react-dom';
import { Check, Save, RotateCcw, Sparkles, Wrench, WandSparkles, Sailboat, Grid3X3, Pickaxe } from 'lucide-react';
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
    updateDevToolsEnabled,
} from './state';
import {
    subscribe as subscribeToSupportState,
    getSnapshot as getSupportSnapshot,
    resolveEditableSupportTarget,
    getSupportSettingsForTarget,
    applySettingsToSupportTarget,
    beginSupportStateBatch,
    endSupportStateBatch,
    type EditableSupportTarget,
} from '../state';
import { getSelectedSupportIds } from '../interaction/supportMultiSelection';
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
import { Card, CardHeader, IconButton } from '@/components/ui/primitives';
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
    wasRaftSettingsManuallyModified,
    resetRaftSessionModificationFlag,
} from '../Rafts/Crenelated/RaftState';
import { DEFAULT_RAFT_SETTINGS } from '../Rafts/Crenelated/RaftDefaults';
import type { SupportKind } from './supportKindState';

const INPUT_CLASS = 'ui-input h-8 w-full px-2.5 text-xs sm:text-sm text-center no-spinners';
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

const OVERFLOW_COMPACT_KIND_SET = new Set<SupportKind>(['trunk', 'raft', 'grid', 'stick']);
const POPUP_PREVIEW_KIND_SET = new Set<SupportKind>(['trunk']);

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

/** Apply settings to all currently selected supports (multi-selection aware). */
function applySettingsToAllSelectedSupports(settings: SupportSettings): void {
    const snap = getSupportSnapshot();
    const selectedIds = getSelectedSupportIds();
    const idsToApply = selectedIds.length > 0
        ? selectedIds
        : (snap.selectedId ? [snap.selectedId] : []);

    if (idsToApply.length === 0) return;

    // Batch all mutations so notify() only fires once after the loop,
    // preventing cascading re-renders from useSyncExternalStore listeners.
    beginSupportStateBatch();
    try {
        for (const id of idsToApply) {
            let target: EditableSupportTarget | null = null;
            if (snap.trunks[id]) {
                target = { kind: 'trunk', id };
            } else if (snap.branches[id]) {
                target = { kind: 'branch', id };
            } else if (snap.leaves[id]) {
                target = { kind: 'leaf', id };
            } else {
                target = resolveEditableSupportTarget(id, snap.selectedCategory ?? undefined);
            }
            if (target) {
                applySettingsToSupportTarget(target, settings);
            }
        }
    } finally {
        endSupportStateBatch();
    }
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
    const [defaultsAnimating, setDefaultsAnimating] = useState(false);
    const [expanded, setExpanded] = React.useState(true);
    const [devToolsOpen, setDevToolsOpen] = useState(false);
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
    const scrollViewportRef = React.useRef<HTMLDivElement | null>(null);
    const scrollContentRef = React.useRef<HTMLDivElement | null>(null);
    const supportSidebarAnchorRef = React.useRef<HTMLDivElement | null>(null);
    const [trunkCompactByOverflow, setTrunkCompactByOverflow] = React.useState(false);
    const [floatingTrunkPreviewPlacement, setFloatingTrunkPreviewPlacement] = React.useState<{ top: number; left: number; width: number; height: number } | null>(null);
    const floatingTrunkPreviewHideTimeoutRef = React.useRef<number | null>(null);
    const floatingTrunkPreviewFadeTimeoutRef = React.useRef<number | null>(null);
    const [floatingTrunkPreviewHeldOpen, setFloatingTrunkPreviewHeldOpen] = React.useState(false);
    const [floatingTrunkPreviewFadingOut, setFloatingTrunkPreviewFadingOut] = React.useState(false);
    const compactEnteredWindowHeightRef = React.useRef<number | null>(null);

    useEffect(() => {
        if (!OVERFLOW_COMPACT_KIND_SET.has(activeKind) || !trunkCompactByOverflow) {
            compactEnteredWindowHeightRef.current = null;
            return;
        }

        compactEnteredWindowHeightRef.current = window.innerHeight;
    }, [activeKind, trunkCompactByOverflow]);

    useLayoutEffect(() => {
        if (!expanded || showCurvePage || !OVERFLOW_COMPACT_KIND_SET.has(activeKind)) return;
        const viewport = scrollViewportRef.current;
        if (!viewport) return;

        const OVERFLOW_EPSILON = 1;
        const PREVIEW_RESTORE_HEADROOM_PX = 8;
        const PREVIEW_RESTORE_WINDOW_GROWTH_PX = 24;
        let rafId: number | null = null;

        const evaluate = () => {
            rafId = null;
            const contentHeight = Math.ceil(
                scrollContentRef.current?.getBoundingClientRect().height
                ?? viewport.scrollHeight,
            );
            const wouldOverflow = (contentHeight - viewport.clientHeight) > OVERFLOW_EPSILON;

            setTrunkCompactByOverflow((prev) => {
                if (!prev) {
                    return wouldOverflow;
                }

                if (wouldOverflow) {
                    return true;
                }

                const compactHeadroom = viewport.clientHeight - contentHeight;
                if (compactHeadroom >= PREVIEW_RESTORE_HEADROOM_PX) {
                    return false;
                }

                const compactEnteredWindowHeight = compactEnteredWindowHeightRef.current;
                if (
                    compactEnteredWindowHeight !== null
                    && window.innerHeight >= compactEnteredWindowHeight + PREVIEW_RESTORE_WINDOW_GROWTH_PX
                ) {
                    return false;
                }

                return true;
            });
        };

        const scheduleEvaluate = () => {
            if (rafId !== null) {
                window.cancelAnimationFrame(rafId);
            }
            rafId = window.requestAnimationFrame(evaluate);
        };

        scheduleEvaluate();

        const observer = new ResizeObserver(() => {
            scheduleEvaluate();
        });
        observer.observe(viewport);
        if (scrollContentRef.current) {
            observer.observe(scrollContentRef.current);
        }
        window.addEventListener('resize', scheduleEvaluate);

        return () => {
            observer.disconnect();
            window.removeEventListener('resize', scheduleEvaluate);
            if (rafId !== null) {
                window.cancelAnimationFrame(rafId);
            }
        };
    }, [expanded, showCurvePage, activeKind]);

    useEffect(() => {
        if (!OVERFLOW_COMPACT_KIND_SET.has(activeKind) && trunkCompactByOverflow) {
            setTrunkCompactByOverflow(false);
        }
    }, [activeKind, trunkCompactByOverflow]);

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
        
        // Skip loading localStorage raft settings if the user already manually modified them in this session.
        // This preserves manual changes when reopening Support Studio and respects import defaults.
        if (!wasRaftSettingsManuallyModified()) {
            try {
                const storedRaft = localStorage.getItem(RAFT_STORAGE_KEY);
                if (storedRaft) {
                    const parsed = JSON.parse(storedRaft);
                    setRaftSettings(parsed);
                }
            } catch (err) {
                console.error('[SupportSidebar] Failed to load raft settings:', err);
            }
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
            applySettingsToAllSelectedSupports(latestSettings);
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
        applySettingsToAllSelectedSupports(settings);
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

        // Trigger spin animation
        setDefaultsAnimating(true);
        setTimeout(() => setDefaultsAnimating(false), 600);
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

    const sectionScrollClass = 'flex-1 min-h-0 overflow-y-auto custom-scrollbar';
    const shouldUseOverflowCompactMode = OVERFLOW_COMPACT_KIND_SET.has(activeKind) && trunkCompactByOverflow;
    const shouldUseCompactTrunkLayout = activeKind === 'trunk' && shouldUseOverflowCompactMode;
    const hasFloatingTrunkPreviewTrigger = POPUP_PREVIEW_KIND_SET.has(activeKind)
        && (Boolean(activeKey) || Boolean(previewState.hoveredPresetSettings));
    const shouldShowFloatingTrunkPreview = expanded
        && POPUP_PREVIEW_KIND_SET.has(activeKind)
        && shouldUseOverflowCompactMode
        && floatingTrunkPreviewHeldOpen;

    useEffect(() => {
        const supportsFloatingPreview = expanded
            && POPUP_PREVIEW_KIND_SET.has(activeKind)
            && shouldUseOverflowCompactMode;
        if (!supportsFloatingPreview) {
            if (floatingTrunkPreviewHideTimeoutRef.current !== null) {
                window.clearTimeout(floatingTrunkPreviewHideTimeoutRef.current);
                floatingTrunkPreviewHideTimeoutRef.current = null;
            }
            if (floatingTrunkPreviewFadeTimeoutRef.current !== null) {
                window.clearTimeout(floatingTrunkPreviewFadeTimeoutRef.current);
                floatingTrunkPreviewFadeTimeoutRef.current = null;
            }
            setFloatingTrunkPreviewFadingOut(false);
            setFloatingTrunkPreviewHeldOpen(false);
            return;
        }

        if (hasFloatingTrunkPreviewTrigger) {
            if (floatingTrunkPreviewHideTimeoutRef.current !== null) {
                window.clearTimeout(floatingTrunkPreviewHideTimeoutRef.current);
                floatingTrunkPreviewHideTimeoutRef.current = null;
            }
            if (floatingTrunkPreviewFadeTimeoutRef.current !== null) {
                window.clearTimeout(floatingTrunkPreviewFadeTimeoutRef.current);
                floatingTrunkPreviewFadeTimeoutRef.current = null;
            }
            setFloatingTrunkPreviewFadingOut(false);
            setFloatingTrunkPreviewHeldOpen(true);
            return;
        }

        if (!floatingTrunkPreviewHeldOpen) {
            return;
        }

        if (floatingTrunkPreviewHideTimeoutRef.current !== null || floatingTrunkPreviewFadeTimeoutRef.current !== null) {
            return;
        }

        floatingTrunkPreviewHideTimeoutRef.current = window.setTimeout(() => {
            floatingTrunkPreviewHideTimeoutRef.current = null;
            setFloatingTrunkPreviewFadingOut(true);

            floatingTrunkPreviewFadeTimeoutRef.current = window.setTimeout(() => {
                floatingTrunkPreviewFadeTimeoutRef.current = null;
                setFloatingTrunkPreviewHeldOpen(false);
                setFloatingTrunkPreviewFadingOut(false);
            }, 240);
        }, 2000);
    }, [expanded, activeKind, shouldUseOverflowCompactMode, hasFloatingTrunkPreviewTrigger, floatingTrunkPreviewHeldOpen]);

    useEffect(() => {
        return () => {
            if (floatingTrunkPreviewHideTimeoutRef.current !== null) {
                window.clearTimeout(floatingTrunkPreviewHideTimeoutRef.current);
                floatingTrunkPreviewHideTimeoutRef.current = null;
            }
            if (floatingTrunkPreviewFadeTimeoutRef.current !== null) {
                window.clearTimeout(floatingTrunkPreviewFadeTimeoutRef.current);
                floatingTrunkPreviewFadeTimeoutRef.current = null;
            }
        };
    }, []);

    useLayoutEffect(() => {
        if (!shouldShowFloatingTrunkPreview) {
            setFloatingTrunkPreviewPlacement(null);
            return;
        }

        const anchor = supportSidebarAnchorRef.current;
        if (!anchor) return;

        const MARGIN = 12;
        const GAP = 10;
        let rafId: number | null = null;

        const updatePlacement = () => {
            rafId = null;
            const rect = anchor.getBoundingClientRect();
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;

            const MIN_PREVIEW_HEIGHT = 220;
            const preferredTop = rect.top + 2;
            const top = Math.max(MARGIN, Math.min(preferredTop, viewportHeight - MARGIN - MIN_PREVIEW_HEIGHT));

            const maxHeightForTop = Math.max(MIN_PREVIEW_HEIGHT, viewportHeight - top - MARGIN);
            const height = Math.max(MIN_PREVIEW_HEIGHT, Math.min(Math.floor(rect.height), maxHeightForTop));

            const desiredWidth = Math.floor(height * 0.30);
            const width = Math.max(150, Math.min(230, desiredWidth));

            const rightLeft = rect.right + GAP;
            const leftLeft = rect.left - GAP - width;
            const fitsRight = rightLeft + width <= (viewportWidth - MARGIN);
            const fitsLeft = leftLeft >= MARGIN;

            let left = rightLeft;
            if (!fitsRight && fitsLeft) {
                left = leftLeft;
            } else if (!fitsRight && !fitsLeft) {
                left = Math.max(MARGIN, viewportWidth - width - MARGIN);
            }

            setFloatingTrunkPreviewPlacement((prev) => {
                if (
                    prev
                    && prev.top === top
                    && prev.left === left
                    && prev.width === width
                    && prev.height === height
                ) {
                    return prev;
                }
                return { top, left, width, height };
            });
        };

        const schedulePlacement = () => {
            if (rafId !== null) {
                window.cancelAnimationFrame(rafId);
            }
            rafId = window.requestAnimationFrame(updatePlacement);
        };

        schedulePlacement();

        const observer = new ResizeObserver(() => {
            schedulePlacement();
        });
        observer.observe(anchor);

        window.addEventListener('resize', schedulePlacement);
        window.addEventListener('scroll', schedulePlacement, true);

        return () => {
            observer.disconnect();
            window.removeEventListener('resize', schedulePlacement);
            window.removeEventListener('scroll', schedulePlacement, true);
            if (rafId !== null) {
                window.cancelAnimationFrame(rafId);
            }
        };
    }, [shouldShowFloatingTrunkPreview]);

    const compactFieldLabelClass = shouldUseCompactTrunkLayout
        ? 'text-[11px] font-medium leading-tight truncate whitespace-nowrap'
        : 'text-[11px] font-medium leading-tight';
    const compactTrunkPairClass = 'grid grid-cols-2 gap-1.5 items-start';

    const unitHint = (unit: string) => (
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>{unit}</span>
    );

    const supportGeometryFieldsDefault = (
        <div className="space-y-2.5">
            <div className="space-y-1 min-w-0" {...makeRowFocusHandlers('tip.contactDiameterMm')}>
                <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }} title="Contact Diameter">Contact Diameter</div>
                <div className="relative">
                    <NumberInput
                        value={settings.tip.contactDiameterMm}
                        onChange={(val) => updateTipProfile({ contactDiameterMm: val })}
                        step={0.1}
                        showStepper={false}
                        {...getInputProps('tip.contactDiameterMm', compactInputClass)}
                    />
                    {unitHint('mm')}
                </div>
            </div>

            {(activeKind === 'trunk' || activeKind === 'branch' || activeKind === 'leaf') && (
                <div className="space-y-1 min-w-0" {...makeRowFocusHandlers('tip.lengthMm')}>
                    <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }} title="Contact Cone Length">Contact Cone Length</div>
                    <div className="relative">
                        <NumberInput
                            value={settings.tip.lengthMm}
                            onChange={(val) => updateTipProfile({ lengthMm: val })}
                            step={0.1}
                            showStepper={false}
                            {...getInputProps('tip.lengthMm', compactInputClass)}
                        />
                        {unitHint('mm')}
                    </div>
                </div>
            )}

            {(activeKind === 'trunk' || activeKind === 'branch' || activeKind === 'leaf') && (
                <div className="space-y-1 min-w-0" {...fieldFocusProps('tip.coneAngleMode', () => setAnatomyPreviewActiveSettingKey('tip.coneAngleMode'), (e) => {
                    const next = e.relatedTarget as Node | null;
                    if (next && e.currentTarget.contains(next)) return;
                    setAnatomyPreviewActiveSettingKey(null);
                })}>
                    <div
                        className={isAdaptiveConeAngle ? 'grid grid-cols-2 gap-1.5 items-center' : 'flex items-center'}
                    >
                        <div className={`${compactFieldLabelClass} text-center`} style={{ color: 'var(--text-muted)' }} title="Cone Angle">Cone Angle</div>
                        {isAdaptiveConeAngle && (
                            <div className={`${compactFieldLabelClass} text-center`} style={{ color: 'var(--text-muted)' }} title="Offset">Offset</div>
                        )}
                    </div>
                    <div
                        className={isAdaptiveConeAngle ? 'grid grid-cols-2 gap-1.5 items-center' : 'flex items-center gap-1'}
                    >
                        <SelectDropdown
                            value={settings.tip.coneAngleMode ?? 'normal'}
                            onChange={(value) => updateTipProfile({ coneAngleMode: value as 'normal' | 'locked' | 'adaptive' })}
                            options={[
                                { value: 'normal', label: 'Normal' },
                                { value: 'locked', label: 'Locked' },
                                { value: 'adaptive', label: 'Adaptive' },
                            ]}
                            className={`${isAdaptiveConeAngle ? 'w-full' : 'flex-1'} min-w-0 space-y-0 h-8`}
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
                            <div className="relative h-8">
                                <NumberInput
                                    value={settings.tip.adaptiveConeAngleOffsetDeg ?? 30}
                                    onChange={(val) => updateTipProfile({ adaptiveConeAngleOffsetDeg: val })}
                                    aria-label="Adaptive offset"
                                    title="Adaptive offset"
                                    showStepper={false}
                                    {...getInputProps('tip.adaptiveConeAngleOffsetDeg', compactInputClass)}
                                />
                                {unitHint('°')}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {(activeKind === 'trunk' || activeKind === 'branch') && (
                <div className="space-y-1 min-w-0" {...makeRowFocusHandlers('shaft.diameterMm')}>
                    <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }} title="Trunk Diameter">Trunk Diameter</div>
                    <div className="relative">
                        <NumberInput
                            value={settings.shaft.diameterMm}
                            onChange={(val) => updateShaftProfile({ diameterMm: val })}
                            step={0.1}
                            showStepper={false}
                            {...getInputProps('shaft.diameterMm', compactInputClass)}
                        />
                        {unitHint('mm')}
                    </div>
                </div>
            )}

            {activeKind === 'trunk' && (
                <>
                    <div className="h-px" style={{ background: 'var(--border-subtle)' }} />

                    <div className="space-y-1 min-w-0" {...makeRowFocusHandlers('roots.diameterMm')}>
                        <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }} title="Roots Diameter">Roots Diameter</div>
                        <div className="relative">
                            <NumberInput
                                value={settings.roots.diameterMm}
                                onChange={(val) => updateRootsProfile({ diameterMm: val })}
                                step={0.1}
                                showStepper={false}
                                {...getInputProps('roots.diameterMm', compactInputClass)}
                            />
                            {unitHint('mm')}
                        </div>
                    </div>

                    <div className="space-y-2">
                        <div className="space-y-1 min-w-0" {...makeRowFocusHandlers('roots.diskHeightMm')}>
                            <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }}>Disk Height</div>
                            <div className="relative">
                                <NumberInput
                                    value={settings.roots.diskHeightMm}
                                    onChange={(val) => updateRootsProfile({ diskHeightMm: val })}
                                    step={0.1}
                                    showStepper={false}
                                    {...getInputProps('roots.diskHeightMm', compactInputClass)}
                                />
                                {unitHint('mm')}
                            </div>
                        </div>

                        <div className="space-y-1 min-w-0" {...makeRowFocusHandlers('roots.coneHeightMm')}>
                            <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }}>Cone Height</div>
                            <div className="relative">
                                <NumberInput
                                    value={settings.roots.coneHeightMm}
                                    onChange={(val) => updateRootsProfile({ coneHeightMm: val })}
                                    step={0.1}
                                    showStepper={false}
                                    {...getInputProps('roots.coneHeightMm', compactInputClass)}
                                />
                                {unitHint('mm')}
                            </div>
                        </div>
                    </div>
                </>
            )}
        </div>
    );

    const supportGeometryFieldsCompactTrunk = (
        <div className="space-y-2.5">
            <div className={compactTrunkPairClass}>
                <div className="space-y-1 min-w-0" {...makeRowFocusHandlers('tip.contactDiameterMm')}>
                    <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }} title="Contact Diameter">Contact Diameter</div>
                    <div className="relative">
                        <NumberInput
                            value={settings.tip.contactDiameterMm}
                            onChange={(val) => updateTipProfile({ contactDiameterMm: val })}
                            step={0.1}
                            showStepper={false}
                            {...getInputProps('tip.contactDiameterMm', compactInputClass)}
                        />
                        {unitHint('mm')}
                    </div>
                </div>

                <div className="space-y-1 min-w-0" {...makeRowFocusHandlers('tip.lengthMm')}>
                    <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }} title="Contact Cone Length">Contact Cone Length</div>
                    <div className="relative">
                        <NumberInput
                            value={settings.tip.lengthMm}
                            onChange={(val) => updateTipProfile({ lengthMm: val })}
                            step={0.1}
                            showStepper={false}
                            {...getInputProps('tip.lengthMm', compactInputClass)}
                        />
                        {unitHint('mm')}
                    </div>
                </div>
            </div>

            <div className="space-y-1 min-w-0" {...fieldFocusProps('tip.coneAngleMode', () => setAnatomyPreviewActiveSettingKey('tip.coneAngleMode'), (e) => {
                const next = e.relatedTarget as Node | null;
                if (next && e.currentTarget.contains(next)) return;
                setAnatomyPreviewActiveSettingKey(null);
            })}>
                <div
                    className={isAdaptiveConeAngle ? 'grid grid-cols-2 gap-1.5 items-center' : 'flex items-center'}
                >
                    <div className={`${compactFieldLabelClass} text-center`} style={{ color: 'var(--text-muted)' }} title="Cone Angle">Cone Angle</div>
                    {isAdaptiveConeAngle && (
                        <div className={`${compactFieldLabelClass} text-center`} style={{ color: 'var(--text-muted)' }} title="Offset">Offset</div>
                    )}
                </div>
                <div
                    className={isAdaptiveConeAngle ? 'grid grid-cols-2 gap-1.5 items-center' : 'flex items-center gap-1'}
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
                        <div className="relative">
                            <NumberInput
                                value={settings.tip.adaptiveConeAngleOffsetDeg ?? 30}
                                onChange={(val) => updateTipProfile({ adaptiveConeAngleOffsetDeg: val })}
                                aria-label="Adaptive offset"
                                title="Adaptive offset"
                                showStepper={false}
                                {...getInputProps('tip.adaptiveConeAngleOffsetDeg', compactInputClass)}
                            />
                            {unitHint('°')}
                        </div>
                    )}
                </div>
            </div>

            <div className={compactTrunkPairClass}>
                <div className="space-y-1 min-w-0" {...makeRowFocusHandlers('shaft.diameterMm')}>
                    <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }} title="Trunk Diameter">Trunk Diameter</div>
                    <div className="relative">
                        <NumberInput
                            value={settings.shaft.diameterMm}
                            onChange={(val) => updateShaftProfile({ diameterMm: val })}
                            step={0.1}
                            showStepper={false}
                            {...getInputProps('shaft.diameterMm', compactInputClass)}
                        />
                        {unitHint('mm')}
                    </div>
                </div>

                <div className="space-y-1 min-w-0" {...makeRowFocusHandlers('roots.diameterMm')}>
                    <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }} title="Roots Diameter">Roots Diameter</div>
                    <div className="relative">
                        <NumberInput
                            value={settings.roots.diameterMm}
                            onChange={(val) => updateRootsProfile({ diameterMm: val })}
                            step={0.1}
                            showStepper={false}
                            {...getInputProps('roots.diameterMm', compactInputClass)}
                        />
                        {unitHint('mm')}
                    </div>
                </div>
            </div>

            <div className={compactTrunkPairClass}>
                <div className="space-y-1 min-w-0" {...makeRowFocusHandlers('roots.diskHeightMm')}>
                    <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }} title="Disk Height">Disk Height</div>
                    <div className="relative">
                        <NumberInput
                            value={settings.roots.diskHeightMm}
                            onChange={(val) => updateRootsProfile({ diskHeightMm: val })}
                            step={0.1}
                            showStepper={false}
                            {...getInputProps('roots.diskHeightMm', compactInputClass)}
                        />
                        {unitHint('mm')}
                    </div>
                </div>

                <div className="space-y-1 min-w-0" {...makeRowFocusHandlers('roots.coneHeightMm')}>
                    <div className={compactFieldLabelClass} style={{ color: 'var(--text-muted)' }} title="Cone Height">Cone Height</div>
                    <div className="relative">
                        <NumberInput
                            value={settings.roots.coneHeightMm}
                            onChange={(val) => updateRootsProfile({ coneHeightMm: val })}
                            step={0.1}
                            showStepper={false}
                            {...getInputProps('roots.coneHeightMm', compactInputClass)}
                        />
                        {unitHint('mm')}
                    </div>
                </div>
            </div>
        </div>
    );

    const supportGeometryFields = shouldUseCompactTrunkLayout && activeKind === 'trunk'
        ? supportGeometryFieldsCompactTrunk
        : supportGeometryFieldsDefault;

    const activeKindIcon = activeKindMeta.icon;
    const ActiveKindIcon = activeKindIcon;

    return (
        <>


        <div ref={supportSidebarAnchorRef}>
        <Card className={expanded ? 'max-h-[calc(100dvh-var(--topbar-height)-24px)] overflow-hidden flex flex-col' : undefined}>
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
                    <div className="inline-flex items-center gap-1">
                        <IconButton
                            onClick={handleSave}
                            className={`!p-1.5 transition-colors ${saveStatus === 'saved' ? '!bg-green-600/30 !text-green-400' : saveStatus === 'error' ? '!bg-red-600/30 !text-red-400' : '!text-green-400/70 hover:!text-green-400 hover:!bg-green-600/15'}`}
                            title={saveStatus !== 'idle' ? (saveStatus === 'saved' ? 'Saved' : 'Save failed') : 'Save settings'}
                        >
                            {saveStatus === 'saved' ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
                        </IconButton>
                        <IconButton
                            onClick={handleRestoreDefaults}
                            className={`!p-1.5 transition-colors ${defaultsAnimating ? '' : '!text-red-400/70 hover:!text-red-400 hover:!bg-red-600/15'}`}
                            title="Restore defaults"
                        >
                            <RotateCcw className={`h-3.5 w-3.5 ${defaultsAnimating ? 'animate-spin-once text-orange-400' : ''}`} />
                        </IconButton>
                    </div>
                )}
            />

            {expanded && (
                <div className="px-2 pb-2 space-y-2 sm:px-2.5 sm:pb-2.5 flex flex-col flex-1 min-h-0">
                    <div ref={scrollViewportRef} className={sectionScrollClass}>
                        <div ref={scrollContentRef} className="space-y-2">
                            {showCurvePage ? (
                                <>
                                    <Section title="Curves" accent>
                                        <CurveSettingsCard embedded />
                                    </Section>
                                </>
                            ) : (
                                <>
                                    <SupportKindTabs
                                        value={tabKind}
                                        onChange={(kind) => {
                                            setAnatomyPreviewActiveSettingKey(null);
                                            setActiveSupportKind(kind);
                                        }}
                                    />

                                    {activeKind === 'raft' ? (
                                        <>
                                            {!shouldUseOverflowCompactMode ? (
                                                renderPreviewBox('h-[220px]')
                                            ) : null}
                                            <div className="rounded-md border p-2" style={SECTION_CARD_STYLE}>
                                                <RaftSettingsCard
                                                    settings={raftSettings}
                                                    onChange={(partial) => updateRaftSettings(partial)}
                                                />
                                            </div>
                                        </>
                                    ) : activeKind === 'grid' ? (
                                        <>
                                            {!shouldUseOverflowCompactMode ? (
                                                renderPreviewBox('h-[220px]')
                                            ) : null}
                                            <div className="rounded-md border p-2" style={SECTION_CARD_STYLE}>
                                                <GridSettingsCard
                                                    grid={settings.grid}
                                                    onChange={(partial) => updateGridSettings(partial)}
                                                />
                                            </div>
                                        </>
                                    ) : activeKind === 'stick' ? (
                                        <>
                                            {!shouldUseOverflowCompactMode ? (
                                                renderPreviewBox('h-[220px]')
                                            ) : null}
                                            <div className="rounded-md border p-2" style={SECTION_CARD_STYLE}>
                                                <AutoBracingSettingsCard
                                                    settings={settings.autoBracing}
                                                    onChange={(partial) => updateAutoBracingSettings(partial)}
                                                    onAutoBrace={handleAutoBrace}
                                                    status={autoBraceStatus}
                                                />
                                            </div>
                                        </>
                                    ) : activeKind === 'trunk' ? (
                                        <>
                                            {shouldUseCompactTrunkLayout ? (
                                                <div className="rounded-md border p-2" style={SECTION_CARD_STYLE}>
                                                    {supportGeometryFields}
                                                </div>
                                            ) : (
                                                <div className="flex gap-2 items-stretch">
                                                    <div className="w-1/2 min-w-0 flex flex-col">
                                                        {renderPreviewBox('flex-1 min-h-[340px]')}
                                                    </div>

                                                    <div className="w-1/2 min-w-0 rounded-md border p-2" style={SECTION_CARD_STYLE}>
                                                        {supportGeometryFields}
                                                    </div>
                                                </div>
                                            )}

                                            <div className="rounded-md border p-2" style={SECTION_CARD_STYLE}>
                                                <PresetSelector
                                                    selectedPresetIdOverride={effectivePresetIdOverride}
                                                    disableGlobalPresetActivation={Boolean(editableTarget)}
                                                    onPresetSelected={(presetId) => {
                                                        const preset = getPresetById(presetId);
                                                        if (!preset) return;

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
                                                        applySettingsToAllSelectedSupports(nextSettings);
                                                        setOptimisticPresetId(presetId);
                                                    }}
                                                />
                                            </div>
                                        </>
                                    ) : (
                                        <>
                                            {renderPreviewBox('h-[250px]')}

                                            <div className="rounded-md border p-2" style={SECTION_CARD_STYLE}>
                                                {supportGeometryFields}
                                            </div>
                                        </>
                                    )}
                                </>
                            )}
                        </div>
                    </div>

                </div>
            )}
        </Card>
        </div>

        {shouldShowFloatingTrunkPreview && floatingTrunkPreviewPlacement && typeof document !== 'undefined' && ReactDOM.createPortal(
            <div
                className="fixed z-[115] pointer-events-none rounded-lg border p-2 shadow-2xl flex flex-col"
                style={{
                    top: floatingTrunkPreviewPlacement.top,
                    left: floatingTrunkPreviewPlacement.left,
                    width: floatingTrunkPreviewPlacement.width,
                    height: floatingTrunkPreviewPlacement.height,
                    opacity: floatingTrunkPreviewFadingOut ? 0 : 1,
                    transform: floatingTrunkPreviewFadingOut ? 'translateY(6px)' : 'translateY(0px)',
                    transition: 'opacity 240ms ease, transform 240ms ease',
                    borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 70%)',
                    background: 'color-mix(in srgb, var(--surface-0), #000 12%)',
                    boxShadow: '0 18px 34px color-mix(in srgb, var(--surface-0), black 44%)',
                }}
                aria-hidden="true"
            >
                <div
                    className="w-full flex-1 min-h-0 rounded-md border overflow-hidden"
                    style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
                >
                    <SupportAnatomyPreviewSlot />
                </div>
            </div>,
            document.body,
        )}
        </>
    );
}
