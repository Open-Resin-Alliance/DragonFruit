'use client';

import React from 'react';
import type { MatcapVariant, MeshShaderType } from '@/features/shaders/mesh';
import { MeshShaderPreviewCanvas } from './MeshShaderPreviewCanvas';

export function MeshShaderPreviewSlot({
  shaderType,
  matcapVariant,
  flatUseVertexColors,
  toonSteps,
  meshColor,
  materialRoughness,
  previewModel,
  ambientIntensity,
  directionalIntensity,
  xrayOpacity,
  heatmapBlend,
  heatmapContrast,
  heatmapColors,
  hoverTintStrength,
  selectedTintStrength,
}: {
  shaderType: MeshShaderType;
  matcapVariant: MatcapVariant;
  flatUseVertexColors: boolean;
  toonSteps: number;
  meshColor: string;
  materialRoughness: number;
  previewModel: string;
  ambientIntensity: number;
  directionalIntensity: number;
  xrayOpacity: number;
  heatmapBlend: number;
  heatmapContrast: number;
  heatmapColors?: string[];
  hoverTintStrength: number;
  selectedTintStrength: number;
}) {
  return (
    <div className="w-full h-full relative">
      <MeshShaderPreviewCanvas
        shaderType={shaderType}
        matcapVariant={matcapVariant}
        flatUseVertexColors={flatUseVertexColors}
        toonSteps={toonSteps}
        meshColor={meshColor}
        materialRoughness={materialRoughness}
        previewModel={previewModel}
        ambientIntensity={ambientIntensity}
        directionalIntensity={directionalIntensity}
        xrayOpacity={xrayOpacity}
        heatmapBlend={heatmapBlend}
        heatmapContrast={heatmapContrast}
        heatmapColors={heatmapColors}
        hoverTintStrength={hoverTintStrength}
        selectedTintStrength={selectedTintStrength}
      />
    </div>
  );
}
