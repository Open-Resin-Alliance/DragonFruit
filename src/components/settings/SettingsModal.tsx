'use client';

import React, { useEffect, useState } from 'react';
import { GeneralSettingsTab } from '@/components/settings/GeneralSettingsTab';
import { HotkeysSettingsTab } from '@/components/settings/HotkeysSettingsTab';
import { MeshSettingsTab } from '@/components/settings/MeshSettingsTab';
import type { MatcapVariant, MeshShaderType } from '@/features/shaders/mesh';

const DEFAULT_MESH_COLOR = '#a3a3a3';
const DEFAULT_AMBIENT_INTENSITY = 0.6;
const DEFAULT_DIRECTIONAL_INTENSITY = 0.8;
const DEFAULT_MATERIAL_ROUGHNESS = 0.65;
const DEFAULT_XRAY_OPACITY = 0.25;
const DEFAULT_SHADER_TYPE: MeshShaderType = 'soft_clay';
const DEFAULT_MATCAP_VARIANT: MatcapVariant = 'neutral';
const DEFAULT_FLAT_USE_VERTEX_COLORS = true;
const DEFAULT_TOON_STEPS = 5;

type SettingsModalProps = {
  isOpen: boolean;
  onClose: () => void;
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
};

type SettingsTabKey = 'general' | 'mesh' | 'hotkeys';

