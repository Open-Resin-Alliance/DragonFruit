import React, { useState, useEffect } from 'react';
import * as THREE from 'three';

interface ScaleControlsProps {
  scale: THREE.Vector3;
  onScaleChange: (x: number, y: number, z: number) => void;
  onReset: () => void;
  modelBBox: THREE.Box3 | null;
}

export function ScaleControls({
  scale,
  onScaleChange,
  onReset,
  modelBBox,
}: ScaleControlsProps) {
  const [uniformScaling, setUniformScaling] = useState(true);
  const [unit, setUnit] = useState<'mm' | '%'>('%');

  // Calculate original dimensions from bbox
  const originalSize = modelBBox
    ? new THREE.Vector3(
        modelBBox.max.x - modelBBox.min.x,
        modelBBox.max.y - modelBBox.min.y,
        modelBBox.max.z - modelBBox.min.z
      )
    : new THREE.Vector3(1, 1, 1);

  const handleScaleChange = (axis: 'x' | 'y' | 'z', value: string) => {
    const num = parseFloat(value) || 1;
    let newScale: number;

    if (unit === '%') {
      newScale = num / 100;
    } else {
      // mm: calculate scale factor from original size
      newScale = num / originalSize[axis];
    }

    if (uniformScaling) {
      onScaleChange(newScale, newScale, newScale);
    } else {
      const updated = scale.clone();
      updated[axis] = newScale;
      onScaleChange(updated.x, updated.y, updated.z);
    }
  };

  const getDisplayValue = (axis: 'x' | 'y' | 'z'): string => {
    if (unit === '%') {
      return (scale[axis] * 100).toFixed(2);
    } else {
      return (scale[axis] * originalSize[axis]).toFixed(2);
    }
  };

  return (
    <div className="absolute left-24 top-20 z-10 bg-neutral-800/95 backdrop-blur-sm rounded-lg p-4 shadow-xl w-80">
      <h3 className="text-sm font-semibold text-neutral-200 mb-3">Scale</h3>

      {/* Scale Factor Inputs */}
      <div className="flex gap-2 mb-2">
        <div className="flex-1">
          <label className="text-[10px] text-red-400 font-medium mb-1 block">X</label>
          <input
            type="number"
            step={unit === '%' ? '1' : '0.1'}
            value={getDisplayValue('x')}
            onChange={(e) => handleScaleChange('x', e.target.value)}
            className="w-full px-2 py-1 text-sm bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-red-500 focus:outline-none"
          />
        </div>
        <div className="flex-1">
          <label className="text-[10px] text-green-400 font-medium mb-1 block">Y</label>
          <input
            type="number"
            step={unit === '%' ? '1' : '0.1'}
            value={getDisplayValue('y')}
            onChange={(e) => handleScaleChange('y', e.target.value)}
            disabled={uniformScaling}
            className="w-full px-2 py-1 text-sm bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-green-500 focus:outline-none disabled:opacity-50"
          />
        </div>
        <div className="flex-1">
          <label className="text-[10px] text-blue-400 font-medium mb-1 block">Z</label>
          <input
            type="number"
            step={unit === '%' ? '1' : '0.1'}
            value={getDisplayValue('z')}
            onChange={(e) => handleScaleChange('z', e.target.value)}
            disabled={uniformScaling}
            className="w-full px-2 py-1 text-sm bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none disabled:opacity-50"
          />
        </div>
        <div className="flex items-end">
          <button
            onClick={() => setUnit(unit === 'mm' ? '%' : 'mm')}
            className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded transition-colors mb-0.5"
          >
            {unit}
          </button>
        </div>
      </div>

      {/* Uniform Scaling Toggle */}
      <div className="flex items-center justify-between mb-4 pb-3 border-b border-neutral-700">
        <span className="text-xs text-neutral-400">Uniform Scaling</span>
        <div className="flex gap-1">
          <button
            onClick={() => setUniformScaling(true)}
            className={`px-3 py-1 text-xs rounded transition-colors ${
              uniformScaling
                ? 'bg-blue-500 text-white'
                : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'
            }`}
          >
            on
          </button>
          <button
            onClick={() => setUniformScaling(false)}
            className={`px-3 py-1 text-xs rounded transition-colors ${
              !uniformScaling
                ? 'bg-neutral-600 text-white'
                : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'
            }`}
          >
            off
          </button>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="grid grid-cols-1 gap-2">
        <button
          onClick={onReset}
          className="px-3 py-2 text-xs bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded transition-colors"
        >
          Reset Scale
        </button>
      </div>
    </div>
  );
}
