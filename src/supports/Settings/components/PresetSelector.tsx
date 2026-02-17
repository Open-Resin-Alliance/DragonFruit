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
        <div className="space-y-2">
            <div className="flex items-center justify-between">
                <h4 className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wide">
                    Presets
                </h4>
            </div>

            <div className="grid grid-cols-2 gap-1 relative">
                {presets.map((preset) => (
                    <div key={preset.id} className="relative">
                        {confirmId === preset.id ? (
                            <div className="absolute inset-0 z-20 bg-neutral-800 border-2 border-yellow-600/50 rounded flex flex-col items-center justify-center animate-in fade-in zoom-in-95 duration-100">
                                <div className="text-[9px] text-yellow-500 font-medium mb-1">Overwrite?</div>
                                <div className="flex gap-2">
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleConfirmSave(preset.id);
                                        }}
                                        className="text-[9px] bg-neutral-700 px-1.5 py-0.5 rounded text-neutral-200 hover:text-white hover:bg-green-600/50 transition-colors"
                                    >
                                        Yes
                                    </button>
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setConfirmId(null);
                                        }}
                                        className="text-[9px] bg-neutral-700 px-1.5 py-0.5 rounded text-neutral-200 hover:text-white hover:bg-red-600/50 transition-colors"
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
