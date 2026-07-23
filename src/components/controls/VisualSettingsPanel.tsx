"use client";

import React from 'react';
import { Card } from '@/components/atoms';
import { LayerSlider } from '@/components/controls/LayerSlider';

type VisualSettingsPanelProps = {
  layerIndex: number;
  maxLayers: number;
  onLayerIndexChange: (value: number) => void;
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
  currentHeightMm?: number;
  maxHeightMm?: number;
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
  currentHeightMm,
  maxHeightMm,
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
      <div className="px-0 py-1 min-h-0 flex-1 flex flex-col">
        <div className="flex-1 min-h-[220px] overflow-visible">
          <LayerSlider
            min={0}
            max={maxLayers}
            step={1}
            value={layerIndex}
            onChange={handleLayerChange}
            onScrubStart={onScrubStart}
            onScrubEnd={onScrubEnd}
            currentHeightMm={currentHeightMm}
            maxHeightMm={maxHeightMm}
            showValue={true}
            lowerValue={lowerLayerIndex}
            onLowerChange={onLowerLayerIndexChange}
            lowerCurrentHeightMm={lowerCurrentHeightMm}
            crossSectionEnabled={crossSectionEnabled}
            onToggleCrossSection={onToggleCrossSection}
            layerHeightMm={layerHeightMm}
            compactMinimalRail
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
