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
}) {
  return (
    <div className="w-full h-full relative bg-neutral-900/50 rounded-lg overflow-hidden border border-neutral-700/50">
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
      />
    </div>
  );
}
