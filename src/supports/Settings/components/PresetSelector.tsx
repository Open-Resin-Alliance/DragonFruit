"use client";

import React, { useState, useEffect, useRef, useSyncExternalStore } from 'react';
import { PenLine } from 'lucide-react';
import { Button } from '@/components/ui/primitives';
import {
    getPresetList,
    getActivePreset,
    setActivePreset,
    subscribeToPresets,
    savePreset,
    updateCustomPresetMetadata,
    createPreset,
    deletePreset,
    isPresetDirtyForSettings,
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
    const [tempName, setTempName] = useState('');
    const [tempDescription, setTempDescription] = useState('');
    const [newPresetName, setNewPresetName] = useState('My Preset');
    useEffect(() => {
        const unsubscribe = subscribeToPresets(() => {
            setPresets(getPresetList());
            setActivePresetState(getActivePreset());
        });
        return unsubscribe;
    }, []);

    const builtInPresets = presets.filter((preset) => preset.isBuiltIn);
    const customPresets = presets.filter((preset) => !preset.isBuiltIn);

    const effectiveSelectedPresetId = selectedPresetIdOverride === undefined
        ? activePreset?.id ?? null
        : selectedPresetIdOverride;
    const selectedPreset = effectiveSelectedPresetId
        ? presets.find((preset) => preset.id === effectiveSelectedPresetId) ?? null
        : null;
    const selectedPresetIsBuiltIn = selectedPreset?.isBuiltIn ?? false;
    const hoveredPreset = hoveredPresetId ? presets.find((preset) => preset.id === hoveredPresetId) ?? null : null;
    const previewDescription = hoveredPreset?.description ?? selectedPreset?.description ?? '';
    const isInlineSaveConfirmOpen = Boolean(confirmId && selectedPreset && confirmId === selectedPreset.id);
    const isInlineDeleteConfirmOpen = Boolean(deleteConfirmId && selectedPreset && deleteConfirmId === selectedPreset.id);
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

    useEffect(() => {
        function recalc() {
            if (!wrapperRef.current) return;
            const rect = wrapperRef.current.getBoundingClientRect();
            const top = rect.top;
            const viewportHeight = window.innerHeight;

            // Reserve space for inline panels when open; tuned empirically.
            const confirmReserve = 120; // px reserved for inline confirm panel area
            const defaultReserve = 48; // px reserved for normal footer/action area

            const reserved = (isInlineSaveConfirmOpen || isInlineDeleteConfirmOpen) ? confirmReserve : defaultReserve;

            const available = Math.max(120, viewportHeight - top - reserved - 24); // keep a sane minimum

            // Clamp to a reasonable maximum roughly matching earlier rem-based sizes (19rem ≈ 304px)
            const maxClamp = 304;
            const final = Math.min(available, maxClamp);
            setComputedMaxHeight(`${final}px`);
        }

        recalc();
        window.addEventListener('resize', recalc);
        return () => window.removeEventListener('resize', recalc);
    }, [isInlineSaveConfirmOpen, isInlineDeleteConfirmOpen]);

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
                        ? 'color-mix(in srgb, var(--primary-button-surface), var(--surface-0) 90%)'
                        : 'var(--surface-0)',
                    borderColor: isSelected
                        ? 'color-mix(in srgb, var(--primary-button-surface), var(--border-subtle) 30%)'
                        : 'var(--border-subtle)',
                }}
            >
                {isSelected ? (
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
                        style={{ color: isSelected ? 'var(--accent-contrast)' : 'var(--text-muted)' }}
                    >
                        <PenLine className="h-3 w-3" />
                    </span>
                ) : null}
                <div className="w-full">
                    <div className="flex items-center justify-center text-center">
                        <div className="flex-1 truncate" style={{ color: isSelected ? 'var(--accent-contrast)' : undefined }}>
                            {preset.name}
                        </div>
                    </div>
                </div>
            </button>
        );
    }

    function rowSpanClass(index: number, total: number): string {
        // If a row has only one tile (odd trailing item), let it fill the full row
        return total % 2 === 1 && index === total - 1 ? 'col-span-2' : '';
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

    const handleCreateNewClick = () => {
        const created = createPreset(newPresetName);
        setActivePreset(created.id);
        setConfirmId(null);
        setIsEditingName(false);
    };

    return (
        <div className="space-y-2">
            <div className="space-y-1">
                <h4 className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    Presets
                </h4>
                <div ref={wrapperRef} className="rounded-md border bg-[var(--surface-1)]" style={{ borderColor: 'var(--border-subtle)' }}>
                    <div className="overflow-y-auto custom-scrollbar py-1 transition-[max-height] duration-200" style={{ maxHeight: computedMaxHeight }}>
                        <div className="grid grid-cols-2 gap-1 px-1">
                            {builtInPresets.map((preset, index) => (
                                <div key={preset.id} className={rowSpanClass(index, builtInPresets.length)}>
                                    {renderPresetRow(preset)}
                                </div>
                            ))}
                        </div>

                        {customPresets.length > 0 ? (
                            <>
                                <div className="mx-3 my-2 border-t" style={{ borderColor: 'var(--border-subtle)' }} />
                                <div className="grid grid-cols-2 gap-1 px-1">
                                    {customPresets.map((preset, index) => (
                                        <div key={preset.id} className={rowSpanClass(index, customPresets.length)}>
                                            {renderPresetRow(preset)}
                                        </div>
                                    ))}
                                </div>
                            </>
                        ) : null}
                    </div>
                </div>
                {previewDescription ? (
                    <div className="text-[11px] text-center" style={{ color: 'var(--text-muted)' }}>
                        {previewDescription}
                    </div>
                ) : null}
            </div>

            {isEditingName && selectedPreset && !selectedPresetIsBuiltIn ? (
                <div className="space-y-1">
                    <div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
                        Edit preset details
                    </div>
                    <input
                        type="text"
                        value={tempName}
                        onChange={(event) => setTempName(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                                handleEditClick();
                            } else if (event.key === 'Escape') {
                                setTempName(selectedPreset.name);
                                setIsEditingName(false);
                            }
                        }}
                        className="ui-input h-8 w-full px-2.5 text-xs sm:text-sm"
                        placeholder="Preset name"
                    />
                    <input
                        type="text"
                        value={tempDescription}
                        onChange={(event) => setTempDescription(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                                handleEditClick();
                            } else if (event.key === 'Escape') {
                                setTempName(selectedPreset.name);
                                setTempDescription(selectedPreset.description ?? '');
                                setDeleteConfirmId(null);
                                setIsEditingName(false);
                            }
                        }}
                        className="ui-input h-8 w-full px-2.5 text-xs sm:text-sm"
                        placeholder="Preset description"
                    />
                </div>
            ) : null}

            {/* Action row: Create, Edit, or Rename/Delete */}
            {confirmId && selectedPreset && confirmId === selectedPreset.id ? null : isEditingName && selectedPreset && !selectedPresetIsBuiltIn ? (
                <>
                    {deleteConfirmId === selectedPreset.id ? null : (
                        <div className="grid grid-cols-2 gap-1.5">
                            <Button
                                type="button"
                                variant="primary"
                                size="md"
                                className="h-9 text-[12px] font-semibold"
                                onClick={handleEditClick}
                                disabled={tempName.trim().length === 0}
                                title="Apply preset details"
                            >
                                Apply
                            </Button>
                            <Button
                                type="button"
                                variant="danger"
                                size="md"
                                className="h-9 text-[12px] font-semibold"
                                onClick={() => setDeleteConfirmId(selectedPreset.id)}
                                title="Delete this preset"
                            >
                                Delete
                            </Button>
                        </div>
                    )}
                </>
            ) : (
                <div className="grid grid-cols-3 gap-1.5">
                    <Button
                        type="button"
                        variant="accent"
                        size="md"
                        className="h-9 text-[12px] font-semibold"
                        onClick={handleCreateNewClick}
                        title="Create a new preset from current settings"
                    >
                        New
                    </Button>
                    <Button
                        type="button"
                        variant="primary"
                        size="md"
                        className="h-9 text-[12px] font-semibold"
                        onClick={handleSaveRequest}
                        disabled={!selectedPreset || selectedPresetIsBuiltIn}
                        title={selectedPresetIsBuiltIn ? 'Built-in presets cannot be saved' : 'Save current settings to this preset'}
                    >
                        Save
                    </Button>
                    <Button
                        type="button"
                        variant="secondary"
                        size="md"
                        className="h-9 text-[12px] font-semibold"
                        onClick={handleEditClick}
                        disabled={!selectedPreset || selectedPresetIsBuiltIn}
                        title={selectedPresetIsBuiltIn ? 'Built-in presets cannot be renamed' : 'Rename selected preset'}
                    >
                        More
                    </Button>
                </div>
            )}

            {confirmId && selectedPreset && confirmId === selectedPreset.id ? (
                <div className="rounded-md border px-3 py-2 bg-[var(--surface-0)]" style={{ borderColor: 'color-mix(in srgb, #ef4444, var(--border-subtle) 72%)' }}>
                    <div className="flex items-center justify-between gap-3">
                        <div className="flex flex-col justify-center">
                            <div className="text-[12px] font-medium" style={{ color: 'var(--text-strong)' }}>
                                Overwrite Preset
                            </div>
                            <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                                Replace "{selectedPreset.name}" with the current settings?
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                className="h-8 px-3 text-[12px] font-semibold"
                                onClick={() => {
                                    savePreset(selectedPreset.id);
                                    setConfirmId(null);
                                }}
                            >
                                Save
                            </Button>
                            <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                className="h-8 px-3 text-[12px]"
                                onClick={() => setConfirmId(null)}
                            >
                                Cancel
                            </Button>
                        </div>
                    </div>
                </div>
            ) : null}

            {deleteConfirmId && selectedPreset && deleteConfirmId === selectedPreset.id ? (
                <div className="rounded-md border px-3 py-2 bg-[var(--surface-0)]" style={{ borderColor: 'color-mix(in srgb, #ef4444, var(--border-subtle) 72%)' }}>
                    <div className="flex items-center justify-between gap-3">
                        <div className="flex flex-col justify-center">
                            <div className="text-[12px] font-medium" style={{ color: 'var(--text-strong)' }}>
                                Delete Preset
                            </div>
                            <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                                Delete &quot;{selectedPreset.name}&quot;? This cannot be undone.
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            <Button
                                type="button"
                                variant="danger"
                                size="sm"
                                className="h-8 px-3 text-[12px] font-semibold"
                                onClick={() => {
                                    deletePreset(selectedPreset.id);
                                    setDeleteConfirmId(null);
                                    setIsEditingName(false);
                                }}
                            >
                                Delete
                            </Button>
                            <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                className="h-8 px-3 text-[12px]"
                                onClick={() => setDeleteConfirmId(null)}
                            >
                                Cancel
                            </Button>
                        </div>
                    </div>
                </div>
            ) : null}
        </div>
    );
}
