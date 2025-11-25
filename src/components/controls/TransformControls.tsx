import React, { useState } from 'react';
import * as THREE from 'three';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface TransformControlsProps {
  // Position
  position: THREE.Vector3;
  onPositionChange: (x: number, y: number, z: number) => void;
  onCenter: () => void;
  onPlatform: (bbox: THREE.Box3) => void;
  
  // Rotation
  rotation: THREE.Euler;
  onRotationChange: (x: number, y: number, z: number) => void;
  onResetRotation: () => void;
  onRotationComplete?: () => void;
  
  // Scale
  scale: THREE.Vector3;
  onScaleChange: (x: number, y: number, z: number) => void;
  onResetScale: () => void;
  
  // Shared
  modelBBox: THREE.Box3 | null;
  
  // Auto-lift
  autoLift: boolean;
  onAutoLiftChange: (enabled: boolean) => void;
  liftDistance: number;
  onLiftDistanceChange: (distance: number) => void;
  onLift: () => void;
  onDrop: () => void;
}

export function TransformControls({
  position,
  onPositionChange,
  onCenter,
  onPlatform,
  rotation,
  onRotationChange,
  onResetRotation,
  onRotationComplete,
  scale,
  onScaleChange,
  onResetScale,
  modelBBox,
  autoLift,
  onAutoLiftChange,
  liftDistance,
  onLiftDistanceChange,
  onLift,
  onDrop,
}: TransformControlsProps) {
  const [moveExpanded, setMoveExpanded] = useState(true);
  const [rotateExpanded, setRotateExpanded] = useState(true);
  const [scaleExpanded, setScaleExpanded] = useState(true);
  const [uniformScaling, setUniformScaling] = useState(true);
  const [scaleUnit, setScaleUnit] = useState<'mm' | '%'>('%');

  // Conversion helpers
  const toDegrees = (rad: number) => (rad * 180) / Math.PI;
  const toRadians = (deg: number) => (deg * Math.PI) / 180;

  // Calculate original dimensions from bbox
  const originalSize = modelBBox
    ? new THREE.Vector3(
        modelBBox.max.x - modelBBox.min.x,
        modelBBox.max.y - modelBBox.min.y,
        modelBBox.max.z - modelBBox.min.z
      )
    : new THREE.Vector3(1, 1, 1);

  // Position handlers
  const handlePositionChange = (axis: 'x' | 'y' | 'z', value: string) => {
    const num = parseFloat(value) || 0;
    const newPos = position.clone();
    newPos[axis] = num;
    onPositionChange(newPos.x, newPos.y, newPos.z);
  };

  // Rotation handlers
  const handleRotationChange = (axis: 'x' | 'y' | 'z', value: string) => {
    const degrees = parseFloat(value) || 0;
    const radians = toRadians(degrees);
    const newRot = rotation.clone();
    newRot[axis] = radians;
    onRotationChange(newRot.x, newRot.y, newRot.z);
    onRotationComplete?.();
  };

  // Scale handlers
  const handleScaleChange = (axis: 'x' | 'y' | 'z', value: string) => {
    const num = parseFloat(value) || 1;
    let newScale: number;

    if (scaleUnit === '%') {
      newScale = num / 100;
    } else {
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

  const getScaleDisplayValue = (axis: 'x' | 'y' | 'z'): string => {
    if (scaleUnit === '%') {
      return (scale[axis] * 100).toFixed(2);
    } else {
      return (scale[axis] * originalSize[axis]).toFixed(2);
    }
  };

  const handleArrangeAll = () => {
    onCenter();
    if (modelBBox) {
      onPlatform(modelBBox);
    }
  };

  // Section header component
  const SectionHeader = ({ 
    title, 
    expanded, 
    onToggle 
  }: { 
    title: string; 
    expanded: boolean; 
    onToggle: () => void;
  }) => (
    <button
      onClick={onToggle}
      className="w-full flex items-center justify-between py-2 text-sm font-semibold text-neutral-200 hover:text-white transition-colors"
    >
      <span>{title}</span>
      {expanded ? (
        <ChevronDown className="w-4 h-4 text-neutral-400" />
      ) : (
        <ChevronRight className="w-4 h-4 text-neutral-400" />
      )}
    </button>
  );

  return (
    <div className="absolute left-24 top-20 z-10 bg-neutral-800/95 backdrop-blur-sm rounded-lg p-4 shadow-xl w-80 max-h-[calc(100vh-120px)] overflow-y-auto">
      <h3 className="text-sm font-semibold text-neutral-200 mb-2 pb-2 border-b border-neutral-700">Transform</h3>

      {/* MOVE SECTION */}
      <div className="border-b border-neutral-700">
        <SectionHeader title="Move" expanded={moveExpanded} onToggle={() => setMoveExpanded(!moveExpanded)} />
        {moveExpanded && (
          <div className="pb-3">
            {/* XYZ Position Inputs */}
            <div className="flex gap-2 mb-3">
              <div className="flex-1">
                <label className="text-[10px] text-red-400 font-medium mb-1 block">X</label>
                <input
                  type="number"
                  step="0.1"
                  value={position.x.toFixed(2)}
                  onChange={(e) => handlePositionChange('x', e.target.value)}
                  className="w-full px-2 py-1 text-sm bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-red-500 focus:outline-none no-spinners"
                />
              </div>
              <div className="flex-1">
                <label className="text-[10px] text-green-400 font-medium mb-1 block">Y</label>
                <input
                  type="number"
                  step="0.1"
                  value={position.y.toFixed(2)}
                  onChange={(e) => handlePositionChange('y', e.target.value)}
                  className="w-full px-2 py-1 text-sm bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-green-500 focus:outline-none no-spinners"
                />
              </div>
              <div className="flex-1">
                <label className="text-[10px] text-blue-400 font-medium mb-1 block">Z</label>
                <input
                  type="number"
                  step="0.1"
                  value={position.z.toFixed(2)}
                  onChange={(e) => handlePositionChange('z', e.target.value)}
                  className="w-full px-2 py-1 text-sm bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                />
              </div>
              <div className="flex items-end">
                <span className="text-xs text-neutral-400 pb-1">mm</span>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="grid grid-cols-3 gap-2 mb-3">
              <button
                onClick={onCenter}
                className="px-2 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded transition-colors"
              >
                Center
              </button>
              <button
                onClick={() => modelBBox && onPlatform(modelBBox)}
                disabled={!modelBBox}
                className="px-2 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Platform
              </button>
              <button
                onClick={handleArrangeAll}
                disabled={!modelBBox}
                className="px-2 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Arrange
              </button>
            </div>

            {/* Lift Object Section */}
            <div className="bg-neutral-750 rounded p-2">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-neutral-400">Auto lift</span>
                <div className="flex gap-1">
                  <button
                    onClick={() => onAutoLiftChange(true)}
                    className={`px-2 py-0.5 text-xs rounded transition-colors ${
                      autoLift
                        ? 'bg-blue-500 text-white'
                        : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'
                    }`}
                  >
                    on
                  </button>
                  <button
                    onClick={() => onAutoLiftChange(false)}
                    className={`px-2 py-0.5 text-xs rounded transition-colors ${
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
                  className="flex-1 px-2 py-1 text-sm bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                />
                <span className="text-xs text-neutral-400">mm</span>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={onLift}
                  disabled={!modelBBox}
                  className="px-2 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Lift
                </button>
                <button
                  onClick={onDrop}
                  disabled={!modelBBox}
                  className="px-2 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Drop
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ROTATE SECTION */}
      <div className="border-b border-neutral-700">
        <SectionHeader title="Rotate" expanded={rotateExpanded} onToggle={() => setRotateExpanded(!rotateExpanded)} />
        {rotateExpanded && (
          <div className="pb-3">
            {/* XYZ Rotation Inputs */}
            <div className="flex gap-2 mb-3">
              <div className="flex-1">
                <label className="text-[10px] text-red-400 font-medium mb-1 block">X</label>
                <input
                  type="number"
                  step="1"
                  value={toDegrees(rotation.x).toFixed(2)}
                  onChange={(e) => handleRotationChange('x', e.target.value)}
                  className="w-full px-2 py-1 text-sm bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-red-500 focus:outline-none no-spinners"
                />
              </div>
              <div className="flex-1">
                <label className="text-[10px] text-green-400 font-medium mb-1 block">Y</label>
                <input
                  type="number"
                  step="1"
                  value={toDegrees(rotation.y).toFixed(2)}
                  onChange={(e) => handleRotationChange('y', e.target.value)}
                  className="w-full px-2 py-1 text-sm bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-green-500 focus:outline-none no-spinners"
                />
              </div>
              <div className="flex-1">
                <label className="text-[10px] text-blue-400 font-medium mb-1 block">Z</label>
                <input
                  type="number"
                  step="1"
                  value={toDegrees(rotation.z).toFixed(2)}
                  onChange={(e) => handleRotationChange('z', e.target.value)}
                  className="w-full px-2 py-1 text-sm bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                />
              </div>
              <div className="flex items-end">
                <span className="text-xs text-neutral-400 pb-1">°</span>
              </div>
            </div>

            <button
              onClick={onResetRotation}
              className="w-full px-2 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded transition-colors"
            >
              Reset Rotation
            </button>
          </div>
        )}
      </div>

      {/* SCALE SECTION */}
      <div>
        <SectionHeader title="Scale" expanded={scaleExpanded} onToggle={() => setScaleExpanded(!scaleExpanded)} />
        {scaleExpanded && (
          <div className="pb-1">
            {/* Scale Factor Inputs */}
            <div className="flex gap-2 mb-2">
              <div className="flex-1">
                <label className="text-[10px] text-red-400 font-medium mb-1 block">X</label>
                <input
                  type="number"
                  step={scaleUnit === '%' ? '1' : '0.1'}
                  value={getScaleDisplayValue('x')}
                  onChange={(e) => handleScaleChange('x', e.target.value)}
                  className="w-full px-2 py-1 text-sm bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-red-500 focus:outline-none no-spinners"
                />
              </div>
              <div className="flex-1">
                <label className="text-[10px] text-green-400 font-medium mb-1 block">Y</label>
                <input
                  type="number"
                  step={scaleUnit === '%' ? '1' : '0.1'}
                  value={getScaleDisplayValue('y')}
                  onChange={(e) => handleScaleChange('y', e.target.value)}
                  disabled={uniformScaling}
                  className="w-full px-2 py-1 text-sm bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-green-500 focus:outline-none disabled:opacity-50 no-spinners"
                />
              </div>
              <div className="flex-1">
                <label className="text-[10px] text-blue-400 font-medium mb-1 block">Z</label>
                <input
                  type="number"
                  step={scaleUnit === '%' ? '1' : '0.1'}
                  value={getScaleDisplayValue('z')}
                  onChange={(e) => handleScaleChange('z', e.target.value)}
                  disabled={uniformScaling}
                  className="w-full px-2 py-1 text-sm bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none disabled:opacity-50 no-spinners"
                />
              </div>
              <div className="flex items-end">
                <button
                  onClick={() => setScaleUnit(scaleUnit === 'mm' ? '%' : 'mm')}
                  className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded transition-colors mb-0.5"
                >
                  {scaleUnit}
                </button>
              </div>
            </div>

            {/* Uniform Scaling Toggle */}
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs text-neutral-400">Uniform</span>
              <div className="flex gap-1">
                <button
                  onClick={() => setUniformScaling(true)}
                  className={`px-2 py-0.5 text-xs rounded transition-colors ${
                    uniformScaling
                      ? 'bg-blue-500 text-white'
                      : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'
                  }`}
                >
                  on
                </button>
                <button
                  onClick={() => setUniformScaling(false)}
                  className={`px-2 py-0.5 text-xs rounded transition-colors ${
                    !uniformScaling
                      ? 'bg-neutral-600 text-white'
                      : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'
                  }`}
                >
                  off
                </button>
              </div>
            </div>

            <button
              onClick={onResetScale}
              className="w-full px-2 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded transition-colors"
            >
              Reset Scale
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
