import React, { useState } from 'react';
import * as THREE from 'three';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { NumberInput } from '@/components/ui/NumberInput';
import { Card, CardHeader, IconButton } from '@/components/ui/primitives';
import { SNAP_STORAGE_KEY } from '@/components/gizmo/rotate/snapRotation';

interface SectionHeaderProps {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  accentColor?: string;
}

function SectionHeader({ title, expanded, onToggle, accentColor }: SectionHeaderProps) {
  return (
    <button
      onClick={onToggle}
      className="flex w-full items-center justify-between py-0.5 text-xs font-semibold uppercase tracking-wide transition-colors"
      style={{ color: 'var(--text-strong)' }}
    >
      <span className="inline-flex items-center gap-1.5">
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: accentColor ?? 'var(--accent)' }}
        />
        {title}
      </span>
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
  onTransformCommit?: () => void;
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
  onTransformCommit,
}: TransformControlsProps) {
  const [expanded, setExpanded] = useState(true);
  const [moveExpanded, setMoveExpanded] = useState(true);
  const [rotateExpanded, setRotateExpanded] = useState(true);
  const [scaleExpanded, setScaleExpanded] = useState(true);
  const [uniformScaling, setUniformScaling] = useState(true);
  const [scaleUnit, setScaleUnit] = useState<'mm' | '%'>('%');
  const [snapEnabled, setSnapEnabled] = useState(() => {
    try { return localStorage.getItem(SNAP_STORAGE_KEY) === 'true'; } catch { return false; }
  });

  const handleSnapToggle = () => {
    const next = !snapEnabled;
    setSnapEnabled(next);
    try { localStorage.setItem(SNAP_STORAGE_KEY, String(next)); } catch {}
    window.dispatchEvent(new CustomEvent('dragonfruit:snap-toggle', { detail: { enabled: next } }));
  };

  const compactButtonClass = 'ui-button ui-button-secondary !h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]';
  const valueInputClass = 'ui-input h-8 w-full px-1.5 text-xs sm:text-sm text-center tabular-nums no-spinners';

  const sectionCardStyle: React.CSSProperties = {
    borderColor: 'var(--border-subtle)',
    background: 'var(--surface-1)',
  };

  const moveCardStyle: React.CSSProperties = {
    borderColor: 'color-mix(in srgb, #4f8cff, var(--border-subtle) 78%)',
    background: 'color-mix(in srgb, #4f8cff, var(--surface-1) 94%)',
  };

  const rotateCardStyle: React.CSSProperties = {
    borderColor: 'color-mix(in srgb, #8f6cff, var(--border-subtle) 80%)',
    background: 'color-mix(in srgb, #8f6cff, var(--surface-1) 95%)',
  };

  const scaleCardStyle: React.CSSProperties = {
    borderColor: 'color-mix(in srgb, #2eb67d, var(--border-subtle) 80%)',
    background: 'color-mix(in srgb, #2eb67d, var(--surface-1) 95%)',
  };

  const outlinedConfigEmphasisStyle: React.CSSProperties = {
    borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 36%)',
    background: 'transparent',
    color: 'var(--text-strong)',
  };

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
        <div className="px-2 pb-2 space-y-2 sm:px-2.5 sm:pb-2.5 max-h-[calc(100vh-180px)] overflow-y-auto custom-scrollbar">

          {/* MOVE SECTION */}
          <div className="rounded-md border p-2" style={moveCardStyle}>
            <SectionHeader title="Move" expanded={moveExpanded} onToggle={() => setMoveExpanded(!moveExpanded)} accentColor="#4f8cff" />
            {moveExpanded && (
              <div className="pt-1.5 space-y-2">
                <div className="grid grid-cols-3 gap-1 min-w-0">
                  <div className="min-w-0">
                    <label className="ui-meta mb-1 block text-center" style={{ color: '#f87171' }}>X</label>
                    <NumberInput
                      value={parseFloat(position.x.toFixed(2))}
                      onChange={(val) => handlePositionChange('x', val)}
                      onBlur={() => onTransformCommit?.()}
                      className={valueInputClass}
                    />
                  </div>
                  <div className="min-w-0">
                    <label className="ui-meta mb-1 block text-center" style={{ color: '#4ade80' }}>Y</label>
                    <NumberInput
                      value={parseFloat(position.y.toFixed(2))}
                      onChange={(val) => handlePositionChange('y', val)}
                      onBlur={() => onTransformCommit?.()}
                      className={valueInputClass}
                    />
                  </div>
                  <div className="min-w-0">
                    <label className="ui-meta mb-1 block text-center" style={{ color: '#60a5fa' }}>Z</label>
                    <NumberInput
                      value={parseFloat(position.z.toFixed(2))}
                      onChange={(val) => handlePositionChange('z', val)}
                      onBlur={() => onTransformCommit?.()}
                      className={valueInputClass}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-1 min-w-0">
                  <button
                    onClick={() => {
                      onCenter();
                      onTransformCommit?.();
                    }}
                    className={compactButtonClass}
                  >
                    Center
                  </button>
                  <button
                    onClick={() => {
                      if (!modelBBox) return;
                      onPlatform(modelBBox);
                      onTransformCommit?.();
                    }}
                    disabled={!modelBBox}
                    className={`ui-button ui-button-accent !h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px] disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    Platform
                  </button>
                  <button
                    onClick={handleArrangeAll}
                    disabled={!modelBBox}
                    className={`ui-button ui-button-primary !h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px] disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    Arrange
                  </button>
                </div>

                <div className="rounded-md border p-2 space-y-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="ui-meta" style={{ color: 'var(--text-muted)' }}>Auto-Lift</span>
                    <button
                      type="button"
                      onClick={() => onAutoLiftChange(!autoLift)}
                      className="h-8 min-w-[72px] rounded-md border px-3 text-[11px] font-semibold uppercase tracking-wide transition-colors"
                      style={autoLift
                        ? {
                            borderColor: 'color-mix(in srgb, var(--accent), white 10%)',
                            background: 'color-mix(in srgb, var(--accent), var(--surface-0) 76%)',
                            color: 'var(--accent-contrast)',
                          }
                        : {
                            borderColor: 'var(--border-subtle)',
                            background: 'var(--surface-1)',
                            color: 'var(--text-muted)',
                          }}
                    >
                      {autoLift ? 'ON' : 'OFF'}
                    </button>
                  </div>

                  <div className="grid grid-cols-[auto_1fr] items-center gap-2 min-w-0">
                    <span className="ui-meta" style={{ color: 'var(--text-muted)' }}>Distance (mm)</span>
                    <NumberInput
                      value={liftDistance}
                      onChange={(val) => onLiftDistanceChange(val)}
                      onBlur={() => onTransformCommit?.()}
                      className="ui-input h-8 w-full px-2 text-xs sm:text-sm no-spinners"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-1">
                    <button
                      onClick={() => {
                        onLift();
                        onTransformCommit?.();
                      }}
                      disabled={!modelBBox}
                      className="ui-button ui-button-primary !h-8 px-1.5 text-[10px] sm:text-[11px] disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Lift
                    </button>
                    <button
                      onClick={() => {
                        onDrop();
                        onTransformCommit?.();
                      }}
                      disabled={!modelBBox}
                      className="ui-button ui-button-accent !h-8 px-1.5 text-[10px] sm:text-[11px] disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Drop
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ROTATE SECTION */}
          <div className="rounded-md border p-2" style={rotateCardStyle}>
            <SectionHeader title="Rotate" expanded={rotateExpanded} onToggle={() => setRotateExpanded(!rotateExpanded)} accentColor="#8f6cff" />
            {rotateExpanded && (
              <div className="pt-1.5 space-y-2">
                <div className="grid grid-cols-3 gap-1 min-w-0">
                  <div className="min-w-0">
                    <label className="ui-meta mb-1 block text-center" style={{ color: '#f87171' }}>X</label>
                    <NumberInput
                      value={parseFloat(toDegrees(rotation.x).toFixed(2))}
                      onChange={(val) => handleRotationChange('x', val)}
                      onBlur={() => {
                        onRotationComplete?.();
                        onTransformCommit?.();
                      }}
                      className={valueInputClass}
                    />
                  </div>
                  <div className="min-w-0">
                    <label className="ui-meta mb-1 block text-center" style={{ color: '#4ade80' }}>Y</label>
                    <NumberInput
                      value={parseFloat(toDegrees(rotation.y).toFixed(2))}
                      onChange={(val) => handleRotationChange('y', val)}
                      onBlur={() => {
                        onRotationComplete?.();
                        onTransformCommit?.();
                      }}
                      className={valueInputClass}
                    />
                  </div>
                  <div className="min-w-0">
                    <label className="ui-meta mb-1 block text-center" style={{ color: '#60a5fa' }}>Z</label>
                    <NumberInput
                      value={parseFloat(toDegrees(rotation.z).toFixed(2))}
                      onChange={(val) => handleRotationChange('z', val)}
                      onBlur={() => {
                        onRotationComplete?.();
                        onTransformCommit?.();
                      }}
                      className={valueInputClass}
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between gap-2">
                  <span className="ui-meta" style={{ color: 'var(--text-muted)' }}>Angle-Snap</span>
                  <button
                    type="button"
                    onClick={handleSnapToggle}
                    className="h-8 min-w-[72px] rounded-md border px-3 text-[11px] font-semibold uppercase tracking-wide transition-colors"
                    style={snapEnabled
                      ? {
                          borderColor: 'color-mix(in srgb, var(--accent), white 10%)',
                          background: 'color-mix(in srgb, var(--accent), var(--surface-0) 76%)',
                          color: 'var(--accent-contrast)',
                        }
                      : {
                          borderColor: 'var(--border-subtle)',
                          background: 'var(--surface-1)',
                          color: 'var(--text-muted)',
                        }}
                  >
                    {snapEnabled ? 'ON' : 'OFF'}
                  </button>
                </div>

                <button
                  onClick={() => {
                    onResetRotation();
                    onTransformCommit?.();
                  }}
                  className="ui-button ui-button-secondary w-full !h-8 px-1.5 text-[10px] sm:text-[11px]"
                >
                  Reset Rotation
                </button>
              </div>
            )}
          </div>

          {/* SCALE SECTION */}
          <div className="rounded-md border p-2" style={scaleCardStyle}>
            <SectionHeader title="Scale" expanded={scaleExpanded} onToggle={() => setScaleExpanded(!scaleExpanded)} accentColor="#2eb67d" />
            {scaleExpanded && (
              <div className="pt-1.5 space-y-2">
                <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_44px] gap-1 min-w-0">
                  <div className="min-w-0">
                    <label className="ui-meta mb-1 block text-center" style={{ color: '#f87171' }}>X</label>
                    <NumberInput
                      value={parseFloat(getScaleDisplayValue('x').toFixed(2))}
                      onChange={(val) => handleScaleChange('x', val)}
                      onBlur={() => onTransformCommit?.()}
                      className={valueInputClass}
                    />
                  </div>
                  <div className="min-w-0">
                    <label className="ui-meta mb-1 block text-center" style={{ color: '#4ade80' }}>Y</label>
                    <NumberInput
                      value={parseFloat(getScaleDisplayValue('y').toFixed(2))}
                      onChange={(val) => handleScaleChange('y', val)}
                      disabled={uniformScaling}
                      onBlur={() => onTransformCommit?.()}
                      className={`${valueInputClass} disabled:opacity-50`}
                    />
                  </div>
                  <div className="min-w-0">
                    <label className="ui-meta mb-1 block text-center" style={{ color: '#60a5fa' }}>Z</label>
                    <NumberInput
                      value={parseFloat(getScaleDisplayValue('z').toFixed(2))}
                      onChange={(val) => handleScaleChange('z', val)}
                      disabled={uniformScaling}
                      onBlur={() => onTransformCommit?.()}
                      className={`${valueInputClass} disabled:opacity-50`}
                    />
                  </div>
                  <div className="flex items-end min-w-0">
                    <button
                      onClick={() => setScaleUnit(scaleUnit === 'mm' ? '%' : 'mm')}
                      className="ui-button ui-button-secondary !h-8 w-full !px-0 text-[10px] sm:text-[11px] tracking-normal inline-flex items-center justify-center leading-none"
                      style={outlinedConfigEmphasisStyle}
                    >
                      {scaleUnit === 'mm' ? 'MM' : '%'}
                    </button>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-2">
                  <span className="ui-meta" style={{ color: 'var(--text-muted)' }}>Uniform</span>
                  <button
                    type="button"
                    onClick={() => setUniformScaling(!uniformScaling)}
                    className="h-8 min-w-[72px] rounded-md border px-3 text-[11px] font-semibold uppercase tracking-wide transition-colors"
                    style={uniformScaling
                      ? {
                          borderColor: 'color-mix(in srgb, var(--accent), white 10%)',
                          background: 'color-mix(in srgb, var(--accent), var(--surface-0) 76%)',
                          color: 'var(--accent-contrast)',
                        }
                      : {
                          borderColor: 'var(--border-subtle)',
                          background: 'var(--surface-1)',
                          color: 'var(--text-muted)',
                        }}
                  >
                    {uniformScaling ? 'ON' : 'OFF'}
                  </button>
                </div>

                <button
                  onClick={() => {
                    onResetScale();
                    onTransformCommit?.();
                  }}
                  className="ui-button ui-button-secondary w-full !h-8 px-1.5 text-[10px] sm:text-[11px]"
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

