"use client";

import React, { useState, useEffect } from 'react';
import { PresetCard } from './PresetCard';
import {
    getPresetList,
    getActivePreset,
    setActivePreset,
    subscribeToPresets,
    savePreset,
    renamePreset,
    checkPresetDrift
} from '../presets';

export function PresetSelector() {
    const [presets, setPresets] = useState(() => getPresetList());
    const [activePreset, setActivePresetState] = useState(() => getActivePreset());

    useEffect(() => {
        const unsubscribe = subscribeToPresets(() => {
            setPresets(getPresetList());
            setActivePresetState(getActivePreset());
        });
        return unsubscribe;
    }, []);

    const [confirmId, setConfirmId] = useState<string | null>(null);

    const handlePresetClick = (presetId: string) => {
        setActivePreset(presetId);
    };

    const handleSaveRequest = (id: string) => {
        setConfirmId(id);
    };

    const handleConfirmSave = (id: string) => {
        savePreset(id);
        setConfirmId(null);
    };

    return (
        <div className="space-y-2.5">
            <div className="flex items-center justify-between">
                <h4 className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    Presets
                </h4>
            </div>

            <div className="grid grid-cols-2 gap-2 relative">
                {presets.map((preset) => (
                    <div key={preset.id} className="relative">
                        {confirmId === preset.id ? (
                            <div className="absolute inset-0 z-20 rounded-md border-2 flex flex-col items-center justify-center animate-in fade-in zoom-in-95 duration-100"
                                style={{ background: 'color-mix(in srgb, var(--surface-1), black 16%)', borderColor: 'color-mix(in srgb, var(--accent), transparent 46%)' }}>
                                <div className="text-[9px] font-medium mb-1" style={{ color: 'var(--text-strong)' }}>Overwrite?</div>
                                <div className="flex gap-2">
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleConfirmSave(preset.id);
                                        }}
                                        className="text-[9px] px-1.5 py-0.5 rounded border transition-colors"
                                        style={{ background: 'var(--surface-1)', borderColor: 'var(--border-subtle)', color: 'var(--text-strong)' }}
                                    >
                                        Yes
                                    </button>
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setConfirmId(null);
                                        }}
                                        className="text-[9px] px-1.5 py-0.5 rounded border transition-colors"
                                        style={{ background: 'var(--surface-1)', borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
                                    >
                                        No
                                    </button>
                                </div>
                            </div>
                        ) : null}
                        <PresetCard
                            preset={preset}
                            isActive={activePreset ? preset.id === activePreset.id : false}
                            onClick={() => handlePresetClick(preset.id)}
                            onSave={() => handleSaveRequest(preset.id)}
                            onRename={(newName) => renamePreset(preset.id, newName)}
                        />
                    </div>
                ))}
            </div>
        </div>
    );
}
