"use client";

import React from 'react';
import { Card, CardHeader, IconButton } from '@/components/ui/primitives';
import { ViewTypeDropdown } from '@/components/controls/ViewTypeDropdown';
import { LayerSlider } from '@/components/controls/LayerSlider';
import type { MeshShaderType } from '@/features/shaders/mesh';

type VisualSettingsPanelProps = {
  shaderOverride: MeshShaderType | null;
  onShaderOverrideChange: (value: MeshShaderType | null) => void;
  layerIndex: number;
  maxLayers: number;
  onLayerIndexChange: (value: number) => void;
  currentHeightMm?: number;
  maxHeightMm?: number;
  crossSectionMode: 'smooth' | 'rasterized';
};

export function VisualSettingsPanel({
  shaderOverride,
  onShaderOverrideChange,
  layerIndex,
  maxLayers,
  onLayerIndexChange,
  currentHeightMm,
  maxHeightMm,
  crossSectionMode,
}: VisualSettingsPanelProps) {
  const [expanded, setExpanded] = React.useState(true);

  return (
    <Card className={expanded ? 'h-[calc(100vh-var(--topbar-height)-24px)] flex flex-col' : ''}>
      <CardHeader
        left={(
          <>
            <IconButton
              onClick={() => setExpanded((prev) => !prev)}
              title={expanded ? 'Hide panel content' : 'Show panel content'}
              className="!p-0.5"
            >
              <svg
                className="w-3 h-3 transform transition-transform"
                style={{ color: expanded ? 'var(--accent)' : 'var(--text-muted)' }}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                {expanded ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                )}
              </svg>
            </IconButton>
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Visual Settings</h3>
          </>
        )}
        hideDivider={!expanded}
      />

      {expanded && (
        <div className="px-2.5 pt-1 pb-2.5 space-y-2 min-h-0 flex-1 flex flex-col">
          <ViewTypeDropdown
            value={shaderOverride}
            onChange={onShaderOverrideChange}
            fullWidth
          />

          <div className="h-px" style={{ background: 'var(--border-subtle)' }} />

          <div className="flex-1 min-h-[220px] overflow-hidden">
            <LayerSlider
              min={0}
              max={maxLayers}
              step={1}
              value={layerIndex}
              onChange={(v) => onLayerIndexChange(Math.round(v))}
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
      )}
    </Card>
  );
}
