import React from 'react';
import { Loader2 } from 'lucide-react';
import { Card, CardHeader, IconButton } from '@/components/ui/primitives';
import { ScrollableNumberField } from '@/components/ui/scrollableNumberField';
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
  /**
   * Render the translucent cut-plan preview (flat plane quad / contour membrane +
   * registration key) in the 3D view. When off, only the seam line + loop markers
   * draw, so the model is unobscured while drawing. On by default.
   */
  showPreview: boolean;
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
  // --- Multi-loop (contour) -------------------------------------------------
  /** Total loops in the current cut. */
  loopCount?: number;
  /** Index of the loop currently being edited. */
  activeLoopIndex?: number;
  /** Per-loop summaries (index + waypoint count + whether it has a key) for chips. */
  loopSummaries?: { index: number; pointCount: number; hasKey: boolean }[];
  /** Switch which loop is active (editable). */
  onSelectLoop?: (index: number) => void;
  /** Append a new loop and make it active. */
  onAddLoop?: () => void;
  /** True when a new loop can be added (active loop is already a real loop). */
  canAddLoop?: boolean;
  /** Remove a loop (never the last one). */
  onRemoveLoop?: (index: number) => void;
  /** True when there's more than one loop, so removing is allowed. */
  canRemoveLoop?: boolean;
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
  sessionStatus,
  pointCount,
  onClearLoop,
  onCloseLoop,
  loopCount = 1,
  activeLoopIndex = 0,
  loopSummaries = [],
  onSelectLoop,
  onAddLoop,
  canAddLoop = false,
  onRemoveLoop,
  canRemoveLoop = false,
  onApply,
  isApplying = false,
  canApply = false,
  canCloseLoop = false,
  disabled = false,
  keyKind = 'none',
  keyDetail = '',
}: OrganicCutPanelProps) {
  const [expanded, setExpanded] = React.useState(true);

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

  const activeModeStyle: React.CSSProperties = {
    borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 30%)',
    background: 'color-mix(in srgb, var(--accent), var(--surface-1) 85%)',
    color: 'var(--text-strong)',
  };

  const disabledStyle: React.CSSProperties | undefined = disabled
    ? { opacity: 0.45, filter: 'grayscale(0.7)' }
    : undefined;

  const isContour = state.cutMode === 'contour';
  const statusLabel = isContour
    ? pointCount < 3
      ? `Click points around the model to trace the seam (${pointCount}/3+)`
      : `${pointCount} points — ready to cut (contour seam)`
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
            <div className="grid grid-cols-2 gap-1">
              <button
                type="button"
                className="ui-button ui-button-secondary !h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
                onClick={() => setState({ cutMode: 'contour' })}
                disabled={disabled || isApplying}
                style={state.cutMode === 'contour' ? activeModeStyle : undefined}
                title="Split along a curved seam that follows your drawn loop (zero-thickness mate)."
              >
                Contour
              </button>
              <button
                type="button"
                className="ui-button ui-button-secondary !h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
                onClick={() => setState({ cutMode: 'plane' })}
                disabled={disabled || isApplying}
                style={state.cutMode === 'plane' ? activeModeStyle : undefined}
                title="Slice along a single flat plane derived from your points."
              >
                Flat
              </button>
            </div>
          </div>

          {/* Draw mode */}
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

          {/* Show Preview: render the translucent cut-plan surfaces (plane quad /
              membrane + key) on or off. Off → only the seam line + markers draw,
              so the model is unobscured while drawing. */}
          <div className="rounded-md border p-2 space-y-1.5" style={cardStyle}>
            <button
              type="button"
              className="flex w-full items-center justify-between gap-2 text-left"
              onClick={() => setState({ showPreview: !state.showPreview })}
              disabled={disabled || isApplying}
              title="Show or hide the translucent cut preview in the 3D view. The drawn seam and points stay visible either way."
            >
              <span className="ui-meta" style={{ color: 'var(--text-muted)' }}>Show Preview</span>
              <span
                className="relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors"
                style={{
                  background: state.showPreview
                    ? 'var(--accent)'
                    : 'color-mix(in srgb, var(--text-muted), transparent 60%)',
                }}
              >
                <span
                  className="inline-block h-3 w-3 transform rounded-full bg-white transition-transform"
                  style={{ transform: state.showPreview ? 'translateX(14px)' : 'translateX(2px)' }}
                />
              </span>
            </button>
          </div>

          {/* Seam-line smoothing (how much the cut line rounds through waypoints) */}
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

          {/* Cut thickness (the kerf the cut removes). */}
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
              Contour-only (the flat plane cut has no key support yet). */}
          {isContour && (
            <div className="rounded-md border p-2 space-y-1.5" style={cardStyle}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 text-left"
                onClick={() => setState({ generateKey: !state.generateKey })}
                disabled={disabled || isApplying}
                title="Add a peg to one half and a matching socket to the other so the parts align when reassembled."
              >
                <span className="ui-meta" style={{ color: 'var(--text-muted)' }}>
                  Generate Key{loopCount > 1 ? ` · Loop ${activeLoopIndex + 1}` : ''}
                </span>
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

          {/* Multi-loop cut (contour only): a list of loops, each editable. Switch
              between them to adjust any one; Cut severs them all at once. This is
              how you free a part connected in several places — e.g. a tail joined
              to the body at two posts with an air gap between — where a single
              loop can't span the gap cleanly. */}
          {isContour && (
            <div className="rounded-md border p-2 space-y-1.5" style={cardStyle}>
              <div className="flex items-center justify-between gap-2">
                <span className="ui-meta" style={{ color: 'var(--text-muted)' }}>
                  Loops{loopCount > 1 ? ` (${loopCount})` : ''}
                </span>
                {canRemoveLoop && (
                  <button
                    type="button"
                    className="ui-button ui-button-secondary !h-6 whitespace-nowrap px-1.5 text-[10px] disabled:opacity-60"
                    onClick={() => onRemoveLoop?.(activeLoopIndex)}
                    disabled={disabled || isApplying}
                    title="Remove the loop you're editing."
                  >
                    Remove
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1">
                {loopSummaries.map((s) => {
                  const isActive = s.index === activeLoopIndex;
                  const incomplete = s.pointCount < 3;
                  return (
                    <button
                      key={s.index}
                      type="button"
                      className="ui-button ui-button-secondary !h-7 !min-w-7 whitespace-nowrap px-1.5 text-[10px] disabled:opacity-60"
                      onClick={() => onSelectLoop?.(s.index)}
                      disabled={disabled || isApplying}
                      style={
                        isActive
                          ? activeModeStyle
                          : incomplete
                            ? { borderStyle: 'dashed', color: 'var(--text-muted)' }
                            : undefined
                      }
                      title={
                        `Loop ${s.index + 1} — ${s.pointCount} point${s.pointCount === 1 ? '' : 's'}` +
                        (s.hasKey ? ', keyed' : '') +
                        (incomplete ? ' (needs 3+ to cut)' : '') +
                        (isActive ? ' — editing' : ' — click to edit')
                      }
                    >
                      <span className="inline-flex items-center gap-0.5">
                        {s.index + 1}
                        {s.hasKey && (
                          <span
                            aria-hidden
                            className="inline-block h-1.5 w-1.5 rounded-full"
                            style={{ background: isActive ? 'currentColor' : 'var(--accent)' }}
                            title="This loop has a registration key"
                          />
                        )}
                      </span>
                    </button>
                  );
                })}
                <button
                  type="button"
                  className="ui-button ui-button-secondary !h-7 !min-w-7 whitespace-nowrap px-1.5 text-[11px] disabled:opacity-60"
                  onClick={onAddLoop}
                  disabled={disabled || isApplying || !canAddLoop}
                  title="Add another loop and start drawing it. On Cut, every loop is cut together — use it to free a part attached in several places (e.g. a tail joined at two posts)."
                >
                  +
                </button>
              </div>
              {loopCount > 1 && (
                <div className="ui-meta leading-snug" style={{ color: 'var(--text-muted)' }}>
                  Cut severs all loops at once. Click a number to edit that loop —
                  its key settings (below) and waypoints are its own. A dot marks a
                  loop that has a key.
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
              disabled={disabled || isApplying || !loopSummaries.some((s) => s.pointCount > 0)}
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
