import React from 'react';
import * as THREE from 'three';

interface RotateControlsProps {
  rotation: THREE.Euler;
  onRotationChange: (x: number, y: number, z: number) => void;
  onReset: () => void;
}

export function RotateControls({
  rotation,
  onRotationChange,
  onReset,
}: RotateControlsProps) {
  const toDegrees = (rad: number) => (rad * 180) / Math.PI;
  const toRadians = (deg: number) => (deg * Math.PI) / 180;

  const handleAxisChange = (axis: 'x' | 'y' | 'z', value: string) => {
    const degrees = parseFloat(value) || 0;
    const radians = toRadians(degrees);
    const newRot = rotation.clone();
    newRot[axis] = radians;
    onRotationChange(newRot.x, newRot.y, newRot.z);
  };

  return (
    <div className="absolute left-24 top-20 z-10 bg-neutral-800/95 backdrop-blur-sm rounded-lg p-4 shadow-xl w-80">
      <h3 className="text-sm font-semibold text-neutral-200 mb-3">Rotate</h3>

      {/* XYZ Rotation Inputs */}
      <div className="flex gap-2 mb-4">
        <div className="flex-1">
          <label className="text-[10px] text-red-400 font-medium mb-1 block">X</label>
          <input
            type="number"
            step="1"
            value={toDegrees(rotation.x).toFixed(2)}
            onChange={(e) => handleAxisChange('x', e.target.value)}
            className="w-full px-2 py-1 text-sm bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-red-500 focus:outline-none"
          />
        </div>
        <div className="flex-1">
          <label className="text-[10px] text-green-400 font-medium mb-1 block">Y</label>
          <input
            type="number"
            step="1"
            value={toDegrees(rotation.y).toFixed(2)}
            onChange={(e) => handleAxisChange('y', e.target.value)}
            className="w-full px-2 py-1 text-sm bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-green-500 focus:outline-none"
          />
        </div>
        <div className="flex-1">
          <label className="text-[10px] text-blue-400 font-medium mb-1 block">Z</label>
          <input
            type="number"
            step="1"
            value={toDegrees(rotation.z).toFixed(2)}
            onChange={(e) => handleAxisChange('z', e.target.value)}
            className="w-full px-2 py-1 text-sm bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div className="flex items-end">
          <span className="text-xs text-neutral-400 pb-1">°</span>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="grid grid-cols-1 gap-2">
        <button
          onClick={onReset}
          className="px-3 py-2 text-xs bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded transition-colors"
        >
          Reset Rotation
        </button>
      </div>
    </div>
  );
}
