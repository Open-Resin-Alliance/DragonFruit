import React, { useState } from 'react';
import * as THREE from 'three';

interface MoveControlsProps {
  position: THREE.Vector3;
  onPositionChange: (x: number, y: number, z: number) => void;
  onCenter: () => void;
  onPlatform: (bbox: THREE.Box3) => void;
  modelBBox: THREE.Box3 | null;
  autoLift: boolean;
  onAutoLiftChange: (enabled: boolean) => void;
  liftDistance: number;
  onLiftDistanceChange: (distance: number) => void;
  onLift: () => void; // Snap to lift height
  onDrop: () => void; // Snap to build plate
}

export function MoveControls({
  position,
  onPositionChange,
  onCenter,
  onPlatform,
  modelBBox,
  autoLift,
  onAutoLiftChange,
  liftDistance,
  onLiftDistanceChange,
  onLift,
  onDrop,
}: MoveControlsProps) {

  const handleAxisChange = (axis: 'x' | 'y' | 'z', value: string) => {
    const num = parseFloat(value) || 0;
    const newPos = position.clone();
    newPos[axis] = num;
    onPositionChange(newPos.x, newPos.y, newPos.z);
  };

  const handleArrangeAll = () => {
    onCenter();
    if (modelBBox) {
      onPlatform(modelBBox);
    }
  };

  return (
    <div className="absolute left-24 top-20 z-10 bg-neutral-800/95 backdrop-blur-sm rounded-lg p-4 shadow-xl w-80">
      <h3 className="text-sm font-semibold text-neutral-200 mb-3">Move</h3>

      {/* XYZ Position Inputs */}
      <div className="flex gap-2 mb-3">
        <div className="flex-1">
          <label className="text-[10px] text-red-400 font-medium mb-1 block">X</label>
          <input
            type="number"
            step="0.1"
            value={position.x.toFixed(2)}
            onChange={(e) => handleAxisChange('x', e.target.value)}
            className="w-full px-2 py-1 text-sm bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-red-500 focus:outline-none"
          />
        </div>
        <div className="flex-1">
          <label className="text-[10px] text-green-400 font-medium mb-1 block">Y</label>
          <input
            type="number"
            step="0.1"
            value={position.y.toFixed(2)}
            onChange={(e) => handleAxisChange('y', e.target.value)}
            className="w-full px-2 py-1 text-sm bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-green-500 focus:outline-none"
          />
        </div>
        <div className="flex-1">
          <label className="text-[10px] text-blue-400 font-medium mb-1 block">Z</label>
          <input
            type="number"
            step="0.1"
            value={position.z.toFixed(2)}
            onChange={(e) => handleAxisChange('z', e.target.value)}
            className="w-full px-2 py-1 text-sm bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div className="flex items-end">
          <span className="text-xs text-neutral-400 pb-1">mm</span>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        <button
          onClick={onCenter}
          className="px-3 py-2 text-xs bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded transition-colors"
        >
          Center
        </button>
        <button
          onClick={() => modelBBox && onPlatform(modelBBox)}
          disabled={!modelBBox}
          className="px-3 py-2 text-xs bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          On Platform
        </button>
      </div>

      <div className="grid grid-cols-1 gap-2 mb-4">
        <button
          onClick={handleArrangeAll}
          disabled={!modelBBox}
          className="px-3 py-2 text-xs bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Arrange All
        </button>
      </div>

      {/* Lift Object Section */}
      <div className="border-t border-neutral-700 pt-3">
        <h4 className="text-xs font-semibold text-neutral-300 mb-2">Lift Object</h4>
        
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-neutral-400">Auto lift on import</span>
          <div className="flex gap-1">
            <button
              onClick={() => onAutoLiftChange(true)}
              className={`px-3 py-1 text-xs rounded transition-colors ${
                autoLift
                  ? 'bg-blue-500 text-white'
                  : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'
              }`}
            >
              on
            </button>
            <button
              onClick={() => onAutoLiftChange(false)}
              className={`px-3 py-1 text-xs rounded transition-colors ${
                !autoLift
                  ? 'bg-neutral-600 text-white'
                  : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'
              }`}
            >
              off
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-neutral-400">Distance</span>
          <input
            type="number"
            step="1"
            value={liftDistance}
            onChange={(e) => onLiftDistanceChange(parseFloat(e.target.value) || 0)}
            className="flex-1 px-2 py-1 text-sm bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none"
          />
          <span className="text-xs text-neutral-400">mm</span>
        </div>

        {/* Lift and Drop Buttons */}
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={onLift}
            disabled={!modelBBox}
            className="px-3 py-2 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Snap model to lift height"
          >
            Lift
          </button>
          <button
            onClick={onDrop}
            disabled={!modelBBox}
            className="px-3 py-2 text-xs bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Snap model to build plate"
          >
            Drop
          </button>
        </div>
      </div>
    </div>
  );
}
