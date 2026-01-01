import React, { useState } from 'react';
import * as THREE from 'three';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { NumberInput } from '@/components/ui/NumberInput';

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
  const handlePositionChange = (axis: 'x' | 'y' | 'z', value: number) => {
    const newPos = position.clone();
    newPos[axis] = value;
    onPositionChange(newPos.x, newPos.y, newPos.z);
  };

  // Rotation handlers
  const handleRotationChange = (axis: 'x' | 'y' | 'z', value: number) => {
    const radians = toRadians(value);
    const newRot = rotation.clone();
    newRot[axis] = radians;
    onRotationChange(newRot.x, newRot.y, newRot.z);
    onRotationComplete?.();
  };

  // Scale handlers
  const handleScaleChange = (axis: 'x' | 'y' | 'z', value: number) => {
    let newScale: number;

    if (scaleUnit === '%') {
      newScale = value / 100;
    } else {
      newScale = value / originalSize[axis];
    }

    if (uniformScaling) {
      onScaleChange(newScale, newScale, newScale);
    } else {
      const updated = scale.clone();
      updated[axis] = newScale;
      onScaleChange(updated.x, updated.y, updated.z);
    }
  };

  const getScaleDisplayValue = (axis: 'x' | 'y' | 'z'): number => {
    if (scaleUnit === '%') {
      return (scale[axis] * 100);
    } else {
      return (scale[axis] * originalSize[axis]);
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
      className="w-full flex items-center justify-between py-1 text-sm font-semibold text-neutral-200 hover:text-white transition-colors"
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
    <div className="absolute left-72 top-20 z-10 bg-neutral-800/95 backdrop-blur-sm rounded-lg px-3 pb-2 pt-1 shadow-xl w-64 max-h-[calc(100vh-120px)] overflow-y-auto">
      
      {/* MOVE SECTION */}
      <div className="border-b border-neutral-700">
        <SectionHeader title="Move" expanded={moveExpanded} onToggle={() => setMoveExpanded(!moveExpanded)} />
        {moveExpanded && (
          <div className="pb-1">
            {/* XYZ Position Inputs */}
            <div className="flex gap-1.5 mb-1">
              <div className="flex-1">
                <label className="text-[9px] text-red-400 font-medium mb-0.5 block">X</label>
                <NumberInput
                  value={parseFloat(position.x.toFixed(2))}
                  onChange={(val) => handlePositionChange('x', val)}
                  className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-red-500 focus:outline-none no-spinners"
                />
              </div>
              <div className="flex-1">
                <label className="text-[9px] text-green-400 font-medium mb-0.5 block">Y</label>
                <NumberInput
                  value={parseFloat(position.y.toFixed(2))}
                  onChange={(val) => handlePositionChange('y', val)}
                  className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-green-500 focus:outline-none no-spinners"
                />
              </div>
              <div className="flex-1">
                <label className="text-[9px] text-blue-400 font-medium mb-0.5 block">Z</label>
                <NumberInput
                  value={parseFloat(position.z.toFixed(2))}
                  onChange={(val) => handlePositionChange('z', val)}
                  className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                />
              </div>
            </div>

            {/* Action Buttons */}
            <div className="grid grid-cols-3 gap-1.5 mb-1">
              <button
                onClick={onCenter}
                className="px-1.5 py-1 text-[10px] bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded transition-colors"
              >
                Center
              </button>
              <button
                onClick={() => modelBBox && onPlatform(modelBBox)}
                disabled={!modelBBox}
                className="px-1.5 py-1 text-[10px] bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Platform
              </button>
              <button
                onClick={handleArrangeAll}
                disabled={!modelBBox}
                className="px-1.5 py-1 text-[10px] bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Arrange
              </button>
            </div>

            {/* Lift Object Section */}
            <div className="bg-neutral-750 rounded p-1">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-neutral-400">Auto lift</span>
                <div className="flex gap-1">
                  <button
                    onClick={() => onAutoLiftChange(true)}
                    className={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${
                      autoLift
                        ? 'bg-blue-500 text-white'
                        : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'
                    }`}
                  >
                    on
                  </button>
                  <button
                    onClick={() => onAutoLiftChange(false)}
                    className={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${
                      !autoLift
                        ? 'bg-neutral-600 text-white'
                        : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'
                    }`}
                  >
                    off
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-[10px] text-neutral-400">Dist (mm)</span>
                <NumberInput
                  value={liftDistance}
                  onChange={(val) => onLiftDistanceChange(val)}
                  className="flex-1 px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                />
              </div>

              <div className="grid grid-cols-2 gap-1.5">
                <button
                  onClick={onLift}
                  disabled={!modelBBox}
                  className="px-1.5 py-1 text-[10px] bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Lift
                </button>
                <button
                  onClick={onDrop}
                  disabled={!modelBBox}
                  className="px-1.5 py-1 text-[10px] bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
          <div className="pb-1">
            {/* XYZ Rotation Inputs */}
            <div className="flex gap-1.5 mb-1">
              <div className="flex-1">
                <label className="text-[9px] text-red-400 font-medium mb-0.5 block">X</label>
                <NumberInput
                  value={parseFloat(toDegrees(rotation.x).toFixed(2))}
                  onChange={(val) => handleRotationChange('x', val)}
                  className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-red-500 focus:outline-none no-spinners"
                />
              </div>
              <div className="flex-1">
                <label className="text-[9px] text-green-400 font-medium mb-0.5 block">Y</label>
                <NumberInput
                  value={parseFloat(toDegrees(rotation.y).toFixed(2))}
                  onChange={(val) => handleRotationChange('y', val)}
                  className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-green-500 focus:outline-none no-spinners"
                />
              </div>
              <div className="flex-1">
                <label className="text-[9px] text-blue-400 font-medium mb-0.5 block">Z</label>
                <NumberInput
                  value={parseFloat(toDegrees(rotation.z).toFixed(2))}
                  onChange={(val) => handleRotationChange('z', val)}
                  className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none no-spinners"
                />
              </div>
            </div>

            <button
              onClick={onResetRotation}
              className="w-full px-1.5 py-1 text-[10px] bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded transition-colors"
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
            <div className="flex gap-1.5 mb-1">
              <div className="flex-1">
                <label className="text-[9px] text-red-400 font-medium mb-0.5 block">X</label>
                <NumberInput
                  value={parseFloat(getScaleDisplayValue('x').toFixed(2))}
                  onChange={(val) => handleScaleChange('x', val)}
                  className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-red-500 focus:outline-none no-spinners"
                />
              </div>
              <div className="flex-1">
                <label className="text-[9px] text-green-400 font-medium mb-0.5 block">Y</label>
                <NumberInput
                  value={parseFloat(getScaleDisplayValue('y').toFixed(2))}
                  onChange={(val) => handleScaleChange('y', val)}
                  disabled={uniformScaling}
                  className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-green-500 focus:outline-none disabled:opacity-50 no-spinners"
                />
              </div>
              <div className="flex-1">
                <label className="text-[9px] text-blue-400 font-medium mb-0.5 block">Z</label>
                <NumberInput
                  value={parseFloat(getScaleDisplayValue('z').toFixed(2))}
                  onChange={(val) => handleScaleChange('z', val)}
                  disabled={uniformScaling}
                  className="w-full px-1.5 py-0.5 text-xs bg-neutral-700 text-neutral-200 rounded border border-neutral-600 focus:border-blue-500 focus:outline-none disabled:opacity-50 no-spinners"
                />
              </div>
              <div className="flex items-end">
                <button
                  onClick={() => setScaleUnit(scaleUnit === 'mm' ? '%' : 'mm')}
                  className="px-1.5 py-0.5 text-[10px] bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded transition-colors mb-0.5"
                >
                  {scaleUnit}
                </button>
              </div>
            </div>

            {/* Uniform Scaling Toggle */}
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] text-neutral-400">Uniform</span>
              <div className="flex gap-1">
                <button
                  onClick={() => setUniformScaling(true)}
                  className={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${
                    uniformScaling
                      ? 'bg-blue-500 text-white'
                      : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'
                  }`}
                >
                  on
                </button>
                <button
                  onClick={() => setUniformScaling(false)}
                  className={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${
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
              className="w-full px-1.5 py-1 text-[10px] bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded transition-colors"
            >
              Reset Scale
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