export function SettingsModal({
  isOpen,
  onClose,
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
}: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTabKey>('general');

  const [draftMeshColor, setDraftMeshColor] = useState(meshColor);
  const [draftShaderType, setDraftShaderType] = useState(shaderType);
  const [draftMatcapVariant, setDraftMatcapVariant] = useState(matcapVariant);
  const [draftFlatUseVertexColors, setDraftFlatUseVertexColors] = useState(flatUseVertexColors);
  const [draftToonSteps, setDraftToonSteps] = useState(toonSteps);
  const [draftAmbientIntensity, setDraftAmbientIntensity] = useState(ambientIntensity);
  const [draftDirectionalIntensity, setDraftDirectionalIntensity] = useState(directionalIntensity);
  const [draftMaterialRoughness, setDraftMaterialRoughness] = useState(materialRoughness);
  const [draftXrayOpacity, setDraftXrayOpacity] = useState(xrayOpacity);

  const resetDraftFromProps = React.useCallback(() => {
    setDraftMeshColor(meshColor);
    setDraftShaderType(shaderType);
    setDraftMatcapVariant(matcapVariant);
    setDraftFlatUseVertexColors(flatUseVertexColors);
    setDraftToonSteps(toonSteps);
    setDraftAmbientIntensity(ambientIntensity);
    setDraftDirectionalIntensity(directionalIntensity);
    setDraftMaterialRoughness(materialRoughness);
    setDraftXrayOpacity(xrayOpacity);
  }, [
    ambientIntensity,
    directionalIntensity,
    flatUseVertexColors,
    toonSteps,
    matcapVariant,
    materialRoughness,
    meshColor,
    shaderType,
    xrayOpacity,
  ]);

  const handleCancel = React.useCallback(() => {
    resetDraftFromProps();
    onClose();
  }, [onClose, resetDraftFromProps]);

  const handleRestoreDefaults = React.useCallback(() => {
    setDraftMeshColor(DEFAULT_MESH_COLOR);
    setDraftShaderType(DEFAULT_SHADER_TYPE);
    setDraftMatcapVariant(DEFAULT_MATCAP_VARIANT);
    setDraftFlatUseVertexColors(DEFAULT_FLAT_USE_VERTEX_COLORS);
    setDraftToonSteps(DEFAULT_TOON_STEPS);
    setDraftAmbientIntensity(DEFAULT_AMBIENT_INTENSITY);
    setDraftDirectionalIntensity(DEFAULT_DIRECTIONAL_INTENSITY);
    setDraftMaterialRoughness(DEFAULT_MATERIAL_ROUGHNESS);
    setDraftXrayOpacity(DEFAULT_XRAY_OPACITY);
  }, []);

  const handleApply = React.useCallback(() => {
    onMeshColorChange(draftMeshColor);
    onShaderTypeChange(draftShaderType);
    onMatcapVariantChange(draftMatcapVariant);
    onFlatUseVertexColorsChange(draftFlatUseVertexColors);
    onToonStepsChange(draftToonSteps);
    onAmbientIntensityChange(draftAmbientIntensity);
    onDirectionalIntensityChange(draftDirectionalIntensity);
    onMaterialRoughnessChange(draftMaterialRoughness);
    onXrayOpacityChange(draftXrayOpacity);
    onClose();
  }, [
    draftAmbientIntensity,
    draftDirectionalIntensity,
    draftFlatUseVertexColors,
    draftMatcapVariant,
    draftMaterialRoughness,
    draftMeshColor,
    draftShaderType,
    draftToonSteps,
    draftXrayOpacity,
    onAmbientIntensityChange,
    onClose,
    onDirectionalIntensityChange,
    onFlatUseVertexColorsChange,
    onMatcapVariantChange,
    onMaterialRoughnessChange,
    onMeshColorChange,
    onShaderTypeChange,
    onToonStepsChange,
    onXrayOpacityChange,
  ]);

  useEffect(() => {
    if (!isOpen) return;
    resetDraftFromProps();
  }, [isOpen, resetDraftFromProps]);

  useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleCancel();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, handleCancel]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/50 backdrop-blur-sm p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) handleCancel();
      }}
    >
      <div className="bg-neutral-900 rounded-lg shadow-2xl w-full max-w-[64rem] h-full flex flex-col border border-neutral-700">
        <div className="flex items-center justify-between p-2 border-b border-neutral-700">
          <h2 className="text-lg font-semibold text-white">Settings</h2>
          <button
            onClick={handleCancel}
            className="p-1 hover:bg-neutral-800 rounded transition-colors"
            aria-label="Close"
            type="button"
          >
            <svg className="w-5 h-5 text-neutral-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 min-h-0 flex">
          <div className="w-64 border-r border-neutral-700 bg-neutral-950/40 p-2">
            <div className="space-y-1">
              <button
                type="button"
                onClick={() => setActiveTab('general')}
                className={`w-full text-left px-3 py-2 rounded transition-colors ${activeTab === 'general'
                  ? 'bg-neutral-800 text-neutral-100'
                  : 'text-neutral-300 hover:bg-neutral-800/60'
                }`}
              >
                General
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('mesh')}
                className={`w-full text-left px-3 py-2 rounded transition-colors ${activeTab === 'mesh'
                  ? 'bg-neutral-800 text-neutral-100'
                  : 'text-neutral-300 hover:bg-neutral-800/60'
                }`}
              >
                Mesh Settings
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('hotkeys')}
                className={`w-full text-left px-3 py-2 rounded transition-colors ${activeTab === 'hotkeys'
                  ? 'bg-neutral-800 text-neutral-100'
                  : 'text-neutral-300 hover:bg-neutral-800/60'
                }`}
              >
                Hotkeys
              </button>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto p-2">
            {activeTab === 'general' && <GeneralSettingsTab />}
            {activeTab === 'mesh' && (
              <MeshSettingsTab
                shaderType={draftShaderType}
                onShaderTypeChange={setDraftShaderType}
                matcapVariant={draftMatcapVariant}
                onMatcapVariantChange={setDraftMatcapVariant}
                flatUseVertexColors={draftFlatUseVertexColors}
                onFlatUseVertexColorsChange={setDraftFlatUseVertexColors}
                toonSteps={draftToonSteps}
                onToonStepsChange={setDraftToonSteps}
                meshColor={draftMeshColor}
                onMeshColorChange={setDraftMeshColor}
                ambientIntensity={draftAmbientIntensity}
                onAmbientIntensityChange={setDraftAmbientIntensity}
                directionalIntensity={draftDirectionalIntensity}
                onDirectionalIntensityChange={setDraftDirectionalIntensity}
                materialRoughness={draftMaterialRoughness}
                onMaterialRoughnessChange={setDraftMaterialRoughness}
                xrayOpacity={draftXrayOpacity}
                onXrayOpacityChange={setDraftXrayOpacity}
              />
            )}
            {activeTab === 'hotkeys' && <HotkeysSettingsTab />}
          </div>
        </div>

        <div className="border-t border-neutral-700 p-2 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={handleRestoreDefaults}
            className="px-3 py-0.5 rounded border border-neutral-700 bg-neutral-900 text-neutral-200 hover:bg-neutral-800 transition-colors"
          >
            Restore Defaults
          </button>

          <button
            type="button"
            onClick={handleCancel}
            className="px-3 py-0.5 rounded border border-neutral-700 bg-neutral-900 text-neutral-200 hover:bg-neutral-800 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleApply}
            className="px-3 py-0.5 rounded bg-blue-600 text-white hover:bg-blue-500 transition-colors"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
