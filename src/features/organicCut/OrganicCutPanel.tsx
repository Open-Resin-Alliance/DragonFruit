import React from 'react';
import { Loader2, ChevronDown, ChevronRight } from 'lucide-react';
import { Card, CardHeader, IconButton } from '@/components/ui/primitives';
import { ScrollableNumberField } from '@/components/ui/scrollableNumberField';
import { NumberInput } from '@/components/ui/NumberInput';
import type { OrganicCutDrawMode, OrganicCutMode, OrganicCutSessionStatus } from './types';

export interface OrganicCutPanelState {
  drawMode: OrganicCutDrawMode;
  /** Flat planar cut vs curved contour ("wafer") cut along the drawn loop. */
  cutMode: OrganicCutMode;
  thicknessMm: number;
  /** Seam-line smoothing 0..1 — how much the cut line rounds through waypoints. */
  smoothing: number;
  /** Membrane smoothing 0..1 — how smooth/taut the curved cutter surface is. */
  membraneSmoothing: number;
  /** Wafer density multiplier (1..4) — cutter poly count, applied only at cut. */
  density: number;
  /**
   * When true (contour mode), the cut also generates a registration key: a peg
   * union'd onto one half and a matching socket carved from the other, so the
   * halves socket together in one alignment. Off by default.
   */
  generateKey: boolean;
  /** Key base width in mm (model units are mm). The length follows a 1.25× ratio. */
  keyWidthMm: number;
  /** Key depth in mm — how far the peg pokes into the body. */
  keyDepthMm: number;
  /** Key shape: 'frustum' (tapered box, rotation-locking) or 'dome' (half-sphere). */
  keyShape: 'frustum' | 'dome';
  /** Edge fillet radius (mm) — rounds the frustum's corners + tip. 0 = sharp. */
  keyFilletMm: number;
  /**
   * Dome only: when true, the Width/Depth sliders are ratio-locked — dragging one
   * scales the other to preserve the current proportions (resize as a unit). When
   * false, each is independent (free oblong control).
   */
  keyUniformScale: boolean;
  /**
   * Flip which cut half gets the peg vs the socket. False (default): peg on the
   * +normal side. True: swap them. Lets the user choose which part keeps the peg.
   */
  keySwapSides: boolean;
  /**
   * Key tilt (radians): how far the key leans off the cut normal. Driven by the
   * in-viewport aim gizmo (drag the key's tip). The base stays glued flat to the
   * cut face; the body shears to lean. 0 = straight out.
   */
  keyTiltRad: number;
  /** Key tilt azimuth (radians): which in-plane direction the lean points toward. */
  keyTiltAzimuthRad: number;
  /** Key roll (radians): spin about the key's own axis. Driven by the roll gizmo. */
  keyRollRad: number;
  sides?: number;
  radius?: number;
  planePosition?: [number, number, number];
  planeRotation?: [number, number, number];
  planeUniformScale?: boolean;
}

function getSidesLabel(sides: number): string {
  switch (sides) {
    case 3: return 'Triangle';
    case 4: return 'Quad';
    case 5: return 'Pentagon';
    case 6: return 'Hexagon';
    case 7: return 'Heptagon';
    case 8: return 'Octagon';
    case 9: return 'Nonagon';
    case 10: return 'Decagon';
    case 11: return 'Hendecagon';
    case 12: return 'Dodecagon';
    case 13: return 'Tridecagon';
    case 14: return 'Tetradecagon';
    case 15: return 'Pentadecagon';
    case 16: return 'Hexadecagon';
    default: return `${sides} sides`;
  }
}

interface SectionHeaderProps {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  accentColor?: string;
}

