'use client';

import React from 'react';
import { HexColorPicker } from 'react-colorful';
import {
  MESH_SMOOTHING_BRUSH_SIZE_MM,
  clampMeshSmoothingBrushSizeMm,
  getMeshSmoothingSettings,
  loadMeshSmoothingSettingsFromLocalStorage,
  saveMeshSmoothingSettingsToLocalStorage,
  subscribeToMeshSmoothingSettings,
  updateMeshSmoothingSettings,
  type MeshSmoothingFalloff,
} from './settings';

export function MeshSmoothingSettingsPanel() {
  const [settings, setSettings] = React.useState(() => getMeshSmoothingSettings());

  React.useEffect(() => {
    loadMeshSmoothingSettingsFromLocalStorage();
    setSettings(getMeshSmoothingSettings());

    const unsubscribe = subscribeToMeshSmoothingSettings(() => {
      setSettings(getMeshSmoothingSettings());
    });

    return () => {
      unsubscribe();
    };
  }, []);

  React.useEffect(() => {
    saveMeshSmoothingSettingsToLocalStorage();
  }, [
    settings.brushSizeMm,
    settings.strength,
    settings.highlightColor,
    settings.falloff,
    settings.iterations,
  ]);

  return (
    <div className="h-full w-full flex flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-16 pt-1 space-y-1">
        <div className="text-[10px] font-semibold text-neutral-300 uppercase tracking-wide">Mesh Smoothing</div>

        <div className="bg-neutral-900/40 rounded p-2 border border-neutral-700 space-y-2">
          <div className="space-y-1">
            <label className="text-xs text-neutral-400 flex justify-between">
              <span>Brush Size (mm)</span>
              <span className="text-neutral-300">{settings.brushSizeMm.toFixed(2)}</span>
            </label>
            <input
              type="range"
              min={MESH_SMOOTHING_BRUSH_SIZE_MM.min}
              max={MESH_SMOOTHING_BRUSH_SIZE_MM.max}
              step={MESH_SMOOTHING_BRUSH_SIZE_MM.step}
              value={settings.brushSizeMm}
              onChange={(e) => updateMeshSmoothingSettings({ brushSizeMm: clampMeshSmoothingBrushSizeMm(parseFloat(e.target.value)) })}
              className="w-full h-2 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs text-neutral-400 flex justify-between">
              <span>Strength</span>
              <span className="text-neutral-300">{settings.strength.toFixed(2)}</span>
            </label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={settings.strength}
              onChange={(e) => updateMeshSmoothingSettings({ strength: parseFloat(e.target.value) })}
              className="w-full h-2 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-neutral-300">Falloff</label>
            <select
              value={settings.falloff}
              onChange={(e) => updateMeshSmoothingSettings({ falloff: e.target.value as MeshSmoothingFalloff })}
              className="w-full rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none"
            >
              <option value="linear">Linear</option>
              <option value="smooth">Smooth</option>
              <option value="sharp">Sharp</option>
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-neutral-400 flex justify-between">
              <span>Iterations</span>
              <span className="text-neutral-300">{settings.iterations}</span>
            </label>
            <input
              type="range"
              min="1"
              max="10"
              step="1"
              value={settings.iterations}
              onChange={(e) => updateMeshSmoothingSettings({ iterations: parseInt(e.target.value, 10) })}
              className="w-full h-2 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-neutral-300">Paint Color</label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={settings.highlightColor}
                onChange={(e) => updateMeshSmoothingSettings({ highlightColor: e.target.value })}
                className="flex-1 rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-sm text-neutral-100"
                placeholder="#269eff"
              />
            </div>

            <div className="h-32 rounded-md overflow-hidden bg-neutral-800/40 p-1">
              <HexColorPicker
                color={settings.highlightColor}
                onChange={(c) => updateMeshSmoothingSettings({ highlightColor: c })}
                style={{ width: '100%', height: '100%' }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
