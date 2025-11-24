"use client";

import React, { useState, useEffect } from 'react';
import { PresetCard } from './PresetCard';
import { PresetEditor } from './PresetEditor';
import {
  getPresetList,
  getActivePreset,
  setActivePreset,
  subscribeToPresets
} from './presets';
import { setCurrentSupportSettings, getCurrentSupportSettings } from './state';
import { SupportPreset } from './types';

export function PresetSelector() {
  const [presets, setPresets] = useState(() => getPresetList());
  const [activePreset, setActivePresetState] = useState(() => getActivePreset());
  const [editingPreset, setEditingPreset] = useState<SupportPreset | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeToPresets(() => {
      setPresets(getPresetList());
      setActivePresetState(getActivePreset());
    });
    return unsubscribe;
  }, []);

  const handlePresetClick = (presetId: string) => {
    setActivePreset(presetId);
    const preset = presets.find(p => p.id === presetId);
    if (preset) {
      // Get current settings to preserve grid configuration
      // Presets don't typically include grid settings, so we want to keep the user's current grid state
      const currentSettings = getCurrentSupportSettings();

      // Update current support settings to match preset, but preserve grid
      setCurrentSupportSettings({
        ...preset.settings,
        grid: currentSettings.grid || preset.settings.grid // Fallback to preset grid if current is missing (unlikely)
      });
    }
  };

  const handleEdit = (preset: SupportPreset) => {
    setEditingPreset(preset);
  };

  return (
    <>
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
              onEdit={!preset.isBuiltIn ? () => handleEdit(preset) : undefined}
            />
          ))}
        </div>
      </div>

      {editingPreset && (
        <PresetEditor
          preset={editingPreset}
          onClose={() => setEditingPreset(null)}
        />
      )}
    </>
  );
}
