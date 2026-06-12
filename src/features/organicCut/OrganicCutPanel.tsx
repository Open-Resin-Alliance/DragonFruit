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
  sessionStatus,
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

  const clampFloat = React.useCallback((value: number, min: number, max: number, decimals = 1) => {
    const safe = Number.isFinite(value) ? value : min;
    const rounded = Number(safe.toFixed(decimals));
    return Math.min(max, Math.max(min, rounded));
  }, []);

  const setState = React.useCallback((patch: Partial<OrganicCutPanelState>) => {
    onStateChange({ ...state, ...patch });
  }, [onStateChange, state]);

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

              {/* Key size sliders (mm). Width drives the base (length = 1.25×);
                  depth is how far the peg pokes in. Shown only when the key is on.
                  The 1 mm-wall fit rule still shrinks below these on thin parts. */}
              {state.generateKey && (
                <div className="space-y-1.5 pt-0.5">
                  <div>
                    <label className="ui-meta block" style={{ color: 'var(--text-muted)' }}>Key Width</label>
                    <ScrollableNumberField
                      value={state.keyWidthMm}
                      onChange={(value) => setState({ keyWidthMm: clampFloat(value, 1, 20, 1) })}
                      min={1}
                      max={20}
                      step={0.5}
                      unit="mm"
                      ariaLabel="Key base width in millimeters"
                      disabled={disabled || isApplying}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <label className="ui-meta block" style={{ color: 'var(--text-muted)' }}>Key Depth</label>
                    <ScrollableNumberField
                      value={state.keyDepthMm}
                      onChange={(value) => setState({ keyDepthMm: clampFloat(value, 1, 20, 1) })}
                      min={1}
                      max={20}
                      step={0.5}
                      unit="mm"
                      ariaLabel="Key depth in millimeters"
                      disabled={disabled || isApplying}
                      className="mt-1"
                    />
                  </div>
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
