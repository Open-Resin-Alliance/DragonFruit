import React, { useState, useRef } from 'react';

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
  const brushInputRef = useRef<HTMLInputElement>(null);
  const isEditingBrushRef = useRef(false);
  
  // Sync editing values when props change
  React.useEffect(() => {
    setEditingColor(color);
  }, [color]);
  
  // Update input value only when not actively editing
  React.useEffect(() => {
    if (brushInputRef.current && !isEditingBrushRef.current) {
      brushInputRef.current.value = brushRadiusMm.toFixed(1);
    }
  }, [brushRadiusMm]);
  
  return (
    <div className="bg-neutral-800 rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-0.5 hover:bg-neutral-700 rounded transition-colors"
            title={expanded ? 'Collapse card' : 'Expand card'}
          >
            <svg 
              className={`w-4 h-4 ${expanded ? 'text-blue-500' : 'text-neutral-500'}`} 
              fill="none" 
              stroke="currentColor" 
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
          </button>
          <h3 className="text-sm font-semibold text-neutral-200">Island Overlay</h3>
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onEnabledChange(e.target.checked)}
            className="w-4 h-4 rounded border-neutral-600 bg-neutral-700 text-blue-500 focus:ring-2 focus:ring-blue-500 focus:ring-offset-0"
          />
          <span className="text-xs text-neutral-400">Show</span>
        </label>
      </div>

      {expanded && islandCount > 0 && (
        <div className="text-xs text-neutral-400">
          {islandCount} island{islandCount !== 1 ? 's' : ''} detected
        </div>
      )}

      {expanded && (
        <>

      <div className="space-y-1">
        <label className="text-xs text-neutral-400 flex justify-between">
          <span>Brush Size</span>
          <div className="flex items-center gap-1">
            <input
              ref={brushInputRef}
              type="text"
              defaultValue={brushRadiusMm.toFixed(1)}
              onFocus={() => {
                isEditingBrushRef.current = true;
              }}
              onBlur={(e) => {
                isEditingBrushRef.current = false;
                const val = e.target.value.trim();
                if (val === '') {
                  // Empty field - reset to current value
                  e.target.value = brushRadiusMm.toFixed(1);
                } else {
                  const num = parseFloat(val);
                  if (!isNaN(num) && num >= 0.1 && num <= 10.0) {
                    onBrushRadiusChange(num);
                  } else {
                    // Invalid - reset to current value
                    e.target.value = brushRadiusMm.toFixed(1);
                  }
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur();
                }
              }}
              className="w-16 px-1 py-0.5 text-xs bg-neutral-700 border border-neutral-600 rounded text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500 text-right"
            />
            <span className="text-neutral-300 text-xs">mm</span>
          </div>
        </label>
        <input
          type="range"
          min="0.1"
          max="5.0"
          step="0.1"
          value={brushRadiusMm}
          onChange={(e) => {
            if (!isEditingBrushRef.current) {
              onBrushRadiusChange(parseFloat(e.target.value));
            }
          }}
          className="w-full h-2 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
        />
      </div>

      <div className="space-y-1">
        <label className="text-xs text-neutral-400">Color</label>
        <div className="flex gap-2 items-center">
          <input
            type="color"
            value={color}
            onChange={(e) => {
              const newColor = e.target.value;
              setEditingColor(newColor);
              onColorChange(newColor);
            }}
            className="w-10 h-8 rounded border border-neutral-600 bg-neutral-700 cursor-pointer"
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
                setEditingColor(color); // Reset to valid color
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur();
              }
            }}
            className="flex-1 px-2 py-1 text-xs bg-neutral-700 border border-neutral-600 rounded text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="#ff0000"
          />
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-xs text-neutral-400 flex justify-between">
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
          className="w-full h-2 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
        />
      </div>

      <div className="space-y-1">
        <label className="text-xs text-neutral-400 flex justify-between">
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
          className="w-full h-2 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
        />
      </div>
      </>
      )}
    </div>
  );
}
