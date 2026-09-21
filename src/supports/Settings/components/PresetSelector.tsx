"use client";

import React, { useState, useEffect, useRef, useSyncExternalStore } from 'react';
import ReactDOM from 'react-dom';
import { PenLine, Pencil, Trash2, Save, Pin, PinOff } from 'lucide-react';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import {
    formatBulkDeletePresetsAction,
    formatBulkDeletePresetsTitle,
    formatDeletePresetTitle,
    formatOverwritePresetTitle,
    formatPresetSlotLabel,
    translatePresetName,
} from '@/supports/Settings/presetMessages';
import {
    getPresetList,
    getActivePreset,
    getPinnedPresets,
    getUnpinnedPresets,
    getPresetForPinnedSlot,
    setActivePreset,
    subscribeToPresets,
    savePreset,
    updateCustomPresetMetadata,
    createPreset,
    deletePreset,
    deletePresets,
    setPresetPinnedSlot,
    movePresetBefore,
    isPresetDirtyForSettings,
    restoreFactoryDefaults,
} from '../presets';
import { getSettings, subscribeToSettings } from '../state';
import { setAnatomyPreviewHoveredPresetSettings } from '../AnatomyPreview/previewState';

type PresetSelectorProps = {
    selectedPresetIdOverride?: string | null;
    onPresetSelected?: (presetId: string) => void;
    disableGlobalPresetActivation?: boolean;
    /** Incremented externally to trigger a save of the currently-selected
     *  dirty preset (e.g. from the Support Studio save button). */
    saveTrigger?: number;
};

/** Travel before a press on a preset row becomes a drag rather than a click. */
const PRESET_DRAG_THRESHOLD_PX = 4;

/**
 * Where a dragged preset would land: a slot, in front of a listed preset, the
 * end of the list, or outside the Support Studio panel, which is a delete
 * gesture. `key` is what the highlight compares, since the target is rebuilt on
 * every pointer move.
 */
type PresetDropTarget =
    | { key: string; kind: 'slot'; slot: number }
    | { key: string; kind: 'row'; presetId: string }
    | { key: string; kind: 'list' }
    | { key: string; kind: 'delete' };

/** Outline for the cell a dragged preset would land in. */
const PRESET_DROP_TARGET_STYLE: React.CSSProperties = {
    borderRadius: '5px',
    outline: '1px dashed color-mix(in srgb, var(--accent), transparent 20%)',
    outlineOffset: '1px',
};

