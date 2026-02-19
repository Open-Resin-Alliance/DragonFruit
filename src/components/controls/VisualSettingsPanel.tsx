"use client";

import React from 'react';
import { Card, CardHeader, IconButton, Input } from '@/components/ui/primitives';
import { ViewTypeDropdown } from '@/components/controls/ViewTypeDropdown';
import { SelectionHighlightDropdown } from '@/components/controls/SelectionHighlightDropdown';
import { LayerSlider } from '@/components/controls/LayerSlider';
import type { MeshShaderType } from '@/features/shaders/mesh';
import type { SelectionHighlightMode } from '@/components/selection';

type VisualSettingsPanelProps = {
  shaderOverride: MeshShaderType | null;
  onShaderOverrideChange: (value: MeshShaderType | null) => void;
  layerIndex: number;
  maxLayers: number;
  onLayerIndexChange: (value: number) => void;
  currentHeightMm?: number;
  maxHeightMm?: number;
  crossSectionMode: 'smooth' | 'rasterized';
  selectionHighlightMode: SelectionHighlightMode;
  onSelectionHighlightModeChange: (mode: SelectionHighlightMode) => void;
  layerHeightMicron: number;
  onLayerHeightMicronChange: (value: number) => void;
  layerHeightMm: number;
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
  selectionHighlightMode,
  onSelectionHighlightModeChange,
  layerHeightMicron,
  onLayerHeightMicronChange,
  layerHeightMm,
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
          <div className="rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              Layer Height
            </div>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                className="w-[5.5rem]"
                min={1}
                step={1}
                value={layerHeightMicron}
                onChange={(e) => onLayerHeightMicronChange(parseInt(e.target.value || '0', 10))}
              />
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>µm</span>
              <span className="text-xs tabular-nums" style={{ color: 'var(--text-muted)' }}>
                ({layerHeightMm.toFixed(3)} mm)
              </span>
            </div>
          </div>

          <ViewTypeDropdown
            value={shaderOverride}
            onChange={onShaderOverrideChange}
            fullWidth
          />

          <SelectionHighlightDropdown
            value={selectionHighlightMode}
            onChange={onSelectionHighlightModeChange}
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
