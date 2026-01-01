"use client";

import React, { useState } from 'react';
import { SupportPreset } from './types';
import { updatePreset } from './presets';

interface PresetEditorProps {
  preset: SupportPreset;
  onClose: () => void;
}

export function PresetEditor({ preset, onClose }: PresetEditorProps) {
  const [localSettings, setLocalSettings] = useState(preset.settings);

  const handleSave = () => {
    updatePreset(preset.id, { settings: localSettings });
    onClose();
  };

  if (preset.isBuiltIn) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
        <div className="bg-neutral-800 rounded-lg p-4 max-w-md w-full mx-4 border border-neutral-700" onClick={(e) => e.stopPropagation()}>
          <h3 className="text-sm font-semibold text-neutral-100 mb-3">
            {preset.icon} {preset.name} Preset
          </h3>
          <p className="text-xs text-neutral-400 mb-4">
            Built-in presets cannot be edited. You can modify the values in the Support Settings panel below, and those changes will apply to new supports.
          </p>
          <button
            onClick={onClose}
            className="w-full px-3 py-2 text-xs font-medium text-neutral-100 bg-neutral-700 hover:bg-neutral-600 rounded transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-neutral-800 rounded-lg p-4 max-w-md w-full mx-4 border border-neutral-700 max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-neutral-100 mb-3">
          Edit {preset.name}
        </h3>

        {/* Tip Settings */}
        <div className="space-y-2 mb-3">
          <div className="text-xs font-medium text-neutral-300">Tip</div>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-neutral-400">Contact (mm)</span>
              <input
                type="number"
                step="0.1"
                value={localSettings.tip.contactDiameterMm}
                onChange={(e) => setLocalSettings({
                  ...localSettings,
                  tip: { ...localSettings.tip, contactDiameterMm: parseFloat(e.target.value) || 0 }
                })}
                className="px-2 py-1 text-xs bg-neutral-900 border border-neutral-700 rounded text-neutral-100"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-neutral-400">Body (mm)</span>
              <input
                type="number"
                step="0.1"
                value={localSettings.tip.bodyDiameterMm}
                onChange={(e) => setLocalSettings({
                  ...localSettings,
                  tip: { ...localSettings.tip, bodyDiameterMm: parseFloat(e.target.value) || 0 }
                })}
                className="px-2 py-1 text-xs bg-neutral-900 border border-neutral-700 rounded text-neutral-100"
              />
            </label>
          </div>
        </div>

        {/* Mid (Shaft) Settings */}
        <div className="space-y-2 mb-3">
          <div className="text-xs font-medium text-neutral-300">Shaft</div>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-neutral-400">Diameter (mm)</span>
            <input
              type="number"
              step="0.1"
              value={localSettings.mid.diameterMm}
              onChange={(e) => setLocalSettings({
                ...localSettings,
                mid: { ...localSettings.mid, diameterMm: parseFloat(e.target.value) || 0 }
              })}
              className="px-2 py-1 text-xs bg-neutral-900 border border-neutral-700 rounded text-neutral-100"
            />
          </label>
        </div>

        {/* Base Settings */}
        <div className="space-y-2 mb-4">
          <div className="text-xs font-medium text-neutral-300">Base</div>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-neutral-400">Diameter (mm)</span>
              <input
                type="number"
                step="0.5"
                value={localSettings.base.diameterMm}
                onChange={(e) => setLocalSettings({
                  ...localSettings,
                  base: { ...localSettings.base, diameterMm: parseFloat(e.target.value) || 0 }
                })}
                className="px-2 py-1 text-xs bg-neutral-900 border border-neutral-700 rounded text-neutral-100"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-neutral-400">Height (mm)</span>
              <input
                type="number"
                step="0.1"
                value={localSettings.base.heightMm}
                onChange={(e) => setLocalSettings({
                  ...localSettings,
                  base: { ...localSettings.base, heightMm: parseFloat(e.target.value) || 0 }
                })}
                className="px-2 py-1 text-xs bg-neutral-900 border border-neutral-700 rounded text-neutral-100"
              />
            </label>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 px-3 py-2 text-xs font-medium text-neutral-300 bg-neutral-700 hover:bg-neutral-600 rounded transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="flex-1 px-3 py-2 text-xs font-medium text-neutral-100 bg-blue-600 hover:bg-blue-700 rounded transition-colors"
          >
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}
