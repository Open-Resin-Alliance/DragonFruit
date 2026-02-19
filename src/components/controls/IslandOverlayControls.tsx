import React, { useState } from 'react';
import { NumberInput } from '@/components/ui/NumberInput';
import { Card, CardHeader, IconButton, Input } from '@/components/ui/primitives';

type IslandOverlayControlsProps = {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  brushRadiusMm: number;
  onBrushRadiusChange: (radius: number) => void;
  color: string;
  onColorChange: (color: string) => void;
  opacity: number;
  onOpacityChange: (opacity: number) => void;
  taper: number;
  onTaperChange: (taper: number) => void;
  islandCount: number;
};

/**
 * Control card for island overlay visualization settings.
 * Displays toggle, brush size, color, and opacity controls.
 */
export function IslandOverlayControls({
  enabled,
  onEnabledChange,
  brushRadiusMm,
  onBrushRadiusChange,
  color,
  onColorChange,
  opacity,
  onOpacityChange,
  taper,
  onTaperChange,
  islandCount
}: IslandOverlayControlsProps) {
  const [expanded, setExpanded] = useState(enabled);
  const [editingColor, setEditingColor] = useState(color);

  // Sync editing values when props change
  React.useEffect(() => {
    setEditingColor(color);
  }, [color]);

  return (
    <Card>
      <CardHeader
        left={(
          <>
            <IconButton
            onClick={() => setExpanded(!expanded)}
            className="!p-0.5"
            title={expanded ? 'Collapse card' : 'Expand card'}
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
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Island Overlay</h3>
          </>
        )}
        right={(
          <button
            type="button"
            onClick={() => onEnabledChange(!enabled)}
            className="h-8 min-w-[74px] rounded-md border px-2.5 text-[11px] font-semibold uppercase tracking-wide transition-colors"
            style={enabled
              ? {
                  borderColor: 'color-mix(in srgb, var(--accent), white 10%)',
                  background: 'color-mix(in srgb, var(--accent), var(--surface-0) 76%)',
                  color: 'var(--accent-contrast)',
                }
              : {
                  borderColor: 'var(--border-subtle)',
                  background: 'var(--surface-1)',
                  color: 'var(--text-muted)',
                }}
            title="Toggle Island Overlay"
          >
            {enabled ? 'ON' : 'OFF'}
          </button>
        )}
        hideDivider={!expanded}
      />

      {expanded && (
        <div className="px-2.5 pt-2 pb-3 space-y-2.5">
          {islandCount > 0 && (
            <div className="ui-meta">
              {islandCount} island{islandCount !== 1 ? 's' : ''} detected
            </div>
          )}

          <div className="space-y-1">
            <label className="ui-meta flex justify-between">
              <span>Brush Size</span>
              <div className="flex items-center gap-1">
                <NumberInput
                  value={brushRadiusMm}
                  onChange={(val) => {
                    if (val >= 0.1 && val <= 10.0) {
                      onBrushRadiusChange(val);
                    }
                  }}
                  className="ui-input w-14 !h-8 px-1.5 py-0 text-[11px] text-right no-spinners"
                />
                <span className="ui-meta">mm</span>
              </div>
            </label>
            <input
              type="range"
              min="0.1"
              max="5.0"
              step="0.1"
              value={brushRadiusMm}
              onChange={(e) => onBrushRadiusChange(parseFloat(e.target.value))}
              className="ui-range"
            />
          </div>

          <div className="space-y-1">
            <label className="ui-meta">Color</label>
            <div className="flex gap-1.5 items-center">
              <input
                type="color"
                value={color}
                onChange={(e) => {
                  const newColor = e.target.value;
                  setEditingColor(newColor);
                  onColorChange(newColor);
                }}
                className="w-10 h-8 rounded border cursor-pointer p-0"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
              />
              <Input
                type="text"
                value={editingColor}
                onChange={(e) => setEditingColor(e.target.value)}
                onBlur={(e) => {
                  const val = e.target.value.trim();
                  if (/^#[0-9a-fA-F]{6}$/.test(val) || /^#[0-9a-fA-F]{3}$/.test(val)) {
                    onColorChange(val);
                  } else {
                    setEditingColor(color);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.currentTarget.blur();
                  }
                }}
                className="flex-1 !h-8 px-2 py-0 text-sm uppercase"
                placeholder="#FF0000"
              />
            </div>
          </div>

          <div className="space-y-1">
            <label className="ui-meta flex justify-between">
              <span>Opacity</span>
              <span style={{ color: 'var(--text-strong)' }}>{Math.round(opacity * 100)}%</span>
            </label>
            <input
              type="range"
              min="0.1"
              max="1.0"
              step="0.05"
              value={opacity}
              onChange={(e) => onOpacityChange(parseFloat(e.target.value))}
              className="ui-range"
            />
          </div>

          <div className="space-y-1">
            <label className="ui-meta flex justify-between">
              <span>Taper</span>
              <span style={{ color: 'var(--text-strong)' }}>{Math.round((1 - taper) * 100)}%</span>
            </label>
            <input
              type="range"
              min="0.0"
              max="1.0"
              step="0.05"
              value={taper}
              onChange={(e) => onTaperChange(parseFloat(e.target.value))}
              className="ui-range"
            />
          </div>
        </div>
      )}
    </Card>
  );
}
