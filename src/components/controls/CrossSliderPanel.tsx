"use client";

import React from 'react';
import { Card } from '@/components/atoms';
import { LayerSlider, type LayerSliderRangeBand } from '@/components/controls/LayerSlider';

type CrossSliderPanelProps = {
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
  rangeBands?: readonly LayerSliderRangeBand[];
  onRangeContextMenu?: (value: number, position: { x: number; y: number }) => void;
};

export function CrossSliderPanel({
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
  rangeBands,
  onRangeContextMenu,
}: CrossSliderPanelProps) {
  const handleLayerChange = React.useCallback((nextValue: number) => {
    onLayerIndexChange(Math.round(nextValue));
  }, [onLayerIndexChange]);

  return (
    <Card className="h-full flex flex-col">
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
            rangeBands={rangeBands}
            onRangeContextMenu={onRangeContextMenu}
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