export function PresetSelector({
    selectedPresetIdOverride,
    onPresetSelected,
    disableGlobalPresetActivation = false,
    saveTrigger,
}: PresetSelectorProps) {
    const { _ } = useLingui();
    const settings = useSyncExternalStore(subscribeToSettings, getSettings, getSettings);
    const [presets, setPresets] = useState(() => getPresetList());
    const [activePreset, setActivePresetState] = useState(() => getActivePreset());
    const [confirmId, setConfirmId] = useState<string | null>(null);
    const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
    const [hoveredPresetId, setHoveredPresetId] = useState<string | null>(null);
    const [isEditingName, setIsEditingName] = useState(false);
    const [renamingPresetId, setRenamingPresetId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState('');
    const renameInputRef = useRef<HTMLInputElement | null>(null);
    const [tempName, setTempName] = useState('');
    const [tempDescription, setTempDescription] = useState('');
    const [newPresetName, setNewPresetName] = useState(() => _(msg`My Preset`));
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; presetId: string } | null>(null);
    const [pinSubmenuOpen, setPinSubmenuOpen] = useState(false);
    const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);
    const contextMenuRef = useRef<HTMLDivElement | null>(null);
    const pinSubmenuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Global click listener to dismiss the context menu
    useEffect(() => {
        if (!contextMenu) return;
        const handleClick = (e: MouseEvent) => {
            if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
                setContextMenu(null);
            }
        };
        // Delay attachment so the right-click event doesn't immediately dismiss it
        requestAnimationFrame(() => window.addEventListener('click', handleClick));
        return () => window.removeEventListener('click', handleClick);
    }, [contextMenu]);

    useEffect(() => {
        const unsubscribe = subscribeToPresets(() => {
            setPresets(getPresetList());
            setActivePresetState(getActivePreset());
        });
        return unsubscribe;
    }, []);

    const pinnedPresets = getPinnedPresets();
    const unpinnedPresets = getUnpinnedPresets();
    const availableSlots = [1, 2, 3, 4, 5, 6].filter((slot) => !pinnedPresets.some((p) => p.pinnedSlot === slot));

    // Dragging a preset to a slot pins it there, and dragging one onto the list
    // below the slots unpins it. The context menu's Pin/Unpin entries stay the
    // keyboard path: a drag is not reachable without a pointer.
    //
    // Pointer events, not HTML5 drag and drop. Tauri leaves `dragDropEnabled`
    // on (the window takes OS file drops, which is how a mesh is imported), and
    // on Windows that makes the webview reject every page-level drag: the
    // cursor turns into the no-drop one and no `dragstart` is delivered, so an
    // HTML5 drag cannot even begin. Pointer events are unaffected, and they are
    // how the rest of the app already drags things.
    const [presetDragId, setPresetDragId] = useState<string | null>(null);
    const [presetDropTarget, setPresetDropTarget] = useState<PresetDropTarget | null>(null);
    const [presetDragPoint, setPresetDragPoint] = useState<{ x: number; y: number } | null>(null);
    const presetDragStartRef = useRef<{ id: string; x: number; y: number; pointerId: number } | null>(null);
    const presetDragMovedRef = useRef(false);
    /** The Support Studio panel the drag started in, for the outside test. */
    const presetDragPanelRef = useRef<Element | null>(null);

    /** The slot, row, list or outside-panel target under the pointer. */
    function presetDropTargetAt(x: number, y: number): PresetDropTarget | null {
        const panel = presetDragPanelRef.current;
        if (panel) {
            const rect = panel.getBoundingClientRect();
            const insidePanel = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
            // Off the panel is the delete gesture, so it wins over the cells:
            // the rail is scrolled, and a cell can sit under a point the pointer
            // reached by leaving the panel.
            if (!insidePanel) return { key: 'delete', kind: 'delete' };
        }

        const element = document.elementFromPoint(x, y);
        if (!element) return null;

        const slot = element.closest('[data-preset-slot]');
        if (slot) {
            const value = Number(slot.getAttribute('data-preset-slot'));
            return { key: `slot:${value}`, kind: 'slot', slot: value };
        }

        const presetId = element.closest('[data-preset-row]')?.getAttribute('data-preset-row');
        if (presetId) return { key: `row:${presetId}`, kind: 'row', presetId };

        return element.closest('[data-preset-drop-list]') ? { key: 'list', kind: 'list' } : null;
    }

    /**
     * Off the panel the pointer becomes a trash can, on the body so it beats
     * the cursor of whatever cell is under it. The ghost carries the same icon,
     * which is the part that shows even when a cursor cannot be loaded.
     */
    useEffect(() => {
        const offPanel = presetDropTarget?.kind === 'delete';
        document.body.classList.toggle('preset-drag-delete', offPanel);
        return () => document.body.classList.remove('preset-drag-delete');
    }, [presetDropTarget]);

    function endPresetDrag() {
        presetDragStartRef.current = null;
        setPresetDragId(null);
        setPresetDropTarget(null);
        setPresetDragPoint(null);
    }

    function handlePresetDrop(draggedId: string, target: PresetDropTarget) {
        const dragged = presets.find((preset) => preset.id === draggedId);
        if (!dragged) return;

        if (target.kind === 'delete') {
            // Dragged off the panel: ask before anything goes. Dragging one of
            // a multi-selection takes the whole selection with it.
            if (presetSelection.includes(dragged.id) && presetSelection.length > 1) {
                setBulkDeleteOpen(true);
                return;
            }
            setDeleteConfirmId(dragged.id);
            return;
        }

        if (target.kind === 'row') {
            // Out of the rail and into the list, where it landed.
            if (dragged.pinnedSlot != null) setPresetPinnedSlot(dragged.id, null);
            movePresetBefore(dragged.id, target.presetId);
            return;
        }

        if (target.kind === 'list') {
            if (dragged.pinnedSlot != null) {
                setPresetPinnedSlot(dragged.id, null);
                return;
            }
            movePresetBefore(dragged.id, null);
            return;
        }

        if (dragged.pinnedSlot === target.slot) return;
        const occupant = getPresetForPinnedSlot(target.slot);
        // Slot to slot is a swap, so moving a preset across the rail never
        // drops the other one out of it. From the list there is no slot to hand
        // back, so the occupant leaves the rail.
        if (occupant && dragged.pinnedSlot != null) {
            setPresetPinnedSlot(occupant.id, dragged.pinnedSlot);
        }
        setPresetPinnedSlot(dragged.id, target.slot);
    }

    function handlePresetPointerDown(event: React.PointerEvent<HTMLButtonElement>, presetId: string) {
        if (event.button !== 0) return;
        presetDragStartRef.current = {
            id: presetId,
            x: event.clientX,
            y: event.clientY,
            pointerId: event.pointerId,
        };
        presetDragMovedRef.current = false;
        presetDragPanelRef.current = event.currentTarget.closest('[data-support-studio-panel]');
        // Capture so the moves and the release keep arriving here while the
        // pointer is over another cell.
        event.currentTarget.setPointerCapture(event.pointerId);
    }

    function handlePresetPointerMove(event: React.PointerEvent<HTMLButtonElement>) {
        const start = presetDragStartRef.current;
        if (!start || start.pointerId !== event.pointerId) return;

        if (!presetDragMovedRef.current) {
            // A press that has not travelled is a click, not a drag.
            if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < PRESET_DRAG_THRESHOLD_PX) return;
            presetDragMovedRef.current = true;
            setPresetDragId(start.id);
        }

        setPresetDragPoint({ x: event.clientX, y: event.clientY });
        const target = presetDropTargetAt(event.clientX, event.clientY);
        setPresetDropTarget((current) => (current?.key === target?.key ? current : target));
    }

    function handlePresetPointerUp(event: React.PointerEvent<HTMLButtonElement>) {
        const start = presetDragStartRef.current;
        if (!start) return;
        const dropped = presetDragMovedRef.current
            ? presetDropTargetAt(event.clientX, event.clientY)
            : null;
        endPresetDrag();
        if (dropped == null) return;
        handlePresetDrop(start.id, dropped);
    }

    const presetDragPreset = presetDragId ? presets.find((preset) => preset.id === presetDragId) ?? null : null;
    const presetDragOffPanel = presetDropTarget?.kind === 'delete';

    // Multi-selection over the unpinned list: Ctrl/Cmd toggles a preset,
    // Shift takes the range from the applied preset (or the last one toggled).
    // It drives bulk actions only, so a plain click still applies a preset and
    // clears it.
    const [presetSelection, setPresetSelection] = useState<string[]>([]);
    const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
    const unpinnedIds = unpinnedPresets.map((preset) => preset.id);
    const selectedPresets = presetSelection
        .map((id) => presets.find((preset) => preset.id === id))
        .filter((preset): preset is (typeof presets)[number] => Boolean(preset));

    function handlePresetRowClick(event: React.MouseEvent<HTMLButtonElement>, preset: (typeof presets)[number]) {
        // The press that just dragged is not a click.
        if (presetDragMovedRef.current) {
            presetDragMovedRef.current = false;
            return;
        }

        // A pinned row is not part of the multi-selection: it applies, whatever
        // modifiers are held, so Ctrl cannot pick up a slot.
        if (preset.pinnedSlot != null) {
            setPresetSelection([]);
            handlePresetSelect(preset.id);
            return;
        }

        const presetId = preset.id;
        const additive = event.ctrlKey || event.metaKey;
        if (event.shiftKey) {
            const anchorId = effectiveSelectedPresetId && unpinnedIds.includes(effectiveSelectedPresetId)
                ? effectiveSelectedPresetId
                : presetSelection[presetSelection.length - 1] ?? presetId;
            const from = unpinnedIds.indexOf(anchorId);
            const to = unpinnedIds.indexOf(presetId);
            if (from < 0 || to < 0) return;
            const range = unpinnedIds.slice(Math.min(from, to), Math.max(from, to) + 1);
            setPresetSelection((current) => (additive ? [...new Set([...current, ...range])] : range));
            return;
        }

        if (additive) {
            setPresetSelection((current) => (current.includes(presetId)
                ? current.filter((id) => id !== presetId)
                : [...current, presetId]));
            return;
        }

        setPresetSelection([]);
        handlePresetSelect(presetId);
    }

    const effectiveSelectedPresetId = selectedPresetIdOverride === undefined
        ? activePreset?.id ?? null
        : selectedPresetIdOverride;
    const selectedPreset = effectiveSelectedPresetId
        ? presets.find((preset) => preset.id === effectiveSelectedPresetId) ?? null
        : null;
    const hoveredPreset = hoveredPresetId ? presets.find((preset) => preset.id === hoveredPresetId) ?? null : null;
    const previewDescription = hoveredPreset?.description ?? selectedPreset?.description ?? '';
    const selectedPresetIsDirty = isPresetDirtyForSettings(effectiveSelectedPresetId, settings);

    // The preset a confirm dialog acts on: the one the request named, which is
    // not necessarily the selection. A right-clicked preset is the target
    // without becoming active, and `selectedPreset` lags the request by a
    // render, so gating the dialog on it dropped the request instead of showing
    // the dialog.
    const confirmPreset = confirmId ? presets.find((preset) => preset.id === confirmId) ?? null : null;
    const deleteConfirmPreset = deleteConfirmId
        ? presets.find((preset) => preset.id === deleteConfirmId) ?? null
        : null;

    // Keep a ref so the save-trigger effect always reads the latest values
    // without needing them as effect dependencies.
    const effectiveSelectedPresetIdRef = useRef(effectiveSelectedPresetId);
    effectiveSelectedPresetIdRef.current = effectiveSelectedPresetId;
    const settingsRef = useRef(settings);
    settingsRef.current = settings;

    // When the parent save button triggers a save, persist any dirty preset
    // changes from within the same component scope so the dirty indicator
    // clears reliably.
    useEffect(() => {
        if (saveTrigger === undefined || saveTrigger === 0) return;
        const presetId = effectiveSelectedPresetIdRef.current;
        if (!presetId) return;
        if (!isPresetDirtyForSettings(presetId, settingsRef.current)) return;
        savePreset(presetId);
    }, [saveTrigger]);

    useEffect(() => {
        if (!selectedPreset) {
            setTempName('');
            setTempDescription('');
            setIsEditingName(false);
            return;
        }

        if (!isEditingName) {
            setTempName(selectedPreset.name);
            setTempDescription(selectedPreset.description ?? '');
        }
    }, [selectedPreset, isEditingName]);

    // Dynamically calculate the available space for the preset list so we only shrink
    // it as much as needed to avoid the outer Support Studio panel becoming scrollable.
    const wrapperRef = useRef<HTMLDivElement | null>(null);
    const [computedMaxHeight, setComputedMaxHeight] = useState<string>('19rem');

    // Dynamically calculate the available space for the preset list so it never
    // overflows the outer Support Studio panel.
    useEffect(() => {
        function recalc() {
            if (!wrapperRef.current) return;
            const rect = wrapperRef.current.getBoundingClientRect();
            const top = rect.top;
            const viewportHeight = window.innerHeight;

            // Reserve 48px for the action button row below the list.
            const available = Math.max(120, viewportHeight - top - 48 - 24);
            const maxClamp = 304;
            const final = Math.min(available, maxClamp);
            setComputedMaxHeight(`${final}px`);
        }

        recalc();
        window.addEventListener('resize', recalc);
        return () => window.removeEventListener('resize', recalc);
    }, []);

    function renderPresetRow(preset: (typeof presets)[number]) {
        const isSelected = effectiveSelectedPresetId === preset.id;
        const showDirtyIndicator = isSelected && selectedPresetIsDirty;
        const isMultiSelected = presetSelection.includes(preset.id);

        return (
            <button
                type="button"
                className="w-full px-3 py-2 text-sm relative rounded-[5px] border transition-colors cursor-grab active:cursor-grabbing select-none"
                onPointerDown={(event) => handlePresetPointerDown(event, preset.id)}
                onPointerMove={handlePresetPointerMove}
                onPointerUp={handlePresetPointerUp}
                onPointerCancel={endPresetDrag}
                onClick={(event) => handlePresetRowClick(event, preset)}
                onMouseEnter={() => {
                    setHoveredPresetId(preset.id);
                    setAnatomyPreviewHoveredPresetSettings(preset.settings);
                }}
                onMouseLeave={() => {
                    setHoveredPresetId(null);
                    setAnatomyPreviewHoveredPresetSettings(null);
                }}
                onFocus={() => {
                    setHoveredPresetId(preset.id);
                    setAnatomyPreviewHoveredPresetSettings(preset.settings);
                }}
                onBlur={() => {
                    setHoveredPresetId(null);
                    setAnatomyPreviewHoveredPresetSettings(null);
                }}
                style={{
                    background: isMultiSelected
                        ? 'color-mix(in srgb, var(--accent), var(--surface-0) 84%)'
                        : isSelected
                            ? preset.pinnedSlot != null
                                ? 'color-mix(in srgb, var(--accent-secondary), var(--surface-0) 88%)'
                                : 'color-mix(in srgb, var(--primary-button-surface), var(--surface-0) 90%)'
                            : 'var(--surface-0)',
                    borderColor: isMultiSelected
                        ? 'color-mix(in srgb, var(--accent), var(--border-subtle) 40%)'
                        : isSelected
                            ? preset.pinnedSlot != null
                                ? 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 25%)'
                                : 'color-mix(in srgb, var(--primary-button-surface), var(--border-subtle) 30%)'
                            : 'var(--border-subtle)',
                    opacity: presetDragId === preset.id ? 0.45 : undefined,
                }}
            >
                {isSelected && preset.pinnedSlot == null ? (
                    <span
                        aria-hidden="true"
                        className="pointer-events-none absolute left-2 top-1/2 inline-block h-2 w-2 -translate-y-1/2 rounded-full border"
                        style={{
                            background: 'var(--primary-button-surface)',
                            borderColor: 'color-mix(in srgb, var(--primary-button-surface), var(--surface-0) 40%)',
                        }}
                    />
                ) : null}
                {showDirtyIndicator ? (
                    <span
                        aria-hidden="true"
                        title={_(msg`Preset has unsaved changes`)}
                        className="pointer-events-none absolute right-2 top-1/2 inline-flex -translate-y-1/2"
                        style={{ color: isSelected ? 'var(--text-muted)' : 'var(--text-muted)' }}
                    >
                        <PenLine className="h-3 w-3" />
                    </span>
                ) : null}
                <div className="w-full min-w-0">
                    <div className="relative flex items-center justify-center text-center">
                        {preset.pinnedSlot != null ? (
                            <span
                                className="absolute left-0 inline-flex h-4 w-4 items-center justify-center rounded-[3px] text-[11px] font-bold tabular-nums leading-none"
                                style={{
                                    background: 'color-mix(in srgb, var(--accent), transparent 78%)',
                                    color: 'var(--accent)',
                                }}
                            >
                                {preset.pinnedSlot}
                            </span>
                        ) : null}
                        {renamingPresetId === preset.id ? (
                            <input
                                ref={renameInputRef}
                                type="text"
                                value={renameValue}
                                onChange={(e) => setRenameValue(e.target.value)}
                                onBlur={() => commitInlineRename()}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        e.stopPropagation();
                                        commitInlineRename();
                                    } else if (e.key === 'Escape') {
                                        e.stopPropagation();
                                        cancelInlineRename();
                                    }
                                }}
                                onClick={(e) => e.stopPropagation()}
                                className="w-full bg-transparent text-center text-sm outline-none border-b"
                                style={{
                                    color: 'var(--text-strong)',
                                    borderColor: 'var(--accent)',
                                }}
                            />
                        ) : (
                            <div className="flex-1 truncate" style={{ color: isSelected ? 'var(--text-strong)' : undefined }}>
                                {translatePresetName(preset, _)}
                            </div>
                        )}
                    </div>
                </div>
            </button>
        );
    }

    const handlePresetSelect = (presetId: string) => {
        if (presetId === '__separator') {
            return;
        }

        if (!disableGlobalPresetActivation) {
            setActivePreset(presetId);
        }
        onPresetSelected?.(presetId);
        setHoveredPresetId(null);
        setConfirmId(null);
        setDeleteConfirmId(null);
        setIsEditingName(false);
    };

    const startInlineRename = (presetId: string) => {
        const preset = presets.find((p) => p.id === presetId);
        if (!preset) return;
        setRenamingPresetId(presetId);
        setRenameValue(preset.name);
        // Auto-focus after render
        requestAnimationFrame(() => {
            renameInputRef.current?.focus();
            renameInputRef.current?.select();
        });
    };

    const commitInlineRename = () => {
        if (!renamingPresetId) return;
        const trimmed = renameValue.trim();
        if (trimmed.length > 0) {
            updateCustomPresetMetadata(renamingPresetId, trimmed, '');
        }
        setRenamingPresetId(null);
        setRenameValue('');
    };

    const cancelInlineRename = () => {
        setRenamingPresetId(null);
        setRenameValue('');
    };

    const handleEditClick = () => {
        if (!selectedPreset || selectedPreset.isBuiltIn) return;

        if (isEditingName) {
            const trimmed = tempName.trim();
            if (trimmed.length > 0) {
                updateCustomPresetMetadata(selectedPreset.id, trimmed, tempDescription);
            } else {
                setTempName(selectedPreset.name);
            }
            setTempDescription(
                tempDescription.trim().length > 0
                    ? tempDescription.trim()
                    : _(msg`User custom preset`),
            );
            setIsEditingName(false);
            return;
        }

        setTempName(selectedPreset.name);
        setTempDescription(selectedPreset.description ?? '');
        setIsEditingName(true);
    };

    const handleContextMenu = (e: React.MouseEvent, presetId: string) => {
        const preset = presets.find((p) => p.id === presetId);
        if (!preset || preset.isBuiltIn) return;
        e.preventDefault();
        e.stopPropagation();
        // Dismiss any other open context menus (e.g. the floating panel's "Reset this window" menu)
        window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));

        const menuWidth = 192; // w-48
        const menuEstimatedHeight = 300;
        const margin = 10;
        let x = e.clientX;
        let y = e.clientY;
        if (x + menuWidth + margin > window.innerWidth) {
            x = window.innerWidth - menuWidth - margin;
        }
        if (y + menuEstimatedHeight + margin > window.innerHeight) {
            y = window.innerHeight - menuEstimatedHeight - margin;
        }

        setContextMenu({ x, y, presetId: preset.id });
        setPinSubmenuOpen(false);
    };

    const handleCreateNewClick = () => {
        const created = createPreset(newPresetName);
        setActivePreset(created.id);
        setConfirmId(null);
        setIsEditingName(false);
        // Auto-enter inline rename for the new preset
        setRenamingPresetId(created.id);
        setRenameValue(created.name);
        setNewPresetName(_(msg`My Preset`));
        requestAnimationFrame(() => {
            renameInputRef.current?.focus();
            renameInputRef.current?.select();
        });
    };

    return (
        <div className="space-y-2">
            <div className="space-y-1">
                <div ref={wrapperRef}>
                    <div
                        className="overflow-y-auto custom-scrollbar py-1 transition-[max-height] duration-200"
                        style={{ maxHeight: computedMaxHeight }}
                        onContextMenu={(e) => {
                            // Only handle clicks on the background/empty space, not on preset cells
                            if ((e.target as HTMLElement).closest('[data-preset-cell]')) return;
                            if (!effectiveSelectedPresetId) return;
                            handleContextMenu(e, effectiveSelectedPresetId);
                        }}
                        onPointerDown={(e) => {
                            // A press on the empty rail clears the selection; a
                            // right-click does not, so right-clicking inside a
                            // selection can act on it.
                            if (e.button !== 0) return;
                            if ((e.target as HTMLElement).closest('[data-preset-cell]')) return;
                            setPresetSelection([]);
                        }}
                    >
                        <div className="grid grid-cols-2 gap-1 px-1">
                            {[1, 2, 3, 4, 5, 6].map((slot) => {
                                const preset = pinnedPresets.find((p) => p.pinnedSlot === slot);
                                const isDropTarget = presetDropTarget?.kind === 'slot' && presetDropTarget.slot === slot;
                                const dropStyle = isDropTarget ? PRESET_DROP_TARGET_STYLE : undefined;
                                return preset ? (
                                    <div
                                        key={preset.id}
                                        data-preset-cell
                                        data-preset-slot={slot}
                                        onContextMenu={(e) => handleContextMenu(e, preset.id)}
                                        style={dropStyle}
                                    >
                                        {renderPresetRow(preset)}
                                    </div>
                                ) : (
                                    <div key={`empty-slot-${slot}`} data-preset-slot={slot} style={dropStyle}>
                                        <button
                                            type="button"
                                            disabled
                                            className="pointer-events-none w-full rounded-[5px] border border-dashed px-3 py-2 text-sm relative"
                                            style={{
                                                color: 'color-mix(in srgb, var(--text-muted), transparent 40%)',
                                                borderColor: 'color-mix(in srgb, var(--border-subtle), transparent 40%)',
                                            }}
                                        >
                                            <div className="w-full min-w-0">
                                                <div className="relative flex items-center justify-center text-center">
                                                    <span
                                                        className="absolute left-0 inline-flex h-4 w-4 items-center justify-center rounded-[3px] text-[11px] font-bold tabular-nums leading-none"
                                                        style={{
                                                            background: 'color-mix(in srgb, var(--text-muted), transparent 84%)',
                                                            color: 'color-mix(in srgb, var(--text-muted), transparent 40%)',
                                                        }}
                                                    >
                                                        {slot}
                                                    </span>
                                                    <div className="flex-1 truncate">Slot {slot}</div>
                                                </div>
                                            </div>
                                        </button>
                                    </div>
                                );
                            })}
                        </div>

                        <div className="mx-3 mt-4 mb-3 border-t" style={{ borderColor: 'var(--border-subtle)' }} />

                        <div
                            className="grid grid-cols-2 gap-1 px-1"
                            data-preset-drop-list
                            style={presetDropTarget?.kind === 'list' ? PRESET_DROP_TARGET_STYLE : undefined}
                        >
                            {unpinnedPresets.map((preset) => (
                                <div
                                    key={preset.id}
                                    data-preset-cell
                                    data-preset-row={preset.id}
                                    onContextMenu={(e) => handleContextMenu(e, preset.id)}
                                    style={presetDropTarget?.kind === 'row' && presetDropTarget.presetId === preset.id
                                        ? PRESET_DROP_TARGET_STYLE
                                        : undefined}
                                >
                                    {renderPresetRow(preset)}
                                </div>
                            ))}
                            <button
                                type="button"
                                onClick={() => handleCreateNewClick()}
                                className="w-full rounded-[5px] border border-dashed px-3 py-2 text-sm transition-colors"
                                style={{
                                    color: 'var(--text-muted)',
                                    borderColor: 'color-mix(in srgb, var(--border-subtle), transparent 20%)',
                                }}
                            >
                                <div className="flex items-center justify-center gap-1.5">
                                    <Save className="h-3.5 w-3.5" />
                                    <span>New Preset</span>
                                </div>
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {/* ── Overwrite Preset Modal ─────────────────────────────────── */}
            <StructuredDialogModal
                open={confirmPreset !== null}
                ariaLabel={_(msg`Overwrite preset`)}
                title={formatOverwritePresetTitle(confirmPreset ? translatePresetName(confirmPreset, _) : '', _)}
                subtitle={_(msg`This will replace the preset with your current settings.`)}
                icon={<Save className="h-4 w-4" />}
                iconTone="accent"
                zIndexClassName="z-[300]"
                closeAriaLabel={_(msg`Cancel overwrite`)}
                onClose={() => setConfirmId(null)}
                actions={(
                    <>
                        <button
                            type="button"
                            className="ui-button ui-button-secondary !h-9 w-full px-3 text-xs"
                            onClick={() => setConfirmId(null)}
                        >
                            <Trans>Cancel</Trans>
                        </button>
                        <button
                            type="button"
                            className="ui-button !h-9 w-full px-3 text-xs inline-flex items-center justify-center gap-1.5"
                            style={{
                                borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 45%)',
                                background: 'color-mix(in srgb, var(--accent), var(--surface-1) 86%)',
                                color: 'var(--accent)',
                            }}
                            onClick={() => {
                                if (confirmPreset) {
                                    savePreset(confirmPreset.id);
                                }
                                setConfirmId(null);
                            }}
                        >
                            <Save className="h-3.5 w-3.5" />
                            <Trans>Save</Trans>
                        </button>
                    </>
                )}
            >
                <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                    <Trans>Overwrite the preset <strong style={{ color: 'var(--text-strong)' }}>{confirmPreset ? translatePresetName(confirmPreset, _) : ''}</strong> with the current scene settings?</Trans>
                </p>
            </StructuredDialogModal>

            {/* ── Delete Preset Modal ────────────────────────────────────── */}
            <StructuredDialogModal
                open={deleteConfirmPreset !== null}
                ariaLabel={_(msg`Delete preset`)}
                title={formatDeletePresetTitle(deleteConfirmPreset ? translatePresetName(deleteConfirmPreset, _) : '', _)}
                subtitle={_(msg`This action cannot be undone.`)}
                icon={<Trash2 className="h-4 w-4" />}
                iconTone="warning"
                zIndexClassName="z-[300]"
                closeAriaLabel={_(msg`Cancel delete`)}
                onClose={() => setDeleteConfirmId(null)}
                actions={(
                    <>
                        <button
                            type="button"
                            className="ui-button ui-button-secondary !h-9 w-full px-3 text-xs"
                            onClick={() => setDeleteConfirmId(null)}
                        >
                            <Trans>Cancel</Trans>
                        </button>
                        <button
                            type="button"
                            className="ui-button !h-9 w-full px-3 text-xs inline-flex items-center justify-center gap-1.5"
                            style={{
                                borderColor: 'color-mix(in srgb, #ef4444, var(--border-subtle) 45%)',
                                background: 'color-mix(in srgb, #ef4444, var(--surface-1) 86%)',
                                color: 'var(--danger)',
                            }}
                            onClick={() => {
                                if (deleteConfirmPreset) {
                                    deletePreset(deleteConfirmPreset.id);
                                }
                                setDeleteConfirmId(null);
                                setIsEditingName(false);
                            }}
                        >
                            <Trash2 className="h-3.5 w-3.5" />
                            <Trans>Delete</Trans>
                        </button>
                    </>
                )}
            >
                <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                    <Trans>This will permanently remove the preset <strong style={{ color: 'var(--text-strong)' }}>{deleteConfirmPreset ? translatePresetName(deleteConfirmPreset, _) : ''}</strong> and all of its saved settings.</Trans>
                </p>
            </StructuredDialogModal>

            {/* ── Restore Defaults Modal ──────────────────────────────────── */}
            <StructuredDialogModal
                open={restoreConfirmOpen}
                ariaLabel={_(msg`Restore factory defaults`)}
                title={_(msg`Restore Factory Defaults?`)}
                subtitle={_(msg`Factory presets will be reset and user presets will be unpinned.`)}
                icon={
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                        <path d="M3 3v5h5" />
                    </svg>
                }
                iconTone="warning"
                zIndexClassName="z-[300]"
                closeAriaLabel={_(msg`Cancel restore`)}
                onClose={() => setRestoreConfirmOpen(false)}
                actions={(
                    <>
                        <button
                            type="button"
                            className="ui-button ui-button-secondary !h-9 w-full px-3 text-xs"
                            onClick={() => setRestoreConfirmOpen(false)}
                        >
                            <Trans>Cancel</Trans>
                        </button>
                        <button
                            type="button"
                            className="ui-button !h-9 w-full px-3 text-xs inline-flex items-center justify-center gap-1.5"
                            style={{
                                borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 45%)',
                                background: 'color-mix(in srgb, var(--accent), var(--surface-1) 86%)',
                                color: 'var(--accent)',
                            }}
                            onClick={() => {
                                restoreFactoryDefaults();
                                setRestoreConfirmOpen(false);
                            }}
                        >
                            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                                <path d="M3 3v5h5" />
                            </svg>
                            <Trans>Restore</Trans>
                        </button>
                    </>
                )}
            >
                <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                    <Trans>This will reset <strong style={{ color: 'var(--text-strong)' }}>Detail</strong>, <strong style={{ color: 'var(--text-strong)' }}>Structure</strong>, and <strong style={{ color: 'var(--text-strong)' }}>Anchor</strong> to their factory settings and unpin all user presets. Your user presets will <strong style={{ color: 'var(--text-strong)' }}>not</strong> be deleted.</Trans>
                </p>
            </StructuredDialogModal>

            {/* ── Bulk Delete Modal ─────────────────────────────────────── */}
            <StructuredDialogModal
                open={bulkDeleteOpen && selectedPresets.length > 0}
                ariaLabel={_(msg`Delete presets`)}
                title={formatBulkDeletePresetsTitle(selectedPresets.length, _)}
                subtitle={_(msg`This action cannot be undone.`)}
                icon={<Trash2 className="h-4 w-4" />}
                iconTone="warning"
                zIndexClassName="z-[300]"
                closeAriaLabel={_(msg`Cancel delete`)}
                onClose={() => setBulkDeleteOpen(false)}
                actions={(
                    <>
                        <button
                            type="button"
                            className="ui-button ui-button-secondary !h-9 w-full px-3 text-xs"
                            onClick={() => setBulkDeleteOpen(false)}
                        >
                            <Trans>Cancel</Trans>
                        </button>
                        <button
                            type="button"
                            className="ui-button !h-9 w-full px-3 text-xs inline-flex items-center justify-center gap-1.5"
                            style={{
                                borderColor: 'color-mix(in srgb, #ef4444, var(--border-subtle) 45%)',
                                background: 'color-mix(in srgb, #ef4444, var(--surface-1) 86%)',
                                color: 'var(--danger)',
                            }}
                            onClick={() => {
                                deletePresets(selectedPresets.map((preset) => preset.id));
                                setPresetSelection([]);
                                setBulkDeleteOpen(false);
                            }}
                        >
                            <Trash2 className="h-3.5 w-3.5" />
                            <Trans>Delete</Trans>
                        </button>
                    </>
                )}
            >
                <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                    {selectedPresets.map((preset) => translatePresetName(preset, _)).join(', ')}
                </p>
            </StructuredDialogModal>

            {/* ── Drag Ghost ───────────────────────────────────────────── */}
            {presetDragPoint && presetDragPreset ? ReactDOM.createPortal(
                <div
                    className="pointer-events-none fixed z-[200] inline-flex max-w-[220px] items-center gap-1.5 truncate rounded-[5px] border px-3 py-2 text-sm"
                    style={{
                        left: presetDragPoint.x + 12,
                        top: presetDragPoint.y + 10,
                        borderColor: presetDragOffPanel
                            ? 'color-mix(in srgb, #ef4444, var(--border-subtle) 40%)'
                            : 'color-mix(in srgb, var(--accent), var(--border-subtle) 45%)',
                        background: presetDragOffPanel
                            ? 'color-mix(in srgb, #ef4444, var(--surface-0) 84%)'
                            : 'color-mix(in srgb, var(--surface-0), #000 10%)',
                        color: presetDragOffPanel ? '#fecaca' : 'var(--text-strong)',
                        boxShadow: '0 8px 20px rgba(0, 0, 0, 0.35)',
                    }}
                >
                    {presetDragOffPanel ? <Trash2 className="h-3.5 w-3.5 shrink-0" /> : null}
                    <span className="truncate">{translatePresetName(presetDragPreset, _)}</span>
                </div>,
                document.body
            ) : null}

            {/* ── Right-click Context Menu ──────────────────────────────── */}
            {contextMenu ? ReactDOM.createPortal(
                <div
                    ref={contextMenuRef}
                    className="fixed z-[140] pointer-events-auto w-48 rounded-lg border p-1.5 shadow-xl"
                    style={{
                        left: contextMenu.x,
                        top: contextMenu.y,
                        borderColor: 'var(--border-subtle)',
                        background: 'color-mix(in srgb, var(--surface-0), #000 10%)',
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                >
                    <button
                        type="button"
                        className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] font-medium transition-colors"
                        style={{ color: 'var(--text-strong)' }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--accent), var(--surface-1) 84%)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                        onClick={() => {
                            setContextMenu(null);
                            handleCreateNewClick();
                        }}
                    >
                        <Save className="h-3.5 w-3.5" />
                        <Trans>New Preset</Trans>
                    </button>

                    <button
                        type="button"
                        className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] font-medium transition-colors"
                        style={{ color: 'var(--text-strong)' }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--accent), var(--surface-1) 84%)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                        onClick={() => {
                            const preset = presets.find((p) => p.id === contextMenu.presetId);
                            if (!preset) return;
                            handlePresetSelect(preset.id);
                            setContextMenu(null);
                            startInlineRename(preset.id);
                        }}
                    >
                        <Pencil className="h-3.5 w-3.5" />
                        <Trans>Rename</Trans>
                    </button>

                    {(() => {
                        const menuPreset = presets.find((p) => p.id === contextMenu.presetId);
                        if (!menuPreset) return null;
                        const isDirty = isPresetDirtyForSettings(menuPreset.id, settings);
                        if (!isDirty) return null;
                        return (
                            <button
                                type="button"
                                className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] font-medium transition-colors"
                                style={{ color: 'var(--text-strong)' }}
                                onMouseEnter={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--accent), var(--surface-1) 84%)'; }}
                                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                                onClick={() => {
                                    setContextMenu(null);
                                    // The right-clicked preset is the target. It is not
                                    // selected first: selecting applies that preset's
                                    // settings, replacing the ones this save captures.
                                    setConfirmId(menuPreset.id);
                                }}
                            >
                                <Save className="h-3.5 w-3.5" />
                                <Trans>Save Changes</Trans>
                            </button>
                        );
                    })()}

                    {(() => {
                        const menuPreset = presets.find((p) => p.id === contextMenu.presetId);
                        if (!menuPreset) return null;
                        const isDirty = isPresetDirtyForSettings(menuPreset.id, settings);
                        if (!isDirty) return null;
                        return (
                            <button
                                type="button"
                                className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] font-medium transition-colors"
                                style={{ color: 'var(--text-strong)' }}
                                onMouseEnter={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--accent), var(--surface-1) 84%)'; }}
                                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                                onClick={() => {
                                    setContextMenu(null);
                                    handlePresetSelect(menuPreset.id);
                                }}
                            >
                                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                                    <path d="M3 3v5h5" />
                                </svg>
                                <Trans>Revert Changes</Trans>
                            </button>
                        );
                    })()}

                    <div className="my-1 border-t" style={{ borderColor: 'var(--border-subtle)' }} />

                    {(() => {
                        const menuPreset = presets.find((p) => p.id === contextMenu.presetId);
                        if (!menuPreset) return null;
                        const isPinned = menuPreset.pinnedSlot != null;
                        const submenuWidth = 160; // w-40 = 10rem ≈ 160px
                        const contextMenuWidth = 192; // w-48 = 12rem ≈ 192px
                        const rightEdge = contextMenu.x + contextMenuWidth + submenuWidth + 12;
                        const openLeft = rightEdge > window.innerWidth;
                        return (
                            <>
                                {isPinned ? (
                                    <button
                                        type="button"
                                        className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] font-medium transition-colors"
                                        style={{ color: 'var(--text-strong)' }}
                                        onMouseEnter={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--accent), var(--surface-1) 84%)'; }}
                                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                                        onClick={() => {
                                            setPresetPinnedSlot(menuPreset.id, null);
                                            setContextMenu(null);
                                        }}
                                    >
                                        <PinOff className="h-3.5 w-3.5" />
                                        <Trans>Unpin</Trans>
                                    </button>
                                ) : null}
                                <div
                                    className="relative"
                                    onMouseEnter={() => {
                                        if (pinSubmenuTimerRef.current) clearTimeout(pinSubmenuTimerRef.current);
                                        setPinSubmenuOpen(true);
                                    }}
                                    onMouseLeave={() => {
                                        pinSubmenuTimerRef.current = setTimeout(() => setPinSubmenuOpen(false), 100);
                                    }}
                                >
                                    <button
                                        type="button"
                                        className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] font-medium transition-colors"
                                        style={{ color: 'var(--text-strong)' }}
                                        onMouseEnter={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--accent), var(--surface-1) 84%)'; }}
                                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                                    >
                                        <Pin className="h-3.5 w-3.5" />
                                        <span className="flex-1">{isPinned ? _(msg`Move Slot`) : _(msg`Pin to Slot`)}</span>
                                        <span className="text-[10px] opacity-50">{openLeft ? '◂' : '▸'}</span>
                                    </button>
                                    {pinSubmenuOpen ? (
                                        <div
                                            className={`absolute top-0 z-[141] w-40 rounded-lg border p-1.5 shadow-xl ${openLeft ? 'right-full mr-1' : 'left-full ml-1'}`}
                                            style={{
                                                borderColor: 'var(--border-subtle)',
                                                background: 'color-mix(in srgb, var(--surface-0), #000 10%)',
                                            }}
                                            onMouseEnter={() => {
                                                if (pinSubmenuTimerRef.current) clearTimeout(pinSubmenuTimerRef.current);
                                                setPinSubmenuOpen(true);
                                            }}
                                            onMouseLeave={() => {
                                                pinSubmenuTimerRef.current = setTimeout(() => setPinSubmenuOpen(false), 100);
                                            }}
                                        >
                                            {[1, 2, 3, 4, 5, 6].map((slot) => {
                                                const alreadyPinned = pinnedPresets.some((p) => p.pinnedSlot === slot);
                                                if (isPinned && menuPreset.pinnedSlot === slot) return null;
                                                return (
                                                    <button
                                                        key={slot}
                                                        type="button"
                                                        className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] font-medium transition-colors"
                                                        style={{ color: 'var(--text-strong)' }}
                                                        onMouseEnter={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--accent), var(--surface-1) 84%)'; }}
                                                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                                                        onClick={() => {
                                                            setPresetPinnedSlot(menuPreset.id, slot);
                                                            setContextMenu(null);
                                                        }}
                                                    >
                                                        <span className="inline-flex h-4 w-4 items-center justify-center rounded-[3px] text-[10px] font-bold tabular-nums leading-none"
                                                            style={{
                                                                background: alreadyPinned
                                                                    ? 'color-mix(in srgb, var(--text-muted), transparent 80%)'
                                                                    : 'color-mix(in srgb, var(--accent), transparent 78%)',
                                                                color: alreadyPinned ? 'var(--text-muted)' : 'var(--accent)',
                                                            }}
                                                        >
                                                            {slot}
                                                        </span>
                                                        <span className="flex-1">{formatPresetSlotLabel(slot, _)}</span>
                                                        {alreadyPinned ? (
                                                            <span className="text-[10px] opacity-40">{_(msg({ message: 'occupied', comment: 'Marks a pin slot already taken by another preset. Lowercase, shown small and dimmed at the end of the row.' }))}</span>
                                                        ) : null}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    ) : null}
                                </div>
                            </>
                        );
                    })()}

                    <div className="my-1 border-t" style={{ borderColor: 'var(--border-subtle)' }} />

                    <button
                        type="button"
                        className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] font-medium transition-colors"
                        style={{ color: 'var(--text-strong)' }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--accent), var(--surface-1) 84%)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                        onClick={() => {
                            setContextMenu(null);
                            setRestoreConfirmOpen(true);
                        }}
                    >
                        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                            <path d="M3 3v5h5" />
                        </svg>
                        <Trans>Restore Defaults</Trans>
                    </button>

                    <div className="my-1 border-t" style={{ borderColor: 'var(--border-subtle)' }} />

                    <button
                        type="button"
                        className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] font-medium transition-colors"
                        style={{ color: 'var(--danger)' }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--danger), var(--surface-1) 90%)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                        onClick={() => {
                            const preset = presets.find((p) => p.id === contextMenu.presetId);
                            if (!preset) return;
                            setIsEditingName(false);
                            setContextMenu(null);
                            // Right-clicking inside a multi-selection acts on the
                            // selection, the way a file list does.
                            if (presetSelection.includes(preset.id) && presetSelection.length > 1) {
                                setBulkDeleteOpen(true);
                                return;
                            }
                            // Only the delete is asked for: selecting the preset
                            // first would apply its settings on the way out.
                            setDeleteConfirmId(preset.id);
                        }}
                    >
                        <Trash2 className="h-3.5 w-3.5" />
                        {presetSelection.includes(contextMenu.presetId) && presetSelection.length > 1
                            ? formatBulkDeletePresetsAction(presetSelection.length, _)
                            : <Trans>Delete</Trans>}
                    </button>
                </div>,
                document.body
            ) : null}
        </div>
    );
}
