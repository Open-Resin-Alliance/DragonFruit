"use client";

import React, { useState } from 'react';
import { SettingsModal } from '@/components/settings/SettingsModal';
import type { SupportMode } from '@/supports/types';
import type { SelectionHighlightMode } from '@/components/selection';
import type { MatcapVariant, MeshShaderType } from '@/features/shaders/mesh';
import { getAnatomyPreviewState, setAnatomyPreviewShowTuner, subscribeToAnatomyPreviewState } from '@/supports/Settings/AnatomyPreview/previewState';

interface TopBarProps {
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  layerHeightMicron: number;
  onLayerHeightChange: (value: number) => void;
  layerHeightMm: number;
  meshColor: string;
  onMeshColorChange: (color: string) => void;
  shaderType: MeshShaderType;
  onShaderTypeChange: (shaderType: MeshShaderType) => void;
  matcapVariant: MatcapVariant;
  onMatcapVariantChange: (variant: MatcapVariant) => void;
  flatUseVertexColors: boolean;
  onFlatUseVertexColorsChange: (value: boolean) => void;
  toonSteps: number;
  onToonStepsChange: (value: number) => void;
  ambientIntensity: number;
  onAmbientIntensityChange: (value: number) => void;
  directionalIntensity: number;
  onDirectionalIntensityChange: (value: number) => void;
  materialRoughness: number;
  onMaterialRoughnessChange: (value: number) => void;
  xrayOpacity: number;
  onXrayOpacityChange: (value: number) => void;
  // New: global application mode (prepare vs support)
  mode: SupportMode;
  onModeChange: (mode: SupportMode) => void;
  // Selection highlight mode
  selectionHighlightMode: SelectionHighlightMode;
  onSelectionHighlightModeChange: (mode: SelectionHighlightMode) => void;
  // New: LYS Import
  onImportLysChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

export function TopBar({
  onFileChange,
  layerHeightMicron,
  onLayerHeightChange,
  layerHeightMm,
  meshColor,
  onMeshColorChange,
  shaderType,
  onShaderTypeChange,
  matcapVariant,
  onMatcapVariantChange,
  flatUseVertexColors,
  onFlatUseVertexColorsChange,
  toonSteps,
  onToonStepsChange,
  ambientIntensity,
  onAmbientIntensityChange,
  directionalIntensity,
  onDirectionalIntensityChange,
  materialRoughness,
  onMaterialRoughnessChange,
  xrayOpacity,
  onXrayOpacityChange,
  mode,
  onModeChange,
  selectionHighlightMode,
  onSelectionHighlightModeChange,
  onImportLysChange,
}: TopBarProps) {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const previewState = React.useSyncExternalStore(subscribeToAnatomyPreviewState, getAnatomyPreviewState, getAnatomyPreviewState);

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
      </div>

      {/* Import LYS Button */}
      {onImportLysChange && (
        <div className="flex items-center gap-2">
          <label
            htmlFor="lys-file-input"
            className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded cursor-pointer transition-colors"
          >
            Import LYS
          </label>
          <input
            id="lys-file-input"
            type="file"
            accept=".lys"
            onChange={onImportLysChange}
            className="hidden"
          />
        </div>
      )}

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

      {mode === 'support' && (
        <>
          <div className="h-8 w-px bg-neutral-700 mx-2" />
          <button
            type="button"
            onClick={() => {
              console.log('Toggling Tuner:', !previewState.showTuner);
              setAnatomyPreviewShowTuner(!previewState.showTuner);
            }}
            className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${previewState.showTuner
              ? 'bg-gradient-to-r from-pink-500 to-rose-500 border-pink-400 text-white shadow-[0_0_10px_rgba(236,72,153,0.3)]'
              : 'bg-neutral-800 border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700'
              }`}
            title="Toggle Anatomy Preview Tuner"
          >
            Tuner
          </button>
        </>
      )}

      <div className="flex-1" />

      <button
        type="button"
        onClick={() => setIsSettingsOpen(true)}
        className="p-2 rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-200 transition-colors"
        title="Settings"
        aria-label="Settings"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
          />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </button>

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        meshColor={meshColor}
        onMeshColorChange={onMeshColorChange}
        shaderType={shaderType}
        onShaderTypeChange={onShaderTypeChange}
        matcapVariant={matcapVariant}
        onMatcapVariantChange={onMatcapVariantChange}
        flatUseVertexColors={flatUseVertexColors}
        onFlatUseVertexColorsChange={onFlatUseVertexColorsChange}
        toonSteps={toonSteps}
        onToonStepsChange={onToonStepsChange}
        ambientIntensity={ambientIntensity}
        onAmbientIntensityChange={onAmbientIntensityChange}
        directionalIntensity={directionalIntensity}
        onDirectionalIntensityChange={onDirectionalIntensityChange}
        materialRoughness={materialRoughness}
        onMaterialRoughnessChange={onMaterialRoughnessChange}
        xrayOpacity={xrayOpacity}
        onXrayOpacityChange={onXrayOpacityChange}
      />
    </div>
  );
}
