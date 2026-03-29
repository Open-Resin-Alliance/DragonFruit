"use client";

import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/primitives';
import {
    getPresetList,
    getActivePreset,
    setActivePreset,
    subscribeToPresets,
    savePreset,
    renamePreset,
    createPreset,
} from '../presets';
import { setAnatomyPreviewHoveredPresetSettings } from '../AnatomyPreview/previewState';

// Modal for confirming preset deletion
function DeletePresetModal({
    isOpen,
    onCancel,
    onDelete,
    presetName,
}: {
    isOpen: boolean;
    onCancel: () => void;
    onDelete: () => void;
    presetName: string;
}) {
    if (!isOpen) return null;
    return (
        <div
            className="fixed inset-0 z-[130] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) onCancel();
            }}
        >
            <div
                className="w-full max-w-md overflow-hidden rounded-xl border shadow-2xl"
                style={{
                    background: 'var(--surface-0)',
                    borderColor: 'var(--border-subtle)',
                    boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
                }}
                role="dialog"
                aria-modal="true"
                aria-label="Delete preset"
            >
                <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
                    <div>
                        <h2 className="text-base font-semibold" style={{ color: 'var(--text-strong)' }}>
                            Delete Preset
                        </h2>
                        <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                            Are you sure you want to delete <span style={{ color: 'var(--text-strong)' }}>&quot;{presetName}&quot;</span>?
                        </p>
                    </div>
                </div>
                <div className="p-4 space-y-3">
                    <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                        This action cannot be undone. The preset will be permanently removed.
                    </p>
                    <div className="flex items-center justify-end gap-2 pt-1">
                        <Button
                            variant="secondary"
                            size="md"
                            className="!h-9 px-3 text-xs"
                            onClick={onCancel}
                        >
                            Cancel
                        </Button>
                        <Button
                            variant="danger"
                            size="md"
                            className="!h-9 px-3 text-xs"
                            onClick={onDelete}
                        >
                            Delete
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
}

