"use client";

import React, { useState, useEffect, useRef } from 'react';
import { getCurrentSupportSettings, setCurrentSupportSettings, updateAllSupportsBaseFlare, saveSupportsToLocalStorage, loadSupportsFromLocalStorage, getSupportList, exportSupportsToFile, importSupportsFromFile } from './state';
import { PresetSelector } from './PresetSelector';
import { GridSettingsCard } from './Grid/GridSettingsCard';

// Sidebar component shown in Support mode. Allows editing of the "current"
// support profile (tip, shaft, base). New supports will copy these settings
// when they are created.
export function SupportSidebar() {
  const [localState, setLocalState] = useState(() => getCurrentSupportSettings());

  // Keep module state in sync when local changes.
  useEffect(() => {
    setCurrentSupportSettings(localState);
  }, [localState]);

  // Update all supports when baseFlare settings change
  useEffect(() => {
    updateAllSupportsBaseFlare(localState.baseFlare);
  }, [localState.baseFlare]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSave = () => {
    saveSupportsToLocalStorage();
    const count = getSupportList().length;
    alert(`Saved ${count} support(s) to localStorage`);
  };

  const handleLoad = () => {
    const loaded = loadSupportsFromLocalStorage();
    if (loaded) {
      const count = getSupportList().length;
      alert(`Loaded ${count} support(s) from localStorage`);
    } else {
      alert('No saved supports found in localStorage');
    }
  };

  const handleExport = () => {
    exportSupportsToFile();
    const count = getSupportList().length;
    alert(`Exported ${count} support(s) to JSON file`);
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const success = await importSupportsFromFile(file);
    if (success) {
      const count = getSupportList().length;
      alert(`Imported ${count} support(s) from file`);
    } else {
      alert('Failed to import file. Please check the file format.');
    }

    // Reset input so same file can be imported again
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <div className="bg-neutral-800 rounded-lg p-4 space-y-4">
      <h3 className="text-sm font-semibold text-neutral-100">Support Settings</h3>

      {/* Preset Selector */}
      <PresetSelector />

      {/* Save/Load Controls */}
      <div className="space-y-2">
        <div className="flex gap-2">
          <button
            onClick={handleSave}
            className="flex-1 px-3 py-2 text-xs font-medium text-neutral-100 bg-blue-600 hover:bg-blue-700 rounded border border-blue-500 transition-colors"
          >
            Save
          </button>
          <button
            onClick={handleLoad}
            className="flex-1 px-3 py-2 text-xs font-medium text-neutral-100 bg-green-600 hover:bg-green-700 rounded border border-green-500 transition-colors"
          >
            Load
          </button>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleExport}
            className="flex-1 px-3 py-2 text-xs font-medium text-neutral-100 bg-purple-600 hover:bg-purple-700 rounded border border-purple-500 transition-colors"
          >
            Export JSON
          </button>
          <button
            onClick={handleImportClick}
            className="flex-1 px-3 py-2 text-xs font-medium text-neutral-100 bg-orange-600 hover:bg-orange-700 rounded border border-orange-500 transition-colors"
          >
            Import JSON
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          onChange={handleImportFile}
          className="hidden"
        />
      </div>

      {/* Placement info (read-only for now) */}
      <div className="text-xs text-neutral-400 bg-neutral-900/80 rounded-md p-2 border border-neutral-700">
        <div className="font-semibold text-neutral-200 mb-1">Placement</div>
        <p>
          In Support mode, click on the model to place a support. The tip will be aligned
          perpendicular to the surface (along the local surface normal) and the base will
          drop to the build plate.
        </p>
      </div>

      {/* Tip settings */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-neutral-300">Tip</span>
          <span className="text-[10px] text-neutral-500">cone</span>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <label className="flex flex-col gap-1 col-span-2">
            <span className="text-neutral-400">Contact Type</span>
            <select
              value={localState.tip.type || 'disk'}
              onChange={(e) =>
                setLocalState((prev) => ({
                  ...prev,
                  tip: { 
                    ...prev.tip, 
                    type: e.target.value as any,
                    // Ensure disk defaults are present if switching to disk
                    ...(e.target.value === 'disk' ? {
                        diskThicknessMm: 0.1,
                        maxStandoffMm: 0.35, // Updated default from 1.5
                        standoffAngleThreshold: Math.PI / 4,
                    } : {})
                  },
                }))
              }
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100"
            >
              <option value="disk">Contact Disk (Nib)</option>
              {/* Placeholder for future types */}
              {/* <option value="sphere">Contact Sphere</option> */}
            </select>
          </label>
          
          {/* Contact Disk Settings */}
          {localState.tip.type === 'disk' && (
            <label className="flex flex-col gap-1 col-span-2">
              <span className="text-neutral-400">Max Standoff (mm)</span>
              <input
                type="number"
                min={0.1}
                step={0.05}
                value={localState.tip.maxStandoffMm ?? 0.35}
                onChange={(e) =>
                  setLocalState((prev) => ({
                    ...prev,
                    tip: { ...prev.tip, maxStandoffMm: parseFloat(e.target.value) || 0.1 },
                  }))
                }
                className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100"
              />
            </label>
          )}

          <label className="flex flex-col gap-1">
            <span className="text-neutral-400">Contact diameter (mm)</span>
            <input
              type="number"
              min={0.05}
              step={0.05}
              value={localState.tip.contactDiameterMm}
              onChange={(e) =>
                setLocalState((prev) => ({
                  ...prev,
                  tip: { ...prev.tip, contactDiameterMm: parseFloat(e.target.value) || 0 },
                }))
              }
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-neutral-400">Body diameter (mm)</span>
            <input
              type="number"
              min={0.2}
              step={0.1}
              value={localState.tip.bodyDiameterMm}
              onChange={(e) =>
                setLocalState((prev) => ({
                  ...prev,
                  tip: { ...prev.tip, bodyDiameterMm: parseFloat(e.target.value) || 0 },
                }))
              }
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-neutral-400">Tip length (mm)</span>
            <input
              type="number"
              min={0.5}
              step={0.1}
              value={localState.tip.lengthMm}
              onChange={(e) =>
                setLocalState((prev) => ({
                  ...prev,
                  tip: { ...prev.tip, lengthMm: parseFloat(e.target.value) || 0 },
                }))
              }
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100"
            />
          </label>
        </div>
      </div>

      {/* Mid (shaft) settings */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-neutral-300">Shaft</span>
          <span className="text-[10px] text-neutral-500">{localState.mid.shape}</span>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <label className="flex flex-col gap-1 col-span-2">
            <span className="text-neutral-400">Diameter (mm)</span>
            <input
              type="number"
              min={0.5}
              step={0.1}
              value={localState.mid.diameterMm}
              onChange={(e) =>
                setLocalState((prev) => ({
                  ...prev,
                  mid: { ...prev.mid, diameterMm: parseFloat(e.target.value) || 0 },
                }))
              }
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100"
            />
          </label>
        </div>
      </div>

      {/* Base settings */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-neutral-300">Base</span>
          <span className="text-[10px] text-neutral-500">{localState.base.shape}</span>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <label className="flex flex-col gap-1">
            <span className="text-neutral-400">Diameter (mm)</span>
            <input
              type="number"
              min={2}
              step={0.5}
              value={localState.base.diameterMm}
              onChange={(e) =>
                setLocalState((prev) => ({
                  ...prev,
                  base: { ...prev.base, diameterMm: parseFloat(e.target.value) || 0 },
                }))
              }
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-neutral-400">Height (mm)</span>
            <input
              type="number"
              min={0.1}
              step={0.05}
              value={localState.base.heightMm}
              onChange={(e) =>
                setLocalState((prev) => ({
                  ...prev,
                  base: { ...prev.base, heightMm: parseFloat(e.target.value) || 0 },
                }))
              }
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100"
            />
          </label>
        </div>
      </div>

      {/* Base Flare settings */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-neutral-300">Base Flare</span>
          <label className="flex items-center gap-2 cursor-pointer">
            <span className="text-[10px] text-neutral-500">
              {localState.baseFlare.enabled ? 'enabled' : 'disabled'}
            </span>
            <input
              type="checkbox"
              checked={localState.baseFlare.enabled}
              onChange={(e) => {
                const newEnabled = e.target.checked;
                setLocalState((prev) => ({
                  ...prev,
                  baseFlare: { ...prev.baseFlare, enabled: newEnabled },
                }));
              }}
              className="w-4 h-4 rounded border-neutral-700 bg-neutral-900 text-blue-600 focus:ring-2 focus:ring-blue-500"
            />
          </label>
        </div>
        {localState.baseFlare.enabled && (
          <div className="grid grid-cols-2 gap-2 text-xs">
            <label className="flex flex-col gap-1">
              <span className="text-neutral-400">Diameter (mm)</span>
              <input
                type="number"
                min={2}
                step={0.5}
                value={localState.baseFlare.diameterMm}
                onChange={(e) => {
                  const newDiameter = parseFloat(e.target.value) || 0;
                  setLocalState((prev) => ({
                    ...prev,
                    baseFlare: { ...prev.baseFlare, diameterMm: newDiameter },
                  }));
                }}
                className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-neutral-400">Height (mm)</span>
              <input
                type="number"
                min={0.1}
                step={0.1}
                value={localState.baseFlare.heightMm}
                onChange={(e) => {
                  const newHeight = parseFloat(e.target.value) || 0;
                  setLocalState((prev) => ({
                    ...prev,
                    baseFlare: { ...prev.baseFlare, heightMm: newHeight },
                  }));
                }}
                className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-100"
              />
            </label>
          </div>
        )}
      </div>

      {/* Grid Settings */}
      <GridSettingsCard
        grid={localState.grid}
        onChange={(newGrid) =>
          setLocalState((prev) => ({
            ...prev,
            grid: newGrid,
          }))
        }
      />
    </div>
  );
}
