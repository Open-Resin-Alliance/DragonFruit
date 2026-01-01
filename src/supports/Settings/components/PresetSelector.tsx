"use client";

import React, { useState, useEffect } from 'react';
import { PresetCard } from './PresetCard';
import { getPresetList, getActivePreset, setActivePreset, subscribeToPresets } from '../presets';

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

    const handlePresetClick = (presetId: string) => {
        setActivePreset(presetId);
    };

    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between">
                <h4 className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wide">
                    Presets
                </h4>
                <div className="text-[9px] text-neutral-600">
                    1 / 2 / 3
                </div>
            </div>

            <div className="space-y-1">
                {presets.map((preset) => (
                    <PresetCard
                        key={preset.id}
                        preset={preset}
                        isActive={preset.id === activePreset.id}
                        onClick={() => handlePresetClick(preset.id)}
                    />
                ))}
            </div>
        </div>
    );
}
