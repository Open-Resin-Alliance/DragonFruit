"use client";

import React from 'react';
import { Card } from '@/components/ui/primitives';
import { LayerSlider } from '@/components/controls/LayerSlider';

type VisualSettingsPanelProps = {
  layerIndex: number;
  maxLayers: number;
  onLayerIndexChange: (value: number) => void;
  onCrossSectionModeChange?: (mode: 'smooth' | 'rasterized') => void;
  currentHeightMm?: number;
  maxHeightMm?: number;
  crossSectionMode: 'smooth' | 'rasterized';
};

export function VisualSettingsPanel({
  layerIndex,
  maxLayers,
  onLayerIndexChange,
  onCrossSectionModeChange,
  currentHeightMm,
  maxHeightMm,
  crossSectionMode,
}: VisualSettingsPanelProps) {
  return (
    <Card className="h-[calc(100vh-var(--topbar-height)-24px)] flex flex-col">
      <div className="px-0 py-2 min-h-0 flex-1 flex flex-col">
        <div className="flex-1 min-h-[220px] overflow-visible">
          <LayerSlider
            min={0}
            max={maxLayers}
            step={1}
            value={layerIndex}
            onChange={(v) => onLayerIndexChange(Math.round(v))}
            onCrossSectionModeChange={onCrossSectionModeChange}
            currentHeightMm={currentHeightMm}
            maxHeightMm={maxHeightMm}
            showValue={true}
            crossSectionMode={crossSectionMode}
            docked
            embedded
            expandToContainer
            className="h-full"
          />
        </div>
      </div>
    </Card>
  );
}
