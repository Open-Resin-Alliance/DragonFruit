"use client";

import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
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
    const [isCreateMode, setIsCreateMode] = useState(false);
    const [isNamingNewPreset, setIsNamingNewPreset] = useState(false);
    const [newPresetName, setNewPresetName] = useState('My Preset');
    const [popoverOpen, setPopoverOpen] = useState(false);
    const popoverButtonRef = useRef<HTMLButtonElement | null>(null);
    const popoverRef = useRef<HTMLDivElement | null>(null);
    const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

    useEffect(() => {
        const unsubscribe = subscribeToPresets(() => {
            setPresets(getPresetList());
            setActivePresetState(getActivePreset());
        });
        return unsubscribe;
    }, []);

    // Close popover on outside click or Escape
    useEffect(() => {
        function onDocClick(e: MouseEvent) {
            if (!popoverOpen) return;
            const target = e.target as Node;
            // If click is inside the button or the popover, ignore
            if (popoverButtonRef.current && popoverButtonRef.current.contains(target)) return;
            if (popoverRef.current && popoverRef.current.contains(target)) return;
            setPopoverOpen(false);
        }

        function onKey(e: KeyboardEvent) {
            if (e.key === 'Escape') setPopoverOpen(false);
        }

        document.addEventListener('mousedown', onDocClick);
        window.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDocClick);
            window.removeEventListener('keydown', onKey);
        };
    }, [popoverOpen]);

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

    const selectedPreset = !isCreateMode ? (activePreset ?? null) : null;
    const selectedPresetId = isCreateMode ? '__create_new' : (activePreset?.id ?? 'structure');
    const selectedPresetIsBuiltIn = selectedPreset?.isBuiltIn ?? false;

    const handlePresetSelect = (presetId: string) => {
        if (presetId === '__separator') {
            return;
        }

        if (presetId === '__create_new') {
            setIsCreateMode(true);
            setConfirmId(null);
            setIsEditingName(false);
            setIsNamingNewPreset(false);
            setNewPresetName('My Preset');
            return;
        }

        setActivePreset(presetId);
        setIsCreateMode(false);
        setConfirmId(null);
        setIsEditingName(false);
        setIsNamingNewPreset(false);
    };

    const handleSaveRequest = () => {
        if (isCreateMode) {
            if (isNamingNewPreset) {
                handleCreateFromName();
                return;
            }
            setIsNamingNewPreset(true);
            setConfirmId(null);
            setIsEditingName(false);
            return;
        }

        if (!selectedPreset) return;
        setConfirmId(selectedPreset.id);
    };

    const handleConfirmSave = () => {
        if (!selectedPreset) return;
        savePreset(selectedPreset.id);
        setConfirmId(null);
    };

    const handleEditClick = () => {
        if (isCreateMode) {
            if (isNamingNewPreset) {
                setIsNamingNewPreset(false);
                setNewPresetName('My Preset');
                return;
            }
            return;
        }

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
        setIsCreateMode(false);
        setIsNamingNewPreset(false);
    };

    const handleCreateFromName = () => {
        const created = createPreset(newPresetName);
        setActivePreset(created.id);
        setIsCreateMode(false);
        setIsNamingNewPreset(false);
        setNewPresetName(created.name);
        setConfirmId(null);
        setIsEditingName(false);
    };

    return (
        <div className="space-y-2">
            <div className="space-y-1">
                <h4 className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    Presets
                </h4>
                {/* Custom popover dropdown so we can style items */}
                <div className="relative">
                    <button
                        type="button"
                        className="ui-input w-full h-8 px-2.5 text-xs text-left flex items-center justify-between"
                        onClick={() => {
                            const rect = popoverButtonRef.current?.getBoundingClientRect() ?? null;
                            setAnchorRect(rect);
                            setPopoverOpen((s) => !s);
                        }}
                        ref={popoverButtonRef}
                        aria-haspopup="listbox"
                        aria-expanded={popoverOpen}
                    >
                        <span>{isCreateMode ? 'New Profile' : (selectedPreset ? selectedPreset.name : 'Select')}</span>
                        <svg className="w-3.5 h-3.5 text-[--text-muted]" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 9l6 6 6-6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </button>

                    {popoverOpen && anchorRect && ReactDOM.createPortal(
                        <div className="fixed inset-0 z-[140]" aria-hidden={false}>
                            {/* click-catcher only; keep visual emphasis to the popover itself via box-shadow */}
                            <div className="absolute inset-0" onMouseDown={() => setPopoverOpen(false)} />
                            <div
                                ref={popoverRef}
                                className="absolute rounded-md border overflow-hidden bg-[var(--surface-1)]"
                                style={{
                                    borderColor: 'var(--border-subtle)',
                                    top: Math.min(window.innerHeight - 8, anchorRect.bottom) + 'px',
                                    left: Math.max(8, anchorRect.left) + 'px',
                                    minWidth: anchorRect.width + 'px',
                                    zIndex: 150,
                                    boxShadow: '0 24px 46px rgba(0,0,0,0.45)',
                                }}
                                role="listbox"
                            >
                                <div className="py-1">
                                    <button type="button" className="w-full text-left px-3 py-2 text-sm font-medium text-green-400 hover:bg-[var(--surface-0)]" onClick={() => { handlePresetSelect('__create_new'); setPopoverOpen(false); }}>
                                        Create New
                                    </button>
                                    <div className="border-t mx-2 my-1" style={{ borderColor: 'var(--border-subtle)' }} />

                                    {builtInPresets.map((preset) => (
                                        <button key={preset.id} type="button" className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--surface-0)]" onClick={() => { handlePresetSelect(preset.id); setPopoverOpen(false); }}>
                                            {preset.name}
                                        </button>
                                    ))}

                                    <div className="border-t mx-2 my-1" style={{ borderColor: 'var(--border-subtle)' }} />

                                    {customPresets.length === 0 ? (
                                        <div className="px-3 py-2 text-sm text-[var(--text-muted)]">No custom presets</div>
                                    ) : (
                                        customPresets.map((preset) => (
                                            <button key={preset.id} type="button" className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--surface-0)]" onClick={() => { handlePresetSelect(preset.id); setPopoverOpen(false); }}>
                                                {preset.name}
                                            </button>
                                        ))
                                    )}
                                </div>
                            </div>
                        </div>,
                        document.body,
                    )}
                </div>
                {selectedPreset ? (
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        {selectedPreset.description}
                    </div>
                ) : isCreateMode ? (
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        Press Save to create a new preset from current settings.
                    </div>
                ) : null}
            </div>

            {isNamingNewPreset ? (
                <div className="space-y-1">
                    <div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
                        New preset name
                    </div>
                    <input
                        type="text"
                        value={newPresetName}
                        onChange={(event) => setNewPresetName(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                                handleCreateFromName();
                            } else if (event.key === 'Escape') {
                                setIsNamingNewPreset(false);
                                setNewPresetName('My Preset');
                            }
                        }}
                        placeholder="My Preset"
                        className="ui-input h-8 w-full px-2.5 text-xs sm:text-sm"
                    />
                </div>
            ) : null}

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
            {isEditingName && selectedPreset && !selectedPresetIsBuiltIn ? (
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
                <div className="grid grid-cols-2 gap-1.5">
                    <Button
                        type="button"
                        variant="primary"
                        size="md"
                        className="h-9 text-[12px] font-semibold"
                        onClick={handleSaveRequest}
                        disabled={!isCreateMode && !selectedPreset}
                    >
                        {isCreateMode ? 'Save as New' : 'Save'}
                    </Button>
                    <Button
                        type="button"
                        variant="accent"
                        size="md"
                        className="h-9 text-[12px] font-semibold"
                        onClick={handleEditClick}
                        disabled={isCreateMode ? true : (!selectedPreset || selectedPresetIsBuiltIn || isNamingNewPreset)}
                        title={isCreateMode
                            ? 'Create mode is active'
                            : (selectedPresetIsBuiltIn ? 'Built-in presets cannot be renamed' : 'Rename selected preset')}
                    >
                        {isCreateMode ? 'Edit' : 'Edit'}
                    </Button>
                </div>
            )}

            {confirmId && selectedPreset && confirmId === selectedPreset.id && !isCreateMode && !isNamingNewPreset ? (
                <div className="rounded-md border px-3 py-2 bg-[var(--surface-0)]" style={{ borderColor: 'var(--border-subtle)' }}>
                    <div className="flex items-start justify-between gap-3">
                        <div>
                            <div className="text-[12px] font-medium" style={{ color: 'var(--text-strong)' }}>
                                Overwrite preset
                            </div>
                            <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                                Replace "{selectedPreset.name}" with the current settings.
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                className="h-8 px-3 text-[12px] font-semibold"
                                onClick={handleConfirmSave}
                            >
                                Save
                            </Button>
                            <Button
                                type="button"
                                variant="ghost"
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
