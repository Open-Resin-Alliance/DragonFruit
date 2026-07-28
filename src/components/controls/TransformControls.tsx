import React, { useState } from 'react';
import * as THREE from 'three';
import { NumberInput } from '@/components/ui/NumberInput';
import { Card, CardHeader, IconButton } from '@/components/atoms';
import {
  SNAP_DIAL_CONFIG_STORAGE_KEY,
  DEFAULT_SNAP_DIAL_CONFIG,
  parseSnapDialConfig,
  type SnapDialConfig,
} from '@/components/gizmo/rotate/snapRotation';
import { useFloatingPanelCollapse } from '@/components/layout/FloatingPanelStack';

interface SectionHeaderProps {
  title: string;
  accentColor?: string;
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="py-0.5 text-center text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-strong)' }}>
      {title}
    </div>
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
  uniformScaling: boolean;
  onUniformScalingChange: (value: boolean) => void;
  
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
  uniformScaling,
  onUniformScalingChange,
  modelBBox,
  autoLift,
  onAutoLiftChange,
  liftDistance,
  onLiftDistanceChange,
  onLift,
  onDrop,
  onTransformCommit,
}: TransformControlsProps) {
  const [expanded, setExpanded] = useFloatingPanelCollapse(true);
  const [tickConfig, setTickConfig] = useState<SnapDialConfig>(() => {
    try {
      return parseSnapDialConfig(localStorage.getItem(SNAP_DIAL_CONFIG_STORAGE_KEY));
    } catch {
      return DEFAULT_SNAP_DIAL_CONFIG;
    }
  });
  // Bumped on every commit to re-seed the uncontrolled interval inputs, so a
  // rejected or out-of-range entry snaps back to the committed value.
  const [tickConfigEpoch, setTickConfigEpoch] = useState(0);

  // Commit a tier interval, on blur or Enter rather than per keystroke. Doing it
  // per keystroke both drove the dial off half-typed values (typing toward 10
  // transiently built 360 ticks at minorDeg=1) and made multi-digit non-divisors
  // like 17 untypeable, since each rejected keystroke reverted the controlled
  // input. A key on tickConfig re-seeds the uncontrolled inputs after a commit.
  const handleTickIntervalCommit = (tier: keyof SnapDialConfig, raw: string) => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) { setTickConfigEpoch((n) => n + 1); return; }
    const next = { ...tickConfig, [tier]: parsed };
    // Reject anything the dial could not render or snap against rather than
    // persisting it and letting every ring throw. parseSnapDialConfig is the
    // same gate the gizmo reads through, so a value that survives here is
    // safe there.
    const usable = parseSnapDialConfig(JSON.stringify(next));
    if (
      usable.ringShortDeg !== next.ringShortDeg ||
      usable.ringLongDeg !== next.ringLongDeg ||
      usable.spokeDeg !== next.spokeDeg
    ) { setTickConfigEpoch((n) => n + 1); return; }
    setTickConfig(next);
    setTickConfigEpoch((n) => n + 1);
    try { localStorage.setItem(SNAP_DIAL_CONFIG_STORAGE_KEY, JSON.stringify(next)); } catch {}
    window.dispatchEvent(new CustomEvent('dragonfruit:tick-config-change'));
  };

  const compactButtonClass = 'ui-button ui-button-secondary !h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]';
  const valueInputClass = 'ui-input h-8 w-full px-1.5 text-xs sm:text-sm text-left tabular-nums no-spinners';

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

  const liftCardStyle: React.CSSProperties = {
    borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 76%)',
    background: 'color-mix(in srgb, #f59e0b, var(--surface-1) 93%)',
  };

  const outlinedConfigEmphasisStyle: React.CSSProperties = {
    borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 36%)',
    background: 'transparent',
    color: 'var(--text-strong)',
  };

  // Conversion helpers
  const toDegrees = (rad: number) => (rad * 180) / Math.PI;
  const toRadians = (deg: number) => (deg * Math.PI) / 180;
  const wrapRotationDegrees = (deg: number) => {
    if (!Number.isFinite(deg)) return 0;
    const wrapped = ((((deg + 180) % 360) + 360) % 360) - 180;
    return Object.is(wrapped, -0) ? 0 : wrapped;
  };

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
    const radians = toRadians(wrapRotationDegrees(value));
    const newRot = rotation.clone();
    newRot[axis] = radians;
    onRotationChange(newRot.x, newRot.y, newRot.z);
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
            <SectionHeader title="Move" />
              <div className="pt-1.5 space-y-2">
                <div className="grid grid-cols-3 gap-1 min-w-0">
                  <div className="min-w-0">
                    <label className="ui-meta mb-1 block text-center" style={{ color: '#f87171' }}>X</label>
                    <div className="relative">
                      <NumberInput
                        value={parseFloat(position.x.toFixed(2))}
                        onChange={(val) => handlePositionChange('x', val)}
                        onBlur={() => onTransformCommit?.()}
                        className={valueInputClass}
                        showStepper={false}
                      />
                      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>mm</span>
                    </div>
                  </div>
                  <div className="min-w-0">
                    <label className="ui-meta mb-1 block text-center" style={{ color: '#4ade80' }}>Y</label>
                    <div className="relative">
                      <NumberInput
                        value={parseFloat(position.y.toFixed(2))}
                        onChange={(val) => handlePositionChange('y', val)}
                        onBlur={() => onTransformCommit?.()}
                        className={valueInputClass}
                        showStepper={false}
                      />
                      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>mm</span>
                    </div>
                  </div>
                  <div className="min-w-0">
                    <label className="ui-meta mb-1 block text-center" style={{ color: '#60a5fa' }}>Z</label>
                    <div className="relative">
                      <NumberInput
                        value={parseFloat(position.z.toFixed(2))}
                        onChange={(val) => handlePositionChange('z', val)}
                        onBlur={() => onTransformCommit?.()}
                        className={valueInputClass}
                        showStepper={false}
                      />
                      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>mm</span>
                    </div>
                  </div>
                </div>

              </div>
          </div>

          {/* LIFT SECTION */}
          <div className="rounded-md border p-2" style={liftCardStyle}>
            <div className="flex items-center">
              <div className="flex-1" />
              <SectionHeader title="Lift" />
              <div className="flex-1 flex justify-end">
                <button
                  type="button"
                  onClick={() => onAutoLiftChange(!autoLift)}
                  className="h-7 min-w-[64px] rounded-md border px-2 text-[10px] font-semibold uppercase tracking-wide transition-colors"
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
                  Auto
                </button>
              </div>
            </div>
            <div className="pt-1.5 space-y-2">
              <div className="relative">
                <NumberInput
                  value={liftDistance}
                  onChange={(val) => onLiftDistanceChange(val)}
                  onBlur={() => onTransformCommit?.()}
                  className="ui-input h-8 w-full px-2 text-xs sm:text-sm text-center no-spinners"
                  showStepper={false}
                />
                <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>mm</span>
              </div>

              <div className="grid grid-cols-2 gap-1">
                <button
                  onClick={() => {
                    onLift();
                    onTransformCommit?.();
                  }}
                  disabled={!modelBBox}
                  className="ui-button ui-button-secondary !h-8 px-1.5 text-[10px] sm:text-[11px] disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{
                    borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 38%)',
                    color: 'color-mix(in srgb, var(--accent), var(--text-strong) 30%)',
                    background: 'color-mix(in srgb, var(--accent), var(--surface-1) 90%)',
                  }}
                >
                  Lift
                </button>
                <button
                  onClick={() => {
                    onDrop();
                    onTransformCommit?.();
                  }}
                  disabled={!modelBBox}
                  className="ui-button ui-button-secondary !h-8 px-1.5 text-[10px] sm:text-[11px] disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{
                    borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 42%)',
                    color: 'color-mix(in srgb, var(--accent-secondary), var(--text-strong) 30%)',
                    background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 92%)',
                  }}
                >
                  Drop
                </button>
              </div>
            </div>
          </div>

          {/* ROTATE SECTION */}
          <div className="rounded-md border p-2" style={rotateCardStyle}>
            <div className="flex items-center">
              <div className="flex-1" />
              <SectionHeader title="Rotate" />
              <div className="flex-1" />
            </div>
            <div className="pt-1.5 space-y-2">
              {/* Dial intervals (#104). There is no snap toggle any more:
                  snapping is chosen by where the cursor sits during a drag —
                  over the tick ring it snaps by Short, over the inner spokes
                  by Spoke, elsewhere rotation is free. */}
              <div className="grid grid-cols-3 gap-1 min-w-0">
                {([
                  ['ringShortDeg', 'Short'],
                  ['ringLongDeg', 'Long'],
                  ['spokeDeg', 'Spoke'],
                ] as const).map(([key, label]) => (
                  <label key={key} className="min-w-0 flex flex-col gap-0.5">
                    <span className="text-[9px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                      {label}
                    </span>
                    <input
                      key={`${key}-${tickConfigEpoch}`}
                      type="number"
                      min={0}
                      max={180}
                      step={1}
                      defaultValue={tickConfig[key]}
                      onBlur={(e) => handleTickIntervalCommit(key, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      }}
                      title={key === 'ringShortDeg'
                        ? 'Short tick spacing and the fine snap step, in degrees. Must divide 360.'
                        : key === 'spokeDeg'
                          ? 'Inner spoke spacing and the coarse snap step, in degrees. 0 disables the band.'
                          : 'Long tick spacing, in degrees. 0 hides the long tier.'}
                      className={valueInputClass}
                    />
                  </label>
                ))}
              </div>
                <div className="grid grid-cols-3 gap-1 min-w-0">
                  <div className="min-w-0">
                    <label className="ui-meta mb-1 block text-center" style={{ color: '#f87171' }}>X</label>
                    <div className="relative">
                      <NumberInput
                        value={parseFloat(wrapRotationDegrees(toDegrees(rotation.x)).toFixed(2))}
                        onChange={(val) => handleRotationChange('x', val)}
                        onBlur={() => {
                          onRotationComplete?.();
                          onTransformCommit?.();
                        }}
                        className={valueInputClass}
                        showStepper={false}
                      />
                      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[14px] font-semibold" style={{ color: 'var(--text-muted)' }}>°</span>
                    </div>
                  </div>
                  <div className="min-w-0">
                    <label className="ui-meta mb-1 block text-center" style={{ color: '#4ade80' }}>Y</label>
                    <div className="relative">
                      <NumberInput
                        value={parseFloat(wrapRotationDegrees(toDegrees(rotation.y)).toFixed(2))}
                        onChange={(val) => handleRotationChange('y', val)}
                        onBlur={() => {
                          onRotationComplete?.();
                          onTransformCommit?.();
                        }}
                        className={valueInputClass}
                        showStepper={false}
                      />
                      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[14px] font-semibold" style={{ color: 'var(--text-muted)' }}>°</span>
                    </div>
                  </div>
                  <div className="min-w-0">
                    <label className="ui-meta mb-1 block text-center" style={{ color: '#60a5fa' }}>Z</label>
                    <div className="relative">
                      <NumberInput
                        value={parseFloat(wrapRotationDegrees(toDegrees(rotation.z)).toFixed(2))}
                        onChange={(val) => handleRotationChange('z', val)}
                        onBlur={() => {
                          onRotationComplete?.();
                          onTransformCommit?.();
                        }}
                        className={valueInputClass}
                        showStepper={false}
                      />
                      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[14px] font-semibold" style={{ color: 'var(--text-muted)' }}>°</span>
                    </div>
                  </div>
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
          </div>

          {/* SCALE SECTION */}
          <div className="rounded-md border p-2" style={scaleCardStyle}>
            <div className="flex items-center justify-between">
              <div className="flex-1" />
              <SectionHeader title="Scale" />
              <div className="flex-1 flex justify-end">
                <button
                type="button"
                onClick={() => onUniformScalingChange(!uniformScaling)}
                className="h-7 min-w-[64px] rounded-md border px-2 text-[10px] font-semibold uppercase tracking-wide transition-colors"
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
                Uniform
              </button>
            </div>
            </div>
            <div className="pt-1.5 space-y-1.5">
                {/* Percentage row */}
                <div className="grid grid-cols-3 gap-1 min-w-0 items-start">
                  <div className="min-w-0">
                    <label className="ui-meta mb-1 block text-center text-[10px]" style={{ color: '#f87171' }}>X</label>
                    <div className="relative">
                      <NumberInput
                        value={parseFloat((scale.x * 100).toFixed(2))}
                        onChange={(val) => {
                          const newScale = val / 100;
                          if (uniformScaling) onScaleChange(newScale, newScale, newScale);
                          else onScaleChange(newScale, scale.y, scale.z);
                        }}
                        onBlur={() => onTransformCommit?.()}
                        className={valueInputClass}
                        showStepper={false}
                      />
                      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>%</span>
                    </div>
                  </div>
                  <div className="min-w-0">
                    <label className="ui-meta mb-1 block text-center text-[10px]" style={{ color: '#4ade80' }}>Y</label>
                    <div className="relative">
                      <NumberInput
                        value={parseFloat((scale.y * 100).toFixed(2))}
                        onChange={(val) => {
                          const newScale = val / 100;
                          if (uniformScaling) onScaleChange(newScale, newScale, newScale);
                          else onScaleChange(scale.x, newScale, scale.z);
                        }}
                        onBlur={() => onTransformCommit?.()}
                        className={valueInputClass}
                        showStepper={false}
                      />
                      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>%</span>
                    </div>
                  </div>
                  <div className="min-w-0">
                    <label className="ui-meta mb-1 block text-center text-[10px]" style={{ color: '#60a5fa' }}>Z</label>
                    <div className="relative">
                      <NumberInput
                        value={parseFloat((scale.z * 100).toFixed(2))}
                        onChange={(val) => {
                          const newScale = val / 100;
                          if (uniformScaling) onScaleChange(newScale, newScale, newScale);
                          else onScaleChange(scale.x, scale.y, newScale);
                        }}
                        onBlur={() => onTransformCommit?.()}
                        className={valueInputClass}
                        showStepper={false}
                      />
                      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>%</span>
                    </div>
                  </div>
                </div>
                {/* Millimeters row */}
                <div className="grid grid-cols-3 gap-1 min-w-0 items-start">
                  <div className="min-w-0">
                    <div className="relative">
                      <NumberInput
                        value={originalSize ? parseFloat((scale.x * originalSize.x).toFixed(2)) : 0}
                        onChange={(val) => {
                          if (!originalSize) return;
                          const newScale = val / originalSize.x;
                          if (uniformScaling) onScaleChange(newScale, newScale, newScale);
                          else onScaleChange(newScale, scale.y, scale.z);
                        }}
                        onBlur={() => onTransformCommit?.()}
                        className={valueInputClass}
                        showStepper={false}
                      />
                      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>mm</span>
                    </div>
                  </div>
                  <div className="min-w-0">
                    <div className="relative">
                      <NumberInput
                        value={originalSize ? parseFloat((scale.y * originalSize.y).toFixed(2)) : 0}
                        onChange={(val) => {
                          if (!originalSize) return;
                          const newScale = val / originalSize.y;
                          if (uniformScaling) onScaleChange(newScale, newScale, newScale);
                          else onScaleChange(scale.x, newScale, scale.z);
                        }}
                        onBlur={() => onTransformCommit?.()}
                        className={valueInputClass}
                        showStepper={false}
                      />
                      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>mm</span>
                    </div>
                  </div>
                  <div className="min-w-0">
                    <div className="relative">
                      <NumberInput
                        value={originalSize ? parseFloat((scale.z * originalSize.z).toFixed(2)) : 0}
                        onChange={(val) => {
                          if (!originalSize) return;
                          const newScale = val / originalSize.z;
                          if (uniformScaling) onScaleChange(newScale, newScale, newScale);
                          else onScaleChange(scale.x, scale.y, newScale);
                        }}
                        onBlur={() => onTransformCommit?.()}
                        className={valueInputClass}
                        showStepper={false}
                      />
                      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>mm</span>
                    </div>
                  </div>
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
          </div>
        </div>
      ) : null}
    </Card>
  );
}