export function PresetSelector() {
    const [presets, setPresets] = useState(() => getPresetList());
    const [activePreset, setActivePresetState] = useState(() => getActivePreset());
    const [confirmId, setConfirmId] = useState<string | null>(null);
    const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
    const [isEditingName, setIsEditingName] = useState(false);
    const [tempName, setTempName] = useState('');
    const [newPresetName, setNewPresetName] = useState('My Preset');
    useEffect(() => {
        const unsubscribe = subscribeToPresets(() => {
            setPresets(getPresetList());
            setActivePresetState(getActivePreset());
        });
        return unsubscribe;
    }, []);

    useEffect(() => {
        if (!activePreset) {
            setTempName('');
            setIsEditingName(false);
            return;
        }

        if (!isEditingName) {
            setTempName(activePreset.name);
        }
    }, [activePreset, isEditingName]);

    const builtInPresets = presets.filter((preset) => preset.isBuiltIn);
    const customPresets = presets.filter((preset) => !preset.isBuiltIn);

    const selectedPreset = activePreset ?? null;
    const selectedPresetIsBuiltIn = selectedPreset?.isBuiltIn ?? false;

    function fmt(n: number | undefined) {
        if (n == null || Number.isNaN(n)) return '-';
        if (Math.abs(n - Math.round(n)) < 0.05) return `${Math.round(n)}`;
        return `${n.toFixed(1)}`;
    }

    function renderPresetMetaChip(preset: (typeof presets)[number], isSelected: boolean) {
        return (
            <div
                className="absolute right-2 top-1/2 -translate-y-1/2 flex justify-end pointer-events-none"
                style={{ width: '5.85rem' }}
            >
                <span
                    className="inline-flex items-center rounded-[4px] px-1.5 py-0.5 pr-2 text-[10px] leading-none"
                    style={{
                        background: isSelected ? 'var(--primary-button-surface)' : 'var(--surface-2)',
                        border: isSelected ? '1px solid color-mix(in srgb, var(--primary-button-surface), white 14%)' : '1px solid var(--border-subtle)',
                        color: isSelected ? 'var(--accent-contrast)' : 'var(--text-muted)',
                        width: '5.85rem',
                        boxSizing: 'border-box',
                        overflow: 'hidden',
                        whiteSpace: 'nowrap',
                    }}
                >
                    <span style={{ color: isSelected ? 'var(--accent-contrast)' : 'var(--text-strong)', fontWeight: 600 }}>Ø{fmt(preset.settings.tip.contactDiameterMm)}</span>
                    <span style={{ margin: '0 0.18rem', opacity: 0.65 }}>│</span>
                    <span>L{fmt(preset.settings.tip.lengthMm)}</span>
                    <span style={{ margin: '0 0.18rem', opacity: 0.65 }}>│</span>
                    <span>T{fmt(preset.settings.shaft.diameterMm)}</span>
                </span>
            </div>
        );
    }

    function renderPresetRow(preset: (typeof presets)[number]) {
        const isSelected = activePreset?.id === preset.id;

        return (
            <button
                key={preset.id}
                type="button"
                className="w-full text-left px-3 py-2 text-sm relative rounded-[5px] border transition-colors"
                onClick={() => {
                    handlePresetSelect(preset.id);
                }}
                onMouseEnter={() => setAnatomyPreviewHoveredPresetSettings(preset.settings)}
                onMouseLeave={() => setAnatomyPreviewHoveredPresetSettings(null)}
                onFocus={() => setAnatomyPreviewHoveredPresetSettings(preset.settings)}
                onBlur={() => setAnatomyPreviewHoveredPresetSettings(null)}
                style={{
                    background: isSelected ? 'color-mix(in srgb, var(--secondary-button-surface), var(--surface-0) 90%)' : 'transparent',
                    borderColor: isSelected ? 'color-mix(in srgb, var(--secondary-button-surface), var(--border-subtle) 30%)' : 'transparent',
                }}
            >
                <div className="w-full">
                    <div className="flex items-center">
                        <div className="flex-1 truncate pr-[6.25rem]" style={{ color: isSelected ? 'var(--text-strong)' : undefined }}>
                            {preset.name}
                        </div>
                    </div>
                    {renderPresetMetaChip(preset, isSelected)}
                </div>
            </button>
        );
    }

    const handlePresetSelect = (presetId: string) => {
        if (presetId === '__separator') {
            return;
        }

        setActivePreset(presetId);
        setConfirmId(null);
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
                renamePreset(selectedPreset.id, trimmed);
            } else {
                setTempName(selectedPreset.name);
            }
            setIsEditingName(false);
            return;
        }

        setTempName(selectedPreset.name);
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
                <div className="rounded-md border bg-[var(--surface-1)]" style={{ borderColor: 'var(--border-subtle)' }}>
                    <div className="max-h-[19rem] overflow-y-auto custom-scrollbar py-1">
                        <div className="space-y-0.5 px-1">
                            {builtInPresets.map(renderPresetRow)}
                        </div>

                        <div className="mx-3 my-2 border-t" style={{ borderColor: 'var(--border-subtle)' }} />

                        <div className="space-y-0.5 px-1">
                            {customPresets.length === 0 ? (
                                <div className="px-3 py-2 text-sm text-[var(--text-muted)]">No custom presets</div>
                            ) : (
                                customPresets.map(renderPresetRow)
                            )}
                        </div>
                    </div>
                </div>
                {selectedPreset ? (
                    <div className="text-[11px] text-center" style={{ color: 'var(--text-muted)' }}>
                        {selectedPreset.description}
                    </div>
                ) : null}
            </div>

            {isEditingName && selectedPreset && !selectedPresetIsBuiltIn ? (
                <div className="space-y-1">
                    <div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
                        Edit preset name
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
                    />
                </div>
            ) : null}

            {/* Action row: Create, Edit, or Rename/Delete */}
            {confirmId && selectedPreset && confirmId === selectedPreset.id ? null : isEditingName && selectedPreset && !selectedPresetIsBuiltIn ? (
                <>
                    <div className="grid grid-cols-2 gap-1.5">
                        <Button
                            type="button"
                            variant="primary"
                            size="md"
                            className="h-9 text-[12px] font-semibold"
                            onClick={handleEditClick}
                            disabled={tempName.trim().length === 0}
                            title="Apply new name"
                        >
                            Apply Name
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
                    <DeletePresetModal
                        isOpen={deleteConfirmId === selectedPreset.id}
                        onCancel={() => setDeleteConfirmId(null)}
                        onDelete={async () => {
                            const mod = await import('../presets');
                            mod.deletePreset(selectedPreset.id);
                            setDeleteConfirmId(null);
                            setIsEditingName(false);
                        }}
                        presetName={selectedPreset.name}
                    />
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
                        <div>
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
        </div>
    );
}
