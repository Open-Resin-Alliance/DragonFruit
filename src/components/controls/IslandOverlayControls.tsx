import React, { useState } from 'react';
import { NumberInput } from '@/components/ui/NumberInput';

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
    <div className="bg-neutral-800/95 backdrop-blur-sm rounded-lg px-3 pb-2 pt-1 shadow-xl">
      <div className="flex items-center justify-between py-1 border-b border-neutral-700 mb-1">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-0.5 hover:bg-neutral-700 rounded transition-colors"
            title={expanded ? 'Collapse card' : 'Expand card'}
          >
            <svg
              className={`w-3 h-3 transform transition-transform ${expanded ? 'text-blue-500' : 'text-neutral-500'}`}
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
          </button>
          <h3 className="text-xs font-semibold text-neutral-200">Island Overlay</h3>
        </div>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onEnabledChange(e.target.checked)}
            className="w-3 h-3 rounded border-neutral-600 bg-neutral-700 text-blue-500 focus:ring-1 focus:ring-blue-500 focus:ring-offset-0"
          />
          <span className="text-[9px] text-neutral-400 uppercase tracking-wide">{enabled ? 'On' : 'Off'}</span>
        </label>
      </div>

      {expanded && islandCount > 0 && (
        <div className="text-[9px] text-neutral-400 mb-1 px-1">
          {islandCount} island{islandCount !== 1 ? 's' : ''} detected
        </div>
      )}

      {expanded && (
        <div className="space-y-1">
          <div className="space-y-0.5">
            <label className="text-[9px] text-neutral-400 flex justify-between">
              <span>Brush Size</span>
              <div className="flex items-center gap-1">
                <NumberInput
                  value={brushRadiusMm}
                  onChange={(val) => {
                    if (val >= 0.1 && val <= 10.0) {
                      onBrushRadiusChange(val);
                    }
                  }}
                  className="w-12 px-1 py-0.5 text-[10px] bg-neutral-700 border border-neutral-600 rounded text-neutral-200 focus:outline-none focus:border-blue-500 text-right no-spinners"
                />
                <span className="text-neutral-500 text-[9px]">mm</span>
              </div>
            </label>
            <input
              type="range"
              min="0.1"
              max="5.0"
              step="0.1"
              value={brushRadiusMm}
              onChange={(e) => onBrushRadiusChange(parseFloat(e.target.value))}
              className="w-full h-1.5 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
            />
          </div>

          <div className="space-y-0.5">
            <label className="text-[9px] text-neutral-400">Color</label>
            <div className="flex gap-1.5 items-center">
              <input
                type="color"
                value={color}
                onChange={(e) => {
                  const newColor = e.target.value;
                  setEditingColor(newColor);
                  onColorChange(newColor);
                }}
                className="w-8 h-6 rounded border border-neutral-600 bg-neutral-700 cursor-pointer p-0"
              />
              <input
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
                className="flex-1 px-1.5 py-0.5 text-xs bg-neutral-700 border border-neutral-600 rounded text-neutral-200 focus:outline-none focus:border-blue-500 uppercase"
                placeholder="#FF0000"
              />
            </div>
          </div>

          <div className="space-y-0.5">
            <label className="text-[9px] text-neutral-400 flex justify-between">
              <span>Opacity</span>
              <span className="text-neutral-300">{Math.round(opacity * 100)}%</span>
            </label>
            <input
              type="range"
              min="0.1"
              max="1.0"
              step="0.05"
              value={opacity}
              onChange={(e) => onOpacityChange(parseFloat(e.target.value))}
              className="w-full h-1.5 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
            />
          </div>

          <div className="space-y-0.5">
            <label className="text-[9px] text-neutral-400 flex justify-between">
              <span>Taper</span>
              <span className="text-neutral-300">{Math.round((1 - taper) * 100)}%</span>
            </label>
            <input
              type="range"
              min="0.0"
              max="1.0"
              step="0.05"
              value={taper}
              onChange={(e) => onTaperChange(parseFloat(e.target.value))}
              className="w-full h-1.5 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
            />
          </div>
        </div>
      )}
    </div>
  );
}
