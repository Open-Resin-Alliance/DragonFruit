"use client";

import React, { useState, useEffect, useRef, useSyncExternalStore } from 'react';
import ReactDOM from 'react-dom';
import { PenLine, Pencil, Trash2, Save, Pin, PinOff } from 'lucide-react';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';
import {
    getPresetList,
    getActivePreset,
    getPinnedPresets,
    getUnpinnedPresets,
    setActivePreset,
    subscribeToPresets,
    savePreset,
    updateCustomPresetMetadata,
    createPreset,
    deletePreset,
    setPresetPinnedSlot,
    isPresetDirtyForSettings,
    restoreFactoryDefaults,
} from '../presets';
import { getSettings, subscribeToSettings } from '../state';
import { setAnatomyPreviewHoveredPresetSettings } from '../AnatomyPreview/previewState';

type PresetSelectorProps = {
    selectedPresetIdOverride?: string | null;
    onPresetSelected?: (presetId: string) => void;
    disableGlobalPresetActivation?: boolean;
};

export function PresetSelector({
    selectedPresetIdOverride,
    onPresetSelected,
    disableGlobalPresetActivation = false,
}: PresetSelectorProps) {
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
    const [newPresetName, setNewPresetName] = useState('My Preset');
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

    const effectiveSelectedPresetId = selectedPresetIdOverride === undefined
        ? activePreset?.id ?? null
        : selectedPresetIdOverride;
    const selectedPreset = effectiveSelectedPresetId
        ? presets.find((preset) => preset.id === effectiveSelectedPresetId) ?? null
        : null;
    const selectedPresetIsBuiltIn = selectedPreset?.isBuiltIn ?? false;
    const hoveredPreset = hoveredPresetId ? presets.find((preset) => preset.id === hoveredPresetId) ?? null : null;
    const previewDescription = hoveredPreset?.description ?? selectedPreset?.description ?? '';
    const selectedPresetIsDirty = isPresetDirtyForSettings(effectiveSelectedPresetId, settings);

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

        return (
            <button
                type="button"
                className="w-full px-3 py-2 text-sm relative rounded-[5px] border transition-colors"
                onClick={() => {
                    handlePresetSelect(preset.id);
                }}
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
                    background: isSelected
                        ? preset.pinnedSlot != null
                            ? 'color-mix(in srgb, var(--accent-secondary), var(--surface-0) 88%)'
                            : 'color-mix(in srgb, var(--primary-button-surface), var(--surface-0) 90%)'
                        : 'var(--surface-0)',
                    borderColor: isSelected
                        ? preset.pinnedSlot != null
                            ? 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 25%)'
                            : 'color-mix(in srgb, var(--primary-button-surface), var(--border-subtle) 30%)'
                        : 'var(--border-subtle)',
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
                        title="Preset has unsaved changes"
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
                                {preset.name}
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

    const handleSaveRequest = () => {
        if (!selectedPreset || selectedPresetIsBuiltIn) return;
        setConfirmId(selectedPreset.id);
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
                    : 'User custom preset',
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
        setNewPresetName('My Preset');
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
                    >
                        <div className="grid grid-cols-2 gap-1 px-1">
                            {[1, 2, 3, 4, 5, 6].map((slot) => {
                                const preset = pinnedPresets.find((p) => p.pinnedSlot === slot);
                                return preset ? (
                                    <div key={preset.id} data-preset-cell onContextMenu={(e) => handleContextMenu(e, preset.id)}>
                                        {renderPresetRow(preset)}
                                    </div>
                                ) : (
                                    <button
                                        key={`empty-slot-${slot}`}
                                        type="button"
                                        disabled
                                        className="w-full rounded-[5px] border border-dashed px-3 py-2 text-sm relative"
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
                                );
                            })}
                        </div>

                        <div className="mx-3 mt-4 mb-3 border-t" style={{ borderColor: 'var(--border-subtle)' }} />
                        <div className="grid grid-cols-2 gap-1 px-1">
                            {unpinnedPresets.map((preset) => (
                                <div key={preset.id} data-preset-cell onContextMenu={(e) => handleContextMenu(e, preset.id)}>
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
                open={confirmId !== null && selectedPreset !== null && confirmId === selectedPreset.id}
                ariaLabel="Overwrite preset"
                title={`Save Over "${selectedPreset?.name ?? ''}"?`}
                subtitle="This will replace the preset with your current settings."
                icon={<Save className="h-4 w-4" />}
                iconTone="accent"
                zIndexClassName="z-[300]"
                closeAriaLabel="Cancel overwrite"
                onClose={() => setConfirmId(null)}
                actions={(
                    <>
                        <button
                            type="button"
                            className="ui-button ui-button-secondary !h-9 w-full px-3 text-xs"
                            onClick={() => setConfirmId(null)}
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            className="ui-button ui-button-primary !h-9 w-full px-3 text-xs inline-flex items-center justify-center gap-1.5"
                            onClick={() => {
                                if (selectedPreset) {
                                    savePreset(selectedPreset.id);
                                }
                                setConfirmId(null);
                            }}
                        >
                            <Save className="h-3.5 w-3.5" />
                            Save
                        </button>
                    </>
                )}
            >
                <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                    Overwrite the preset <strong style={{ color: 'var(--text-strong)' }}>{selectedPreset?.name ?? ''}</strong> with the current scene settings?
                </p>
            </StructuredDialogModal>

            {/* ── Delete Preset Modal ────────────────────────────────────── */}
            <StructuredDialogModal
                open={deleteConfirmId !== null && selectedPreset !== null && deleteConfirmId === selectedPreset.id}
                ariaLabel="Delete preset"
                title={`Delete "${selectedPreset?.name ?? ''}"?`}
                subtitle="This action cannot be undone."
                icon={<Trash2 className="h-4 w-4" />}
                iconTone="warning"
                zIndexClassName="z-[300]"
                closeAriaLabel="Cancel delete"
                onClose={() => setDeleteConfirmId(null)}
                actions={(
                    <>
                        <button
                            type="button"
                            className="ui-button ui-button-secondary !h-9 w-full px-3 text-xs"
                            onClick={() => setDeleteConfirmId(null)}
                        >
                            Cancel
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
                                if (selectedPreset) {
                                    deletePreset(selectedPreset.id);
                                }
                                setDeleteConfirmId(null);
                                setIsEditingName(false);
                            }}
                        >
                            <Trash2 className="h-3.5 w-3.5" />
                            Delete
                        </button>
                    </>
                )}
            >
                <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                    This will permanently remove the preset <strong style={{ color: 'var(--text-strong)' }}>{selectedPreset?.name ?? ''}</strong> and all of its saved settings.
                </p>
            </StructuredDialogModal>

            {/* ── Restore Defaults Modal ──────────────────────────────────── */}
            <StructuredDialogModal
                open={restoreConfirmOpen}
                ariaLabel="Restore factory defaults"
                title="Restore Factory Defaults?"
                subtitle="Factory presets will be reset and user presets will be unpinned."
                icon={
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                        <path d="M3 3v5h5" />
                    </svg>
                }
                iconTone="warning"
                zIndexClassName="z-[300]"
                closeAriaLabel="Cancel restore"
                onClose={() => setRestoreConfirmOpen(false)}
                actions={(
                    <>
                        <button
                            type="button"
                            className="ui-button ui-button-secondary !h-9 w-full px-3 text-xs"
                            onClick={() => setRestoreConfirmOpen(false)}
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            className="ui-button !h-9 w-full px-3 text-xs inline-flex items-center justify-center gap-1.5"
                            style={{
                                borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 25%)',
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
                            Restore
                        </button>
                    </>
                )}
            >
                <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                    This will reset <strong style={{ color: 'var(--text-strong)' }}>Detail</strong>, <strong style={{ color: 'var(--text-strong)' }}>Structure</strong>, and <strong style={{ color: 'var(--text-strong)' }}>Anchor</strong> to their factory settings and unpin all user presets. Your user presets will <strong style={{ color: 'var(--text-strong)' }}>not</strong> be deleted.
                </p>
            </StructuredDialogModal>

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
                        New Preset
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
                        Rename
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
                                    handlePresetSelect(menuPreset.id);
                                    handleSaveRequest();
                                }}
                            >
                                <Save className="h-3.5 w-3.5" />
                                Save Changes
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
                                Revert Changes
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
                                        Unpin
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
                                        <span className="flex-1">{isPinned ? 'Move Slot' : 'Pin to Slot'}</span>
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
                                                        <span className="flex-1">Slot {slot}</span>
                                                        {alreadyPinned ? (
                                                            <span className="text-[10px] opacity-40">occupied</span>
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
                        Restore Defaults
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
                            handlePresetSelect(preset.id);
                            setDeleteConfirmId(preset.id);
                            setContextMenu(null);
                        }}
                    >
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete
                    </button>
                </div>,
                document.body
            ) : null}
        </div>
    );
}
