import React, { useState } from 'react';
import * as THREE from 'three';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { NumberInput } from '@/components/ui/NumberInput';
import { Card, CardHeader, IconButton } from '@/components/ui/primitives';

interface SectionHeaderProps {
  title: string;
  expanded: boolean;
  onToggle: () => void;
}

function SectionHeader({ title, expanded, onToggle }: SectionHeaderProps) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center justify-between py-1 text-sm font-semibold transition-colors"
      style={{ color: 'var(--text-strong)' }}
    >
      <span>{title}</span>
      {expanded ? (
        <ChevronDown className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
      ) : (
        <ChevronRight className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
      )}
    </button>
  );
}

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
  const [expanded, setExpanded] = useState(true);
  const [moveExpanded, setMoveExpanded] = useState(true);
  const [rotateExpanded, setRotateExpanded] = useState(true);
  const [scaleExpanded, setScaleExpanded] = useState(true);
  const [uniformScaling, setUniformScaling] = useState(true);
  const [scaleUnit, setScaleUnit] = useState<'mm' | '%'>('%');

  const compactButtonClass = 'ui-button ui-button-secondary px-2.5 py-2 text-sm min-h-10';

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

  return (
    <Card
      className="w-full overflow-x-hidden shadow-xl"
    >
      <CardHeader
        left={(
          <>
            <IconButton
              onClick={() => setExpanded(!expanded)}
              title={expanded ? 'Collapse card' : 'Expand card'}
              className="!p-0.5"
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
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              Transform
            </h3>
          </>
        )}
        hideDivider={!expanded}
      />

      {expanded ? (
        <div className="px-2.5 pt-1 pb-2.5 max-h-[calc(100vh-180px)] overflow-y-auto space-y-2">
      
      {/* MOVE SECTION */}
      <div
        className="rounded-md border p-2.5"
        style={{
          background: 'color-mix(in srgb, #4f8cff, var(--surface-1) 91%)',
          borderColor: 'color-mix(in srgb, #4f8cff, var(--border-subtle) 62%)',
        }}
      >
        <SectionHeader title="Move" expanded={moveExpanded} onToggle={() => setMoveExpanded(!moveExpanded)} />
        {moveExpanded && (
          <div className="pt-1.5 space-y-2">
            {/* XYZ Position Inputs */}
            <div className="flex gap-1.5">
              <div className="flex-1">
                <label className="ui-label mb-1 block" style={{ color: '#f87171' }}>X</label>
                <NumberInput
                  value={parseFloat(position.x.toFixed(2))}
                  onChange={(val) => handlePositionChange('x', val)}
                  className="ui-input w-full px-2 py-1.5 text-sm no-spinners"
                />
              </div>
              <div className="flex-1">
                <label className="ui-label mb-1 block" style={{ color: '#4ade80' }}>Y</label>
                <NumberInput
                  value={parseFloat(position.y.toFixed(2))}
                  onChange={(val) => handlePositionChange('y', val)}
                  className="ui-input w-full px-2 py-1.5 text-sm no-spinners"
                />
              </div>
              <div className="flex-1">
                <label className="ui-label mb-1 block" style={{ color: '#60a5fa' }}>Z</label>
                <NumberInput
                  value={parseFloat(position.z.toFixed(2))}
                  onChange={(val) => handlePositionChange('z', val)}
                  className="ui-input w-full px-2 py-1.5 text-sm no-spinners"
                />
              </div>
            </div>

            {/* Action Buttons */}
            <div className="grid grid-cols-3 gap-1.5">
              <button
                onClick={onCenter}
                className={compactButtonClass}
              >
                Center
              </button>
              <button
                onClick={() => modelBBox && onPlatform(modelBBox)}
                disabled={!modelBBox}
                className={`${compactButtonClass} disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                Platform
              </button>
              <button
                onClick={handleArrangeAll}
                disabled={!modelBBox}
                className={`${compactButtonClass} disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                Arrange
              </button>
            </div>

            {/* Lift Object Section */}
            <div className="rounded-md border p-2.5 space-y-2" style={{ background: 'var(--surface-0)', borderColor: 'var(--border-subtle)' }}>
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Auto lift</span>
                <div className="flex gap-1">
                  <button
                    onClick={() => onAutoLiftChange(true)}
                    className={`ui-button px-2.5 py-1.5 text-sm min-h-9 ${
                      autoLift
                        ? 'ui-button-primary'
                        : 'ui-button-secondary'
                    }`}
                  >
                    on
                  </button>
                  <button
                    onClick={() => onAutoLiftChange(false)}
                    className={`ui-button px-2.5 py-1.5 text-sm min-h-9 ${
                      !autoLift
                        ? 'ui-button-primary'
                        : 'ui-button-secondary'
                    }`}
                  >
                    off
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-[auto_1fr] items-center gap-2">
                <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Distance (mm)</span>
                <NumberInput
                  value={liftDistance}
                  onChange={(val) => onLiftDistanceChange(val)}
                  className="ui-input w-full px-2 py-1.5 text-sm no-spinners"
                />
              </div>

              <div className="grid grid-cols-2 gap-1.5">
                <button
                  onClick={onLift}
                  disabled={!modelBBox}
                  className="ui-button ui-button-primary px-2.5 py-2 text-sm min-h-10 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Lift
                </button>
                <button
                  onClick={onDrop}
                  disabled={!modelBBox}
                  className="ui-button ui-button-secondary px-2.5 py-2 text-sm min-h-10 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Drop
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ROTATE SECTION */}
      <div
        className="rounded-md border p-2.5"
        style={{
          background: 'color-mix(in srgb, #8f6cff, var(--surface-1) 91%)',
          borderColor: 'color-mix(in srgb, #8f6cff, var(--border-subtle) 62%)',
        }}
      >
        <SectionHeader title="Rotate" expanded={rotateExpanded} onToggle={() => setRotateExpanded(!rotateExpanded)} />
        {rotateExpanded && (
          <div className="pt-1.5 space-y-2">
            {/* XYZ Rotation Inputs */}
            <div className="flex gap-1.5">
              <div className="flex-1">
                <label className="ui-label mb-1 block" style={{ color: '#f87171' }}>X</label>
                <NumberInput
                  value={parseFloat(toDegrees(rotation.x).toFixed(2))}
                  onChange={(val) => handleRotationChange('x', val)}
                  className="ui-input w-full px-2 py-1.5 text-sm no-spinners"
                />
              </div>
              <div className="flex-1">
                <label className="ui-label mb-1 block" style={{ color: '#4ade80' }}>Y</label>
                <NumberInput
                  value={parseFloat(toDegrees(rotation.y).toFixed(2))}
                  onChange={(val) => handleRotationChange('y', val)}
                  className="ui-input w-full px-2 py-1.5 text-sm no-spinners"
                />
              </div>
              <div className="flex-1">
                <label className="ui-label mb-1 block" style={{ color: '#60a5fa' }}>Z</label>
                <NumberInput
                  value={parseFloat(toDegrees(rotation.z).toFixed(2))}
                  onChange={(val) => handleRotationChange('z', val)}
                  className="ui-input w-full px-2 py-1.5 text-sm no-spinners"
                />
              </div>
            </div>

            <button
              onClick={onResetRotation}
              className="ui-button ui-button-secondary w-full px-2.5 py-2 text-sm min-h-10"
            >
              Reset Rotation
            </button>
          </div>
        )}
      </div>

      {/* SCALE SECTION */}
      <div
        className="rounded-md border p-2.5"
        style={{
          background: 'color-mix(in srgb, #2eb67d, var(--surface-1) 91%)',
          borderColor: 'color-mix(in srgb, #2eb67d, var(--border-subtle) 62%)',
        }}
      >
        <SectionHeader title="Scale" expanded={scaleExpanded} onToggle={() => setScaleExpanded(!scaleExpanded)} />
        {scaleExpanded && (
          <div className="pt-1.5 space-y-2">
            {/* Scale Factor Inputs */}
            <div className="flex gap-1.5">
              <div className="flex-1">
                <label className="ui-label mb-1 block" style={{ color: '#f87171' }}>X</label>
                <NumberInput
                  value={parseFloat(getScaleDisplayValue('x').toFixed(2))}
                  onChange={(val) => handleScaleChange('x', val)}
                  className="ui-input w-full px-2 py-1.5 text-sm no-spinners"
                />
              </div>
              <div className="flex-1">
                <label className="ui-label mb-1 block" style={{ color: '#4ade80' }}>Y</label>
                <NumberInput
                  value={parseFloat(getScaleDisplayValue('y').toFixed(2))}
                  onChange={(val) => handleScaleChange('y', val)}
                  disabled={uniformScaling}
                  className="ui-input w-full px-2 py-1.5 text-sm disabled:opacity-50 no-spinners"
                />
              </div>
              <div className="flex-1">
                <label className="ui-label mb-1 block" style={{ color: '#60a5fa' }}>Z</label>
                <NumberInput
                  value={parseFloat(getScaleDisplayValue('z').toFixed(2))}
                  onChange={(val) => handleScaleChange('z', val)}
                  disabled={uniformScaling}
                  className="ui-input w-full px-2 py-1.5 text-sm disabled:opacity-50 no-spinners"
                />
              </div>
              <div className="flex items-end">
                <button
                  onClick={() => setScaleUnit(scaleUnit === 'mm' ? '%' : 'mm')}
                  className="ui-button ui-button-secondary px-2.5 py-1.5 text-sm min-h-10 mb-0"
                >
                  {scaleUnit}
                </button>
              </div>
            </div>

            {/* Uniform Scaling Toggle */}
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Uniform</span>
              <div className="flex gap-1">
                <button
                  onClick={() => setUniformScaling(true)}
                  className={`ui-button px-2.5 py-1.5 text-sm min-h-9 ${
                    uniformScaling
                      ? 'ui-button-primary'
                      : 'ui-button-secondary'
                  }`}
                >
                  on
                </button>
                <button
                  onClick={() => setUniformScaling(false)}
                  className={`ui-button px-2.5 py-1.5 text-sm min-h-9 ${
                    !uniformScaling
                      ? 'ui-button-primary'
                      : 'ui-button-secondary'
                  }`}
                >
                  off
                </button>
              </div>
            </div>

            <button
              onClick={onResetScale}
              className="ui-button ui-button-secondary w-full px-2.5 py-2 text-sm min-h-10"
            >
              Reset Scale
            </button>
          </div>
        )}
      </div>
      </div>
      ) : null}
    </Card>
  );
}

