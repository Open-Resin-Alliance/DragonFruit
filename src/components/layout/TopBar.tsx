"use client";

import React from 'react';
import { MeshAppearancePopover } from '@/components/controls/MeshAppearancePopover';
import type { SupportMode } from '@/supports/types';
import type { SelectionHighlightMode } from '@/components/selection';

interface TopBarProps {
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  fileName: string | null;
  layerHeightMicron: number;
  onLayerHeightChange: (value: number) => void;
  layerHeightMm: number;
  meshColor: string;
  onMeshColorChange: (color: string) => void;
  ambientIntensity: number;
  onAmbientIntensityChange: (value: number) => void;
  directionalIntensity: number;
  onDirectionalIntensityChange: (value: number) => void;
  materialRoughness: number;
  onMaterialRoughnessChange: (value: number) => void;
  meshVisible: boolean;
  onMeshVisibleChange: (visible: boolean) => void;
  // New: global application mode (prepare vs support)
  mode: SupportMode;
  onModeChange: (mode: SupportMode) => void;
  // Selection highlight mode
  selectionHighlightMode: SelectionHighlightMode;
  onSelectionHighlightModeChange: (mode: SelectionHighlightMode) => void;
}

export function TopBar({
  onFileChange,
  fileName,
  layerHeightMicron,
  onLayerHeightChange,
  layerHeightMm,
  meshColor,
  onMeshColorChange,
  ambientIntensity,
  onAmbientIntensityChange,
  directionalIntensity,
  onDirectionalIntensityChange,
  materialRoughness,
  onMaterialRoughnessChange,
  meshVisible,
  onMeshVisibleChange,
  mode,
  onModeChange,
  selectionHighlightMode,
  onSelectionHighlightModeChange,
}: TopBarProps) {
  return (
    <div className="fixed top-0 left-0 right-0 h-14 bg-neutral-900 border-b border-neutral-700 z-50 flex items-center px-4 gap-4">
      {/* Logo/Title */}
      {/* Logo */}
      <img
        src="/textonlyupdate.png"
        alt="Dragonfruit Slicer"
        className="h-12 w-auto object-contain -ml-2"
      />

      {/* Load STL Button */}
      <div className="flex items-center gap-2">
        <label
          htmlFor="stl-file-input"
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded cursor-pointer transition-colors"
        >
          Load STL
        </label>
        <input
          id="stl-file-input"
          type="file"
          accept=".stl"
          multiple
          onChange={onFileChange}
          className="hidden"
        />
        {fileName && (
          <span className="text-sm text-neutral-400">
            {fileName}
          </span>
        )}
      </div>

      {/* Divider */}
      <div className="h-8 w-px bg-neutral-700" />

      {/* Layer Height */}
      <div className="flex items-center gap-2">
        <label className="text-sm text-neutral-300 whitespace-nowrap">
          Layer Height:
        </label>
        <input
          type="number"
          className="w-20 rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none"
          min={1}
          step={1}
          value={layerHeightMicron}
          onChange={(e) => onLayerHeightChange(parseInt(e.target.value || '0', 10))}
        />
        <span className="text-xs text-neutral-400">µm</span>
        <span className="text-xs text-neutral-500">
          ({layerHeightMm.toFixed(3)} mm)
        </span>
      </div>

      {/* Divider */}
      <div className="h-8 w-px bg-neutral-700" />

      {/* Mode Toggle: Prepare / Support */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onModeChange('prepare')}
          className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${mode === 'prepare'
            ? 'bg-blue-600 border-blue-500 text-white'
            : 'bg-neutral-800 border-neutral-700 text-neutral-200 hover:bg-neutral-700'
            }`}
          title="Prepare mode: move/rotate/scale the model"
        >
          Prepare
        </button>
        <button
          type="button"
          onClick={() => onModeChange('analysis')}
          className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${mode === 'analysis'
            ? 'bg-blue-600 border-blue-500 text-white'
            : 'bg-neutral-800 border-neutral-700 text-neutral-200 hover:bg-neutral-700'
            }`}
          title="Analysis mode: Island scanning and voxel analysis"
        >
          Analysis
        </button>
        <button
          type="button"
          onClick={() => onModeChange('support')}
          className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${mode === 'support'
            ? 'bg-blue-600 border-blue-500 text-white'
            : 'bg-neutral-800 border-neutral-700 text-neutral-200 hover:bg-neutral-700'
            }`}
          title="Support mode: place and edit supports"
        >
          Support
        </button>

        <button
          type="button"
          onClick={() => onModeChange('export')}
          className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${mode === 'export'
            ? 'bg-blue-600 border-blue-500 text-white'
            : 'bg-neutral-800 border-neutral-700 text-neutral-200 hover:bg-neutral-700'
            }`}
          title="Export mode: Generate and download STL"
        >
          Export
        </button>
      </div>

      {/* Divider */}
      <div className="h-8 w-px bg-neutral-700" />

      {/* Selection Highlight Mode */}
      <div className="flex items-center gap-2">
        <label className="text-sm text-neutral-300 whitespace-nowrap">
          Selection:
        </label>
        <select
          value={selectionHighlightMode}
          onChange={(e) => onSelectionHighlightModeChange(e.target.value as SelectionHighlightMode)}
          className="rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none"
        >
          <option value="spotlight">Spotlight</option>
          <option value="fresnel">Fresnel</option>
          <option value="tint">Mesh Tint</option>
          <option value="none">None</option>
        </select>
      </div>

      {/* Divider */}
      <div className="h-8 w-px bg-neutral-700" />

      {/* Mesh Appearance Popover */}
      <MeshAppearancePopover
        meshColor={meshColor}
        onMeshColorChange={onMeshColorChange}
        ambientIntensity={ambientIntensity}
        onAmbientIntensityChange={onAmbientIntensityChange}
        directionalIntensity={directionalIntensity}
        onDirectionalIntensityChange={onDirectionalIntensityChange}
        materialRoughness={materialRoughness}
        onMaterialRoughnessChange={onMaterialRoughnessChange}
      />

      {/* Hide Mesh Toggle */}
      <button
        onClick={() => onMeshVisibleChange(!meshVisible)}
        className={`px-3 py-1.5 rounded text-sm transition-colors ${meshVisible
          ? 'bg-neutral-700 hover:bg-neutral-600 text-neutral-200'
          : 'bg-blue-600 hover:bg-blue-700 text-white'
          }`}
        title={meshVisible ? 'Hide mesh' : 'Show mesh'}
      >
        {meshVisible ? (
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
          </svg>
        ) : (
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
          </svg>
        )}
      </button>

      {/* Future tools will go here */}
      <div className="flex-1" />
    </div>
  );
}
