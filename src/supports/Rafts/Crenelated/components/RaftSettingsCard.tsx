import React, { useState, useRef, useEffect } from 'react';
import { RaftSettings } from '../RaftTypes';

type RaftSettingsCardProps = {
  settings: RaftSettings;
  onSettingsChange: (settings: RaftSettings) => void;
};

/**
 * Control card for Raft settings.
 * Allows adjusting thickness, chamfer, wall properties, and crenulation.
 */
export function RaftSettingsCard({
  settings,
  onSettingsChange
}: RaftSettingsCardProps) {
  const [expanded, setExpanded] = useState(settings.enabled);
  
  // Uncontrolled input refs and edit flags to allow free typing
  const thicknessRef = useRef<HTMLInputElement>(null);
  const isEditingThicknessRef = useRef(false);
  const chamferRef = useRef<HTMLInputElement>(null);
  const isEditingChamferRef = useRef(false);
  const wallHeightRef = useRef<HTMLInputElement>(null);
  const isEditingWallHeightRef = useRef(false);
  const wallThicknessRef = useRef<HTMLInputElement>(null);
  const isEditingWallThicknessRef = useRef(false);
  const borderMarginRef = useRef<HTMLInputElement>(null);
  const isEditingBorderMarginRef = useRef(false);
  
  // Helper to update a single setting
  const updateSetting = <K extends keyof RaftSettings>(key: K, value: RaftSettings[K]) => {
    onSettingsChange({
      ...settings,
      [key]: value
    });
  };

  // Sync input displayed values when props change and not actively editing
  useEffect(() => {
    if (thicknessRef.current && !isEditingThicknessRef.current) {
      thicknessRef.current.value = settings.thickness.toFixed(2);
    }
    if (chamferRef.current && !isEditingChamferRef.current) {
      chamferRef.current.value = String(Math.round(settings.chamferAngle));
    }
    if (wallHeightRef.current && !isEditingWallHeightRef.current) {
      wallHeightRef.current.value = settings.wallHeight.toFixed(2);
    }
    if (wallThicknessRef.current && !isEditingWallThicknessRef.current) {
      wallThicknessRef.current.value = settings.wallThickness.toFixed(2);
    }
    if (borderMarginRef.current && !isEditingBorderMarginRef.current) {
      borderMarginRef.current.value = settings.footprintBorderMargin.toFixed(2);
    }
  }, [settings]);

  return (
    <div className="bg-neutral-800 rounded-lg p-4 space-y-3">
      {/* Header */}
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
          <h3 className="text-sm font-semibold text-neutral-200">Raft Settings</h3>
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) => updateSetting('enabled', e.target.checked)}
            className="w-4 h-4 rounded border-neutral-600 bg-neutral-700 text-blue-500 focus:ring-2 focus:ring-blue-500 focus:ring-offset-0"
          />
          <span className="text-xs text-neutral-400">Enabled</span>
        </label>
      </div>

      {expanded && (
        <div className="space-y-4 mt-2">
          
          {/* Raft Thickness */}
          <div className="space-y-1">
            <label className="text-xs text-neutral-400 flex justify-between">
              <span>Raft Thickness</span>
              <div className="flex items-center gap-1">
                <input
                  ref={thicknessRef}
                  type="text"
                  defaultValue={settings.thickness.toFixed(2)}
                  onFocus={() => { isEditingThicknessRef.current = true; }}
                  onBlur={(e) => {
                    isEditingThicknessRef.current = false;
                    const val = e.target.value.trim();
                    if (val === '') { e.target.value = settings.thickness.toFixed(2); return; }
                    const num = parseFloat(val);
                    if (!isNaN(num) && num >= 0.1 && num <= 2.0) {
                      updateSetting('thickness', Number(num.toFixed(2)) as any);
                    } else {
                      e.target.value = settings.thickness.toFixed(2);
                    }
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                  className="w-16 px-1 py-0.5 text-xs bg-neutral-700 border border-neutral-600 rounded text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500 text-right"
                />
                <span className="text-neutral-300 text-xs">mm</span>
              </div>
            </label>
            <input
              type="range"
              min="0.1"
              max="2.0"
              step="0.05"
              value={settings.thickness}
              onChange={(e) => { if (!isEditingThicknessRef.current) updateSetting('thickness', parseFloat(e.target.value)); }}
              className="w-full h-2 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
            />
          </div>

          {/* Edge Chamfer Angle */}
          <div className="space-y-1">
            <label className="text-xs text-neutral-400 flex justify-between">
              <span>Edge Chamfer Angle</span>
              <div className="flex items-center gap-1">
                <input
                  ref={chamferRef}
                  type="text"
                  defaultValue={String(Math.round(settings.chamferAngle))}
                  onFocus={() => { isEditingChamferRef.current = true; }}
                  onBlur={(e) => {
                    isEditingChamferRef.current = false;
                    const val = e.target.value.trim();
                    if (val === '') { e.target.value = String(Math.round(settings.chamferAngle)); return; }
                    const num = parseFloat(val);
                    if (!isNaN(num) && num >= 45 && num <= 90) {
                      updateSetting('chamferAngle', Math.round(num) as any);
                    } else {
                      e.target.value = String(Math.round(settings.chamferAngle));
                    }
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                  className="w-16 px-1 py-0.5 text-xs bg-neutral-700 border border-neutral-600 rounded text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500 text-right"
                />
                <span className="text-neutral-300 text-xs">°</span>
              </div>
            </label>
            <input
              type="range"
              min="45"
              max="90"
              step="1"
              value={settings.chamferAngle}
              onChange={(e) => { if (!isEditingChamferRef.current) updateSetting('chamferAngle', parseFloat(e.target.value)); }}
              className="w-full h-2 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
            />
          </div>

          {/* Wall Height */}
          <div className="space-y-1">
            <label className="text-xs text-neutral-400 flex justify-between">
              <span>Wall Height</span>
              <div className="flex items-center gap-1">
                <input
                  ref={wallHeightRef}
                  type="text"
                  defaultValue={settings.wallHeight.toFixed(2)}
                  onFocus={() => { isEditingWallHeightRef.current = true; }}
                  onBlur={(e) => {
                    isEditingWallHeightRef.current = false;
                    const val = e.target.value.trim();
                    if (val === '') { e.target.value = settings.wallHeight.toFixed(2); return; }
                    const num = parseFloat(val);
                    if (!isNaN(num) && num >= 0.1 && num <= 1.0) {
                      updateSetting('wallHeight', Number(num.toFixed(2)) as any);
                    } else {
                      e.target.value = settings.wallHeight.toFixed(2);
                    }
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                  className="w-16 px-1 py-0.5 text-xs bg-neutral-700 border border-neutral-600 rounded text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500 text-right"
                />
                <span className="text-neutral-300 text-xs">mm</span>
              </div>
            </label>
            <input
              type="range"
              min="0.1"
              max="1.0"
              step="0.05"
              value={settings.wallHeight}
              onChange={(e) => { if (!isEditingWallHeightRef.current) updateSetting('wallHeight', parseFloat(e.target.value)); }}
              className="w-full h-2 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
            />
          </div>

          {/* Wall Thickness */}
          <div className="space-y-1">
            <label className="text-xs text-neutral-400 flex justify-between">
              <span>Wall Thickness</span>
              <div className="flex items-center gap-1">
                <input
                  ref={wallThicknessRef}
                  type="text"
                  defaultValue={settings.wallThickness.toFixed(2)}
                  onFocus={() => { isEditingWallThicknessRef.current = true; }}
                  onBlur={(e) => {
                    isEditingWallThicknessRef.current = false;
                    const val = e.target.value.trim();
                    if (val === '') { e.target.value = settings.wallThickness.toFixed(2); return; }
                    const num = parseFloat(val);
                    if (!isNaN(num) && num >= 0.2 && num <= 2.0) {
                      updateSetting('wallThickness', Number(num.toFixed(2)) as any);
                    } else {
                      e.target.value = settings.wallThickness.toFixed(2);
                    }
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                  className="w-16 px-1 py-0.5 text-xs bg-neutral-700 border border-neutral-600 rounded text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500 text-right"
                />
                <span className="text-neutral-300 text-xs">mm</span>
              </div>
            </label>
            <input
              type="range"
              min="0.2"
              max="2.0"
              step="0.05"
              value={settings.wallThickness}
              onChange={(e) => { if (!isEditingWallThicknessRef.current) updateSetting('wallThickness', parseFloat(e.target.value)); }}
              className="w-full h-2 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
            />
          </div>

          {/* Footprint Border Toggle */}
          <div className="pt-2 border-t border-neutral-700 space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.showFootprintBorder}
                onChange={(e) => updateSetting('showFootprintBorder', e.target.checked)}
                className="w-4 h-4 rounded border-neutral-600 bg-neutral-700 text-blue-500 focus:ring-2 focus:ring-blue-500 focus:ring-offset-0"
              />
              <span className="text-xs text-neutral-400">Show Footprint Border</span>
            </label>
            
            {settings.showFootprintBorder && (
              <div className="space-y-1 ml-6">
                <label className="text-xs text-neutral-400 flex justify-between">
                  <span>Border Margin</span>
                  <div className="flex items-center gap-1">
                    <input
                      ref={borderMarginRef}
                      type="text"
                      defaultValue={settings.footprintBorderMargin.toFixed(2)}
                      onFocus={() => { isEditingBorderMarginRef.current = true; }}
                      onBlur={(e) => {
                        isEditingBorderMarginRef.current = false;
                        const val = e.target.value.trim();
                        if (val === '') { e.target.value = settings.footprintBorderMargin.toFixed(2); return; }
                        const num = parseFloat(val);
                        if (!isNaN(num) && num >= 0.0 && num <= 0.05) {
                          updateSetting('footprintBorderMargin', Number(num.toFixed(2)) as any);
                        } else {
                          e.target.value = settings.footprintBorderMargin.toFixed(2);
                        }
                      }}
                      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                      className="w-16 px-1 py-0.5 text-xs bg-neutral-700 border border-neutral-600 rounded text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500 text-right"
                    />
                    <span className="text-neutral-300 text-xs">mm</span>
                  </div>
                </label>
                <input
                  type="range"
                  min="0"
                  max="0.05"
                  step="0.01"
                  value={settings.footprintBorderMargin}
                  onChange={(e) => { if (!isEditingBorderMarginRef.current) updateSetting('footprintBorderMargin', parseFloat(e.target.value)); }}
                  className="w-full h-2 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                />
              </div>
            )}
          </div>

        </div>
      )}
    </div>
  );
}
