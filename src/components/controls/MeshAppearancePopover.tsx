"use client";

import React, { useState, useRef, useEffect } from 'react';

interface MeshAppearancePopoverProps {
  meshColor: string;
  onMeshColorChange: (color: string) => void;
  ambientIntensity: number;
  onAmbientIntensityChange: (value: number) => void;
  directionalIntensity: number;
  onDirectionalIntensityChange: (value: number) => void;
  materialRoughness: number;
  onMaterialRoughnessChange: (value: number) => void;
}

export function MeshAppearancePopover({
  meshColor,
  onMeshColorChange,
  ambientIntensity,
  onAmbientIntensityChange,
  directionalIntensity,
  onDirectionalIntensityChange,
  materialRoughness,
  onMaterialRoughnessChange
}: MeshAppearancePopoverProps) {
  const [showPopover, setShowPopover] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  
  // Close popover when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setShowPopover(false);
      }
    };
    
    if (showPopover) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showPopover]);
  
  return (
    <div className="relative flex items-center gap-2" ref={popoverRef}>
      <label className="text-sm text-neutral-300 whitespace-nowrap">
        Appearance:
      </label>
      <button
        onClick={() => setShowPopover(!showPopover)}
        className="flex items-center gap-2 px-3 py-1.5 rounded border border-neutral-700 bg-neutral-800 hover:bg-neutral-700 transition-colors"
      >
        <div 
          className="w-5 h-5 rounded border border-neutral-600"
          style={{ backgroundColor: meshColor }}
        />
        <span className="text-xs text-neutral-400 font-mono">
          {meshColor.toUpperCase()}
        </span>
      </button>
      
      {/* Popover */}
      {showPopover && (
        <div className="absolute top-full mt-2 left-0 w-80 bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl p-4 space-y-4 z-50">
          {/* Mesh Color */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-neutral-300">Mesh Color</label>
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={meshColor}
                onChange={(e) => onMeshColorChange(e.target.value)}
                className="h-10 w-10 cursor-pointer rounded border border-neutral-700 bg-neutral-800"
              />
              <input
                type="text"
                value={meshColor}
                onChange={(e) => onMeshColorChange(e.target.value)}
                className="flex-1 rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-sm text-neutral-100"
                placeholder="#a3a3a3"
              />
            </div>
          </div>

          {/* Ambient Light */}
          <div className="space-y-1">
            <label className="text-xs text-neutral-400 flex justify-between">
              <span>Ambient Light</span>
              <span className="text-neutral-300">{ambientIntensity.toFixed(1)}</span>
            </label>
            <input
              type="range"
              min="0.0"
              max="3.0"
              step="0.1"
              value={ambientIntensity}
              onChange={(e) => onAmbientIntensityChange(parseFloat(e.target.value))}
              className="w-full h-2 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
            />
          </div>

          {/* Directional Light */}
          <div className="space-y-1">
            <label className="text-xs text-neutral-400 flex justify-between">
              <span>Directional Light</span>
              <span className="text-neutral-300">{directionalIntensity.toFixed(1)}</span>
            </label>
            <input
              type="range"
              min="0.0"
              max="1.0"
              step="0.05"
              value={directionalIntensity}
              onChange={(e) => onDirectionalIntensityChange(parseFloat(e.target.value))}
              className="w-full h-2 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
            />
          </div>

          {/* Material Roughness */}
          <div className="space-y-1">
            <label className="text-xs text-neutral-400 flex justify-between">
              <span>Surface Roughness</span>
              <span className="text-neutral-300">{materialRoughness.toFixed(2)}</span>
            </label>
            <input
              type="range"
              min="0.0"
              max="1.0"
              step="0.05"
              value={materialRoughness}
              onChange={(e) => onMaterialRoughnessChange(parseFloat(e.target.value))}
              className="w-full h-2 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
            />
          </div>

          {/* Preset Buttons */}
          <div className="space-y-2 pt-2 border-t border-neutral-800">
            <label className="text-xs font-medium text-neutral-300">Presets</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  onAmbientIntensityChange(1.2);
                  onDirectionalIntensityChange(0.3);
                  onMaterialRoughnessChange(1.0);
                }}
                className="rounded border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs text-neutral-100 hover:bg-neutral-700"
              >
                Default (Flat)
              </button>
              <button
                type="button"
                onClick={() => {
                  onAmbientIntensityChange(0.5);
                  onDirectionalIntensityChange(0.8);
                  onMaterialRoughnessChange(0.6);
                }}
                className="rounded border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs text-neutral-100 hover:bg-neutral-700"
              >
                Realistic
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