function SectionHeader({ title, expanded, onToggle, accentColor }: SectionHeaderProps) {
  return (
    <button
      type="button"
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

interface OrganicCutPanelProps {
  state: OrganicCutPanelState;
  onStateChange: (next: OrganicCutPanelState) => void;
  /** Current tool-session lifecycle, drives which actions are enabled. */
  sessionStatus: OrganicCutSessionStatus;
  /** Number of loop points placed so far (shown to the user). */
  pointCount: number;
  onClearLoop: () => void;
  onCloseLoop: () => void;
  onApply: () => void;
  isApplying?: boolean;
  canApply?: boolean;
  canCloseLoop?: boolean;
  disabled?: boolean;
  /**
   * Which key the live preview placed: 'frustum' (the full key), 'dome' (the
   * half-sphere fallback for a thin part), or 'none'. Drives the alert below the
   * toggle so the user knows when the cut fell back.
   */
  keyKind?: 'frustum' | 'dome' | 'none';
  /** Reason the key shrank / fell back / was skipped (shown as an alert). */
  keyDetail?: string;
}

/**
 * Tool panel for Organic Cut. Structurally mirrors HolePunchPanel (collapsible
 * Card, accent sub-cards, ScrollableNumberField, Reset/Apply row) so it sits
 * naturally beside the other Prepare-mode tool panels.
 *
 * M1: thickness/smoothing are wired but the backend ignores them (no-op cut).
 */
export function OrganicCutPanel({
  state,
  onStateChange,
  pointCount,
  onClearLoop,
  onCloseLoop,
  onApply,
  isApplying = false,
  canApply = false,
  canCloseLoop = false,
  disabled = false,
  keyKind = 'none',
  keyDetail = '',
}: OrganicCutPanelProps) {
  const [expanded, setExpanded] = React.useState(true);
  const [moveExpanded, setMoveExpanded] = React.useState(true);
  const [rotateExpanded, setRotateExpanded] = React.useState(true);
  const [scaleExpanded, setScaleExpanded] = React.useState(true);

  const compactButtonClass = 'ui-button ui-button-secondary w-full !h-8 px-1.5 text-[10px] sm:text-[11px]';
  const valueInputClass = 'ui-input h-8 w-full px-1.5 text-xs sm:text-sm text-center tabular-nums no-spinners';

  const clampFloat = React.useCallback((value: number, min: number, max: number, decimals = 1) => {
    const safe = Number.isFinite(value) ? value : min;
    const rounded = Number(safe.toFixed(decimals));
    return Math.min(max, Math.max(min, rounded));
  }, []);

  const setState = React.useCallback((patch: Partial<OrganicCutPanelState>) => {
    onStateChange({ ...state, ...patch });
  }, [onStateChange, state]);

  // Set the dome's Width or Depth, honoring Uniform Scale: when locked, dragging
  // one slider scales the OTHER by the same factor so the current width:depth
  // proportion is preserved (resize as a unit). Unlocked → set just that axis.
  const setDomeDim = React.useCallback((axis: 'width' | 'depth', next: number) => {
    const clamped = clampFloat(next, 1, 20, 1);
    if (!state.keyUniformScale) {
      setState(axis === 'width' ? { keyWidthMm: clamped } : { keyDepthMm: clamped });
      return;
    }
    const cur = axis === 'width' ? state.keyWidthMm : state.keyDepthMm;
    if (cur <= 0) {
      // Degenerate current value — just set both to the new value (round).
      setState({ keyWidthMm: clamped, keyDepthMm: clamped });
      return;
    }
    const factor = clamped / cur;
    const other = axis === 'width' ? state.keyDepthMm : state.keyWidthMm;
    const scaledOther = clampFloat(other * factor, 1, 20, 1);
    setState(
      axis === 'width'
        ? { keyWidthMm: clamped, keyDepthMm: scaledOther }
        : { keyDepthMm: clamped, keyWidthMm: scaledOther },
    );
  }, [clampFloat, setState, state.keyUniformScale, state.keyWidthMm, state.keyDepthMm]);

  const cardStyle: React.CSSProperties = {
    borderColor: 'var(--border-subtle)',
    background: 'var(--surface-1)',
  };

  const accentCardStyle: React.CSSProperties = {
    borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 76%)',
    background: 'color-mix(in srgb, var(--accent), var(--surface-1) 95%)',
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

  const activeModeStyle: React.CSSProperties = {
    borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 30%)',
    background: 'color-mix(in srgb, var(--accent), var(--surface-1) 85%)',
    color: 'var(--text-strong)',
  };

  const disabledStyle: React.CSSProperties | undefined = disabled
    ? { opacity: 0.45, filter: 'grayscale(0.7)' }
    : undefined;

  const isContour = state.cutMode === 'contour';
  const isBounded = state.cutMode === 'bounded_plane';
  const statusLabel = isContour
    ? pointCount < 3
      ? `Click points around the model to trace the seam (${pointCount}/3+)`
      : `${pointCount} points — ready to cut (contour seam)`
    : isBounded
      ? 'Position the bounded cutter plane and cut'
      : pointCount === 0
        ? 'Click 2 points across the model to set a flat cut'
        : pointCount === 1
          ? '1 point — click one more on the other side'
          : `${pointCount} points — ready to cut (flat plane)`;

  return (
    <Card style={disabledStyle}>
      <CardHeader
        left={(
          <>
            <IconButton
              onClick={() => {
                if (disabled) return;
                setExpanded((prev) => !prev);
              }}
              className="!p-0.5"
              title={expanded ? 'Collapse card' : 'Expand card'}
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
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Cut Tool</h3>
          </>
        )}
      />

      {expanded && (
        <div className="px-2 pb-2 space-y-2 sm:px-2.5 sm:pb-2.5">
          {/* Live session status */}
          <div
            className="rounded-md border p-2 text-center text-[11px]"
            style={{
              borderColor: 'var(--accent-secondary-action-border)',
              background: 'var(--accent-secondary-action-bg-92)',
              color: 'var(--accent-secondary-action-color)',
            }}
          >
            {statusLabel}
          </div>

          {/* Cut mode: flat plane vs curved contour seam */}
          <div className="rounded-md border p-2 space-y-1.5" style={accentCardStyle}>
            <div className="ui-meta" style={{ color: 'var(--text-muted)' }}>Cut Mode</div>
            <div className="grid grid-cols-3 gap-1">
              <button
                type="button"
                className="ui-button ui-button-secondary !h-8 px-1 text-[9px] sm:text-[10px] truncate"
                onClick={() => setState({ cutMode: 'contour' })}
                disabled={disabled || isApplying}
                style={state.cutMode === 'contour' ? activeModeStyle : undefined}
                title="Split along a curved seam that follows your drawn loop (zero-thickness mate)."
              >
                Contour
              </button>
              <button
                type="button"
                className="ui-button ui-button-secondary !h-8 px-1 text-[9px] sm:text-[10px] truncate"
                onClick={() => setState({ cutMode: 'plane' })}
                disabled={disabled || isApplying}
                style={state.cutMode === 'plane' ? activeModeStyle : undefined}
                title="Slice along a single flat plane derived from your points."
              >
                Flat
              </button>
              <button
                type="button"
                className="ui-button ui-button-secondary !h-8 px-1 text-[9px] sm:text-[10px] truncate"
                onClick={() => setState({ cutMode: 'bounded_plane' })}
                disabled={disabled || isApplying}
                style={state.cutMode === 'bounded_plane' ? activeModeStyle : undefined}
                title="Slice along a flat plane within a regular polygon or circular boundary."
              >
                Bounded
              </button>
            </div>
          </div>

          {/* Bounded plane specific controls */}
          {isBounded && (
            <>
              {/* Circular Boundary Toggle */}
              <div className="rounded-md border p-2 space-y-1.5" style={cardStyle}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-2 text-left"
                  onClick={() => setState({ sides: state.sides === 64 ? 4 : 64 })}
                  disabled={disabled || isApplying}
                  title="Make the cutter boundary circular instead of a regular polygon."
                >
                  <span className="ui-meta" style={{ color: 'var(--text-muted)' }}>Circular Boundary</span>
                  <span
                    className="relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors"
                    style={{
                      background: state.sides === 64
                        ? 'var(--accent)'
                        : 'color-mix(in srgb, var(--text-muted), transparent 60%)',
                    }}
                  >
                    <span
                      className="inline-block h-3 w-3 transform rounded-full bg-white transition-transform"
                      style={{ transform: state.sides === 64 ? 'translateX(14px)' : 'translateX(2px)' }}
                    />
                  </span>
                </button>
              </div>

              {/* Sides Slider (Regular Polygon) */}
              {state.sides !== 64 && (
                <div className="rounded-md border p-2 space-y-1.5" style={cardStyle}>
                  <label className="ui-meta block" style={{ color: 'var(--text-muted)' }}>
                    Sides ({getSidesLabel(state.sides ?? 4)})
                  </label>
                  <ScrollableNumberField
                    value={state.sides ?? 4}
                    onChange={(value) => setState({ sides: clampFloat(value, 3, 16, 0) })}
                    min={3}
                    max={16}
                    step={1}
                    unit=""
                    ariaLabel="Number of sides for regular polygon boundary"
                    disabled={disabled || isApplying}
                    className="mt-1"
                  />
                </div>
              )}

              {/* MOVE SECTION */}
              <div className="rounded-md border p-2" style={moveCardStyle}>
                <SectionHeader
                  title="Move"
                  expanded={moveExpanded}
                  onToggle={() => setMoveExpanded(!moveExpanded)}
                  accentColor="#4f8cff"
                />
                {moveExpanded && (
                  <div className="pt-1.5 space-y-2">
                    <div className="grid grid-cols-3 gap-1 min-w-0">
                      <div className="min-w-0">
                        <label className="ui-meta mb-1 block text-center" style={{ color: '#f87171' }}>X</label>
                        <NumberInput
                          value={parseFloat((state.planePosition?.[0] ?? 0).toFixed(2))}
                          onChange={(value) => setState({
                            planePosition: [clampFloat(value, -500, 500, 2), state.planePosition?.[1] ?? 0, state.planePosition?.[2] ?? 0]
                          })}
                          min={-500}
                          max={500}
                          step={0.5}
                          className={valueInputClass}
                          disabled={disabled || isApplying}
                        />
                      </div>
                      <div className="min-w-0">
                        <label className="ui-meta mb-1 block text-center" style={{ color: '#4ade80' }}>Y</label>
                        <NumberInput
                          value={parseFloat((state.planePosition?.[1] ?? 0).toFixed(2))}
                          onChange={(value) => setState({
                            planePosition: [state.planePosition?.[0] ?? 0, clampFloat(value, -500, 500, 2), state.planePosition?.[2] ?? 0]
                          })}
                          min={-500}
                          max={500}
                          step={0.5}
                          className={valueInputClass}
                          disabled={disabled || isApplying}
                        />
                      </div>
                      <div className="min-w-0">
                        <label className="ui-meta mb-1 block text-center" style={{ color: '#60a5fa' }}>Z</label>
                        <NumberInput
                          value={parseFloat((state.planePosition?.[2] ?? 0).toFixed(2))}
                          onChange={(value) => setState({
                            planePosition: [state.planePosition?.[0] ?? 0, state.planePosition?.[1] ?? 0, clampFloat(value, -500, 500, 2)]
                          })}
                          min={-500}
                          max={500}
                          step={0.5}
                          className={valueInputClass}
                          disabled={disabled || isApplying}
                        />
                      </div>
                    </div>
                    <button
                      type="button"
                      className={compactButtonClass}
                      onClick={() => setState({ planePosition: [0, 0, 0] })}
                      disabled={disabled || isApplying}
                      title="Center the cutter plane on the model origin."
                    >
                      Center
                    </button>
                  </div>
                )}
              </div>

              {/* ROTATE SECTION */}
              <div className="rounded-md border p-2" style={rotateCardStyle}>
                <SectionHeader
                  title="Rotate"
                  expanded={rotateExpanded}
                  onToggle={() => setRotateExpanded(!rotateExpanded)}
                  accentColor="#8f6cff"
                />
                {rotateExpanded && (
                  <div className="pt-1.5 space-y-2">
                    <div className="grid grid-cols-3 gap-1 min-w-0">
                      <div className="min-w-0">
                        <label className="ui-meta mb-1 block text-center" style={{ color: '#f87171' }}>X</label>
                        <NumberInput
                          value={Math.round(((state.planeRotation?.[0] ?? 0) * 180) / Math.PI)}
                          onChange={(value) => setState({
                            planeRotation: [
                              (clampFloat(value, -180, 180, 0) * Math.PI) / 180,
                              state.planeRotation?.[1] ?? 0,
                              state.planeRotation?.[2] ?? 0
                            ]
                          })}
                          min={-180}
                          max={180}
                          step={1}
                          className={valueInputClass}
                          disabled={disabled || isApplying}
                        />
                      </div>
                      <div className="min-w-0">
                        <label className="ui-meta mb-1 block text-center" style={{ color: '#4ade80' }}>Y</label>
                        <NumberInput
                          value={Math.round(((state.planeRotation?.[1] ?? 0) * 180) / Math.PI)}
                          onChange={(value) => setState({
                            planeRotation: [
                              state.planeRotation?.[0] ?? 0,
                              (clampFloat(value, -180, 180, 0) * Math.PI) / 180,
                              state.planeRotation?.[2] ?? 0
                            ]
                          })}
                          min={-180}
                          max={180}
                          step={1}
                          className={valueInputClass}
                          disabled={disabled || isApplying}
                        />
                      </div>
                      <div className="min-w-0">
                        <label className="ui-meta mb-1 block text-center" style={{ color: '#60a5fa' }}>Z</label>
                        <NumberInput
                          value={Math.round(((state.planeRotation?.[2] ?? 0) * 180) / Math.PI)}
                          onChange={(value) => setState({
                            planeRotation: [
                              state.planeRotation?.[0] ?? 0,
                              state.planeRotation?.[1] ?? 0,
                              (clampFloat(value, -180, 180, 0) * Math.PI) / 180
                            ]
                          })}
                          min={-180}
                          max={180}
                          step={1}
                          className={valueInputClass}
                          disabled={disabled || isApplying}
                        />
                      </div>
                    </div>
                    <button
                      type="button"
                      className={compactButtonClass}
                      onClick={() => setState({ planeRotation: [0, 0, 0] })}
                      disabled={disabled || isApplying}
                      title="Reset the cutter rotation."
                    >
                      Reset Rotation
                    </button>
                  </div>
                )}
              </div>

              {/* SCALE SECTION */}
              <div className="rounded-md border p-2" style={scaleCardStyle}>
                <SectionHeader
                  title="Scale"
                  expanded={scaleExpanded}
                  onToggle={() => setScaleExpanded(!scaleExpanded)}
                  accentColor="#2eb67d"
                />
                {scaleExpanded && (
                  <div className="pt-1.5 space-y-2">
                    <div className="grid grid-cols-3 gap-1 min-w-0">
                      <div className="min-w-0">
                        <label className="ui-meta mb-1 block text-center" style={{ color: '#f87171' }}>X (mm)</label>
                        <NumberInput
                          value={parseFloat((state.radius ? (state.radius * 2) : 40).toFixed(2))}
                          onChange={(value) => {
                            const newRadius = clampFloat(value / 2, 1, 250, 1);
                            if (state.planeUniformScale) {
                              const oldRadius = state.radius ?? 20;
                              const ratio = oldRadius > 0 ? (newRadius / oldRadius) : 1;
                              const newThickness = clampFloat(state.thicknessMm * ratio, 0.05, 1.5, 2);
                              setState({ radius: newRadius, thicknessMm: newThickness });
                            } else {
                              setState({ radius: newRadius });
                            }
                          }}
                          min={2}
                          max={500}
                          step={1}
                          className={valueInputClass}
                          disabled={disabled || isApplying}
                        />
                      </div>
                      <div className="min-w-0">
                        <label className="ui-meta mb-1 block text-center" style={{ color: '#4ade80' }}>Y (mm)</label>
                        <NumberInput
                          value={parseFloat((state.radius ? (state.radius * 2) : 40).toFixed(2))}
                          onChange={() => {}}
                          min={2}
                          max={500}
                          step={1}
                          className={valueInputClass}
                          disabled={true}
                        />
                      </div>
                      <div className="min-w-0">
                        <label className="ui-meta mb-1 block text-center" style={{ color: '#60a5fa' }}>Z (mm)</label>
                        <NumberInput
                          value={parseFloat((state.thicknessMm).toFixed(2))}
                          onChange={(value) => {
                            const newThickness = clampFloat(value, 0.05, 1.5, 2);
                            if (state.planeUniformScale) {
                              const oldThickness = state.thicknessMm;
                              const ratio = oldThickness > 0 ? (newThickness / oldThickness) : 1;
                              const newRadius = clampFloat((state.radius ?? 20) * ratio, 1, 250, 1);
                              setState({ radius: newRadius, thicknessMm: newThickness });
                            } else {
                              setState({ thicknessMm: newThickness });
                            }
                          }}
                          min={0.05}
                          max={1.5}
                          step={0.05}
                          className={valueInputClass}
                          disabled={disabled || isApplying || state.planeUniformScale}
                        />
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <span className="ui-meta" style={{ color: 'var(--text-muted)' }}>Uniform</span>
                      <button
                        type="button"
                        onClick={() => setState({ planeUniformScale: !state.planeUniformScale })}
                        disabled={disabled || isApplying}
                        className="h-8 min-w-[72px] rounded-md border px-3 text-[11px] font-semibold uppercase tracking-wide transition-colors"
                        style={state.planeUniformScale
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
                        {state.planeUniformScale ? 'ON' : 'OFF'}
                      </button>
                    </div>

                    <button
                      type="button"
                      className={compactButtonClass}
                      onClick={() => setState({ radius: 20, thicknessMm: 0.1 })}
                      disabled={disabled || isApplying}
                      title="Reset cutter radius and thickness."
                    >
                      Reset Scale
                    </button>
                  </div>
                )}
              </div>
            </>
          )}

          {/* Draw mode */}
          {!isBounded && (
            <div className="rounded-md border p-2 space-y-1.5" style={accentCardStyle}>
              <div className="ui-meta" style={{ color: 'var(--text-muted)' }}>Draw Mode</div>
              <div className="grid grid-cols-2 gap-1">
                <button
                  type="button"
                  className="ui-button ui-button-secondary !h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
                  onClick={() => setState({ drawMode: 'waypoint' })}
                  disabled={disabled || isApplying}
                  style={state.drawMode === 'waypoint' ? activeModeStyle : undefined}
                  title="Click to place points; the tool connects them along the surface."
                >
                  Waypoint
                </button>
                <button
                  type="button"
                  className="ui-button ui-button-secondary !h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
                  onClick={() => setState({ drawMode: 'freeDraw' })}
                  disabled={disabled || isApplying}
                  style={state.drawMode === 'freeDraw' ? activeModeStyle : undefined}
                  title="Drag across the surface to paint the seam freehand."
                >
                  Free-draw
                </button>
              </div>
            </div>
          )}

          {/* Seam-line smoothing (how much the cut line rounds through waypoints) */}
          {!isBounded && (
            <div className="rounded-md border p-2 space-y-1.5" style={cardStyle}>
              <label className="ui-meta block" style={{ color: 'var(--text-muted)' }}>Seam Smoothing</label>
              <ScrollableNumberField
                value={state.smoothing}
                onChange={(value) => setState({ smoothing: clampFloat(value, 0, 2, 2) })}
                min={0}
                max={2}
                step={0.05}
                unit=""
                ariaLabel="Seam line smoothing strength"
                disabled={disabled || isApplying}
                className="mt-1"
              />
            </div>
          )}

          {/* Cut thickness (the kerf the cut removes). */}
          {!isBounded && (
            <div className="rounded-md border p-2 space-y-1.5" style={cardStyle}>
              <label className="ui-meta block" style={{ color: 'var(--text-muted)' }}>Cut Thickness</label>
              <ScrollableNumberField
                value={state.thicknessMm}
                onChange={(value) => setState({ thicknessMm: clampFloat(value, 0.05, 1.5, 2) })}
                min={0.05}
                max={1.5}
                step={0.05}
                unit="mm"
                ariaLabel="Cut thickness in millimeters"
                disabled={disabled || isApplying}
                className="mt-1"
              />
            </div>
          )}

          {/* Cut smoothing (how smooth/taut the curved cutter surface is).
              Only meaningful for the contour cut. */}
          {isContour && (
            <div className="rounded-md border p-2 space-y-1.5" style={cardStyle}>
              <label className="ui-meta block" style={{ color: 'var(--text-muted)' }}>Cut Smoothing</label>
              <ScrollableNumberField
                value={state.membraneSmoothing}
                onChange={(value) => setState({ membraneSmoothing: clampFloat(value, 0, 2, 2) })}
                min={0}
                max={2}
                step={0.05}
                unit=""
                ariaLabel="Cut surface smoothing strength"
                disabled={disabled || isApplying}
                className="mt-1"
              />
            </div>
          )}

          {/* Cut resolution (cutter poly count). Higher = denser cut mesh. The
              preview reflects this live so the user sees the change. Contour-only. */}
          {isContour && (
            <div className="rounded-md border p-2 space-y-1.5" style={cardStyle}>
              <label className="ui-meta block" style={{ color: 'var(--text-muted)' }}>Cut Resolution</label>
              <ScrollableNumberField
                value={state.density}
                onChange={(value) => setState({ density: clampFloat(value, 1, 4, 2) })}
                min={1}
                max={4}
                step={0.5}
                unit="×"
                ariaLabel="Cut mesh resolution multiplier (applied at cut)"
                disabled={disabled || isApplying}
                className="mt-1"
              />
            </div>
          )}

          {/* Registration key: peg + socket so the two halves index together.
              Contour & Bounded Plane cuts support keys. */}
          {(isContour || isBounded) && (
            <div className="rounded-md border p-2 space-y-1.5" style={cardStyle}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 text-left"
                onClick={() => setState({ generateKey: !state.generateKey })}
                disabled={disabled || isApplying}
                title="Add a peg to one half and a matching socket to the other so the parts align when reassembled."
              >
                <span className="ui-meta" style={{ color: 'var(--text-muted)' }}>Generate Key</span>
                <span
                  className="relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors"
                  style={{
                    background: state.generateKey
                      ? 'var(--accent)'
                      : 'color-mix(in srgb, var(--text-muted), transparent 60%)',
                  }}
                >
                  <span
                    className="inline-block h-3 w-3 transform rounded-full bg-white transition-transform"
                    style={{ transform: state.generateKey ? 'translateX(14px)' : 'translateX(2px)' }}
                  />
                </span>
              </button>

              {/* Key shape + size. Shape picks frustum (tapered box, locks
                  rotation) vs dome (half-sphere, locates only). Width drives the
                  base; depth (frustum only) is how far the peg pokes in. The
                  1 mm-wall fit rule still shrinks below these on thin parts. */}
              {state.generateKey && (
                <div className="space-y-1.5 pt-0.5">
                  <div>
                    <label className="ui-meta block" style={{ color: 'var(--text-muted)' }}>Key Shape</label>
                    <div className="mt-1 grid grid-cols-2 gap-1">
                      <button
                        type="button"
                        className="ui-button ui-button-secondary !h-7 whitespace-nowrap px-1.5 text-[10px]"
                        onClick={() => setState({ keyShape: 'frustum' })}
                        disabled={disabled || isApplying}
                        style={state.keyShape === 'frustum' ? activeModeStyle : undefined}
                        title="Tapered rectangular peg — locks the parts against rotation."
                      >
                        Frustum
                      </button>
                      <button
                        type="button"
                        className="ui-button ui-button-secondary !h-7 whitespace-nowrap px-1.5 text-[10px]"
                        onClick={() => setState({ keyShape: 'dome' })}
                        disabled={disabled || isApplying}
                        style={state.keyShape === 'dome' ? activeModeStyle : undefined}
                        title="Half-sphere peg — locates the parts but allows rotation."
                      >
                        Dome
                      </button>
                    </div>
                  </div>
                  {/* Flip which half gets the peg vs the socket. Affects the cut
                      (not the preview shape, which is identical either way). */}
                  <button
                    type="button"
                    className="ui-button ui-button-secondary !h-7 w-full whitespace-nowrap px-1.5 text-[10px]"
                    onClick={() => setState({ keySwapSides: !state.keySwapSides })}
                    disabled={disabled || isApplying}
                    title="Swap which cut half receives the peg and which receives the socket."
                  >
                    <span className="inline-flex items-center justify-center gap-1.5">
                      <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4M16 17H4m0 0l4 4m-4-4l4-4" />
                      </svg>
                      <span>{state.keySwapSides ? 'Peg on Side B' : 'Peg on Side A'}</span>
                    </span>
                  </button>
                  {/* Aim: a hint + a Reset that zeroes the tilt/roll. The tilt is set
                      by dragging the key's tip in the 3D view (and the ring to roll);
                      Reset snaps it back to straight-out. Shown only once tilted. */}
                  {(() => {
                    const tilted =
                      Math.abs(state.keyTiltRad) > 1e-3 || Math.abs(state.keyRollRad) > 1e-3;
                    const tiltDeg = Math.round((state.keyTiltRad * 180) / Math.PI);
                    return (
                      <div className="flex items-center justify-between gap-2">
                        <span className="ui-meta" style={{ color: 'var(--text-muted)' }}>
                          {tilted ? `Aim: ${tiltDeg}° lean` : 'Aim: drag the key tip in 3D'}
                        </span>
                        {tilted && (
                          <button
                            type="button"
                            className="ui-button ui-button-secondary !h-6 whitespace-nowrap px-1.5 text-[10px]"
                            onClick={() => setState({ keyTiltRad: 0, keyTiltAzimuthRad: 0, keyRollRad: 0 })}
                            disabled={disabled || isApplying}
                            title="Reset the key to point straight out of the cut (no lean / roll)."
                          >
                            Reset Aim
                          </button>
                        )}
                      </div>
                    );
                  })()}
                  {/* Width — frustum: sets just width; dome: ratio-locks depth
                      when Uniform Scale is on. */}
                  <div>
                    <label className="ui-meta block" style={{ color: 'var(--text-muted)' }}>Key Width</label>
                    <ScrollableNumberField
                      value={state.keyWidthMm}
                      onChange={(value) =>
                        state.keyShape === 'dome'
                          ? setDomeDim('width', value)
                          : setState({ keyWidthMm: clampFloat(value, 1, 20, 1) })
                      }
                      min={1}
                      max={20}
                      step={0.5}
                      unit="mm"
                      ariaLabel="Key width in millimeters"
                      disabled={disabled || isApplying}
                      className="mt-1"
                    />
                  </div>
                  {/* Depth — applies to BOTH shapes now (dome bulge into the body
                      / frustum peg depth). Dome ratio-locks width when Uniform. */}
                  <div>
                    <label className="ui-meta block" style={{ color: 'var(--text-muted)' }}>Key Depth</label>
                    <ScrollableNumberField
                      value={state.keyDepthMm}
                      onChange={(value) =>
                        state.keyShape === 'dome'
                          ? setDomeDim('depth', value)
                          : setState({ keyDepthMm: clampFloat(value, 1, 20, 1) })
                      }
                      min={1}
                      max={20}
                      step={0.5}
                      unit="mm"
                      ariaLabel="Key depth in millimeters"
                      disabled={disabled || isApplying}
                      className="mt-1"
                    />
                  </div>
                  {/* Edge Fillet: frustum only (a dome is already fully round). */}
                  {state.keyShape === 'frustum' && (
                    <div>
                      <label className="ui-meta block" style={{ color: 'var(--text-muted)' }}>Edge Fillet</label>
                      <ScrollableNumberField
                        value={state.keyFilletMm}
                        onChange={(value) => setState({ keyFilletMm: clampFloat(value, 0, 5, 2) })}
                        min={0}
                        max={5}
                        step={0.1}
                        unit="mm"
                        ariaLabel="Key edge fillet radius in millimeters (0 = sharp)"
                        disabled={disabled || isApplying}
                        className="mt-1"
                      />
                    </div>
                  )}
                  {/* Uniform Scale: dome only — lock width:depth so the dome resizes
                      as a unit (keeps its shape), or unlock for free oblong control. */}
                  {state.keyShape === 'dome' && (
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-2 text-left"
                      onClick={() => setState({ keyUniformScale: !state.keyUniformScale })}
                      disabled={disabled || isApplying}
                      title="Lock width and depth together so the dome keeps its shape when resized. Unlock for an oblong dome."
                    >
                      <span className="ui-meta" style={{ color: 'var(--text-muted)' }}>Uniform Scale</span>
                      <span
                        className="relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors"
                        style={{
                          background: state.keyUniformScale
                            ? 'var(--accent)'
                            : 'color-mix(in srgb, var(--text-muted), transparent 60%)',
                        }}
                      >
                        <span
                          className="inline-block h-3 w-3 transform rounded-full bg-white transition-transform"
                          style={{ transform: state.keyUniformScale ? 'translateX(14px)' : 'translateX(2px)' }}
                        />
                      </span>
                    </button>
                  )}
                </div>
              )}

              {/* Fell-back / no-key alert. Only when the key is ON and the preview
                  reported a non-nominal outcome (dome fallback, no key, or shrink). */}
              {state.generateKey && keyDetail && (
                <div
                  className="rounded border px-2 py-1.5 text-[10px] leading-snug"
                  style={
                    keyKind === 'none'
                      ? {
                          borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 40%)',
                          background: 'color-mix(in srgb, #f59e0b, var(--surface-1) 88%)',
                          color: 'var(--text-strong)',
                        }
                      : keyKind === 'dome'
                        ? {
                            borderColor: 'color-mix(in srgb, #eab308, var(--border-subtle) 50%)',
                            background: 'color-mix(in srgb, #eab308, var(--surface-1) 90%)',
                            color: 'var(--text-strong)',
                          }
                        : {
                            borderColor: 'var(--border-subtle)',
                            background: 'var(--surface-1)',
                            color: 'var(--text-muted)',
                          }
                  }
                >
                  {keyDetail}
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2">
            <button
              type="button"
              className="ui-button ui-button-secondary flex-1 !min-h-8 px-1.5 py-1 text-[10px] sm:text-[11px] whitespace-normal text-center leading-tight disabled:opacity-60"
              onClick={onClearLoop}
              disabled={disabled || isApplying || pointCount === 0}
            >
              Clear
            </button>
            <button
              type="button"
              className="ui-button ui-button-secondary flex-1 !min-h-8 px-1.5 py-1 text-[10px] sm:text-[11px] whitespace-normal text-center leading-tight disabled:opacity-60"
              onClick={onCloseLoop}
              disabled={disabled || isApplying || !canCloseLoop}
            >
              Close Loop
            </button>
            <button
              type="button"
              className="ui-button ui-button-accent flex-1 !min-h-8 px-1.5 py-1 text-[10px] sm:text-[11px] whitespace-normal text-center leading-tight disabled:opacity-60"
              onClick={onApply}
              disabled={disabled || isApplying || !canApply}
            >
              <span className="inline-flex items-center justify-center gap-1.5">
                {isApplying && <Loader2 className="h-3 w-3 animate-spin" />}
                <span>{isApplying ? 'Cutting...' : 'Cut'}</span>
              </span>
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}
