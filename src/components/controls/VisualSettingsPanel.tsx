"use client";

import React from 'react';
import { Card } from '@/components/ui/primitives';
import { LayerSlider } from '@/components/controls/LayerSlider';

type VisualSettingsPanelProps = {
  layerIndex: number;
  maxLayers: number;
  onLayerIndexChange: (value: number) => void;
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
  onCrossSectionModeChange?: (mode: 'smooth' | 'rasterized') => void;
  currentHeightMm?: number;
  maxHeightMm?: number;
  crossSectionMode: 'smooth' | 'rasterized';
  lowerLayerIndex?: number;
  onLowerLayerIndexChange?: (value: number) => void;
  lowerCurrentHeightMm?: number;
  crossSectionEnabled?: boolean;
  onToggleCrossSection?: () => void;
  layerHeightMm?: number;
};

export function VisualSettingsPanel({
  layerIndex,
  maxLayers,
  onLayerIndexChange,
  onScrubStart,
  onScrubEnd,
  onCrossSectionModeChange,
  currentHeightMm,
  maxHeightMm,
  crossSectionMode,
  lowerLayerIndex,
  onLowerLayerIndexChange,
  lowerCurrentHeightMm,
  crossSectionEnabled,
  onToggleCrossSection,
  layerHeightMm,
}: VisualSettingsPanelProps) {
  const handleLayerChange = React.useCallback((nextValue: number) => {
    onLayerIndexChange(Math.round(nextValue));
  }, [onLayerIndexChange]);

  return (
    <Card className="h-[calc(100vh-var(--topbar-height)-24px)] flex flex-col">
      <div className="px-0 py-2 min-h-0 flex-1 flex flex-col">
        <div className="flex-1 min-h-[220px] overflow-visible">
          <LayerSlider
            min={0}
            max={maxLayers}
            step={1}
            value={layerIndex}
            onChange={handleLayerChange}
            onScrubStart={onScrubStart}
            onScrubEnd={onScrubEnd}
            onCrossSectionModeChange={onCrossSectionModeChange}
            currentHeightMm={currentHeightMm}
            maxHeightMm={maxHeightMm}
            showValue={true}
            crossSectionMode={crossSectionMode}
            lowerValue={lowerLayerIndex}
            onLowerChange={onLowerLayerIndexChange}
            lowerCurrentHeightMm={lowerCurrentHeightMm}
            showModeIndicator={false}
            crossSectionEnabled={crossSectionEnabled}
            onToggleCrossSection={onToggleCrossSection}
            layerHeightMm={layerHeightMm}
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
