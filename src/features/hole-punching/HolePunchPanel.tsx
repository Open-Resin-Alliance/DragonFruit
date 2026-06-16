import React from 'react';
import { Loader2 } from 'lucide-react';
import { Card, CardHeader, IconButton } from '@/components/ui/primitives';
import { ScrollableNumberField } from '@/components/ui/scrollableNumberField';

export interface HolePunchPanelState {
  radiusMm: number;
  radiusYMm?: number;
  depthMm: number;
  depthMode: 'manual' | 'auto';
}

interface HolePunchPanelProps {
  state: HolePunchPanelState;
  onStateChange: (next: HolePunchPanelState) => void;
  onReset: () => void;
  onApply: () => void;
  canUseAutoDepth?: boolean;
  isApplying?: boolean;
  canApply?: boolean;
  canReset?: boolean;
  disabled?: boolean;
  interiorView?: boolean;
  interiorViewAvailable?: boolean;
}

export function HolePunchPanel({
  state,
  onStateChange,
  onReset,
  onApply,
  canUseAutoDepth = true,
  isApplying = false,
  canApply = false,
  canReset = true,
  disabled = false,
  interiorView = false,
  interiorViewAvailable = false,
}: HolePunchPanelProps) {
  const [expanded, setExpanded] = React.useState(true);
  const [linked, setLinked] = React.useState(true);
  const effectiveRadiusYMm = state.radiusYMm ?? state.radiusMm;

  const clampFloat = React.useCallback((value: number, min: number, max: number, decimals = 1) => {
    const safe = Number.isFinite(value) ? value : min;
    const rounded = Number(safe.toFixed(decimals));
    return Math.min(max, Math.max(min, rounded));
  }, []);

  const setState = React.useCallback((patch: Partial<HolePunchPanelState>) => {
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
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Hole Punching</h3>
          </>
        )}
      />

      {expanded && (
        <div className="px-2 pb-2 space-y-2 sm:px-2.5 sm:pb-2.5">
          {canUseAutoDepth && interiorViewAvailable && (
            <div
              className="rounded-md border p-2 space-y-1.5 text-center min-h-[4.5rem] box-border flex flex-col items-center justify-center"
              style={{
                borderColor: 'var(--accent-secondary-action-border)',
                background: 'var(--accent-secondary-action-bg-92)',
              }}
            >
              <div className="ui-meta text-xs" style={{ color: 'var(--accent-secondary-action-color)' }}>Interior View Mode</div>
              <div className="flex items-center gap-1.5">
                <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  Press <kbd className="px-1 rounded text-xs font-medium" style={{ background: 'var(--surface-2)', color: '#baf72e' }}>X</kbd> for <strong style={{ color: 'var(--accent-secondary-action-color)' }}>{interiorView ? 'Exterior View' : 'Interior View'}</strong>
                </span>
              </div>
            </div>
          )}
          <div className="rounded-md border p-2 space-y-1.5" style={accentCardStyle}>
            <div className="ui-meta" style={{ color: 'var(--text-muted)' }}>Depth Mode</div>
            <div className="grid grid-cols-2 gap-1">
              <button
                type="button"
                className="ui-button ui-button-secondary !h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
                onClick={() => setState({ depthMode: 'auto' })}
                disabled={disabled || isApplying || !canUseAutoDepth}
                style={state.depthMode === 'auto' ? activeModeStyle : undefined}
                title={!canUseAutoDepth ? 'Auto depth requires a hollowed model or hollow preview.' : undefined}
              >
                Auto
              </button>
              <button
                type="button"
                className="ui-button ui-button-secondary !h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
                onClick={() => setState({ depthMode: 'manual' })}
                disabled={disabled || isApplying}
                style={state.depthMode === 'manual' ? activeModeStyle : undefined}
              >
                Manual
              </button>
            </div>
          </div>

          {state.depthMode === 'manual' && (
            <div className="rounded-md border p-2 space-y-1.5" style={cardStyle}>
              <label className="ui-meta block" style={{ color: 'var(--text-muted)' }}>Punch Depth</label>
              <ScrollableNumberField
                value={state.depthMm}
                onChange={(value) => setState({ depthMm: clampFloat(value, 1, 120, 1) })}
                min={1}
                max={120}
                step={0.5}
                unit="mm"
                ariaLabel="Hole punch depth in millimeters"
                disabled={disabled || isApplying}
                className="mt-1"
              />
            </div>
          )}

          <div className="rounded-md border p-2 space-y-2" style={cardStyle}>
            <div className="flex items-center justify-between">
              <label className="ui-meta" style={{ color: 'var(--text-muted)' }}>Hole Diameter</label>
              <button
                type="button"
                className="flex items-center justify-center w-5 h-5 rounded transition-colors hover:bg-white/10"
                onClick={() => {
                  const nextLinked = !linked;
                  setLinked(nextLinked);
                  if (nextLinked) {
                    setState({ radiusYMm: undefined });
                  } else {
                    // Initialize Y to current X so it stays independent.
                    setState({ radiusYMm: state.radiusMm });
                  }
                }}
                title={linked ? 'Unlink X and Y' : 'Link X and Y'}
                disabled={disabled || isApplying}
              >
                <svg
                  className="w-3.5 h-3.5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ color: linked ? 'var(--accent)' : 'var(--text-muted)' }}
                >
                  {linked ? (
                    <>
                      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                    </>
                  ) : (
                    <>
                      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                      <line x1="2" y1="2" x2="22" y2="22" />
                    </>
                  )}
                </svg>
              </button>
            </div>

            <ScrollableNumberField
              value={state.radiusMm * 2}
              onChange={(value) => {
                const nextRadius = clampFloat(value * 0.5, 0.2, 20, 2);
                if (linked) {
                  setState({ radiusMm: nextRadius, radiusYMm: undefined });
                } else {
                  setState({ radiusMm: nextRadius });
                }
              }}
              min={0.4}
              max={40}
              step={0.1}
              unit="mm"
              ariaLabel="Hole diameter X in millimeters"
              disabled={disabled || isApplying}
              className="mt-0"
            />

            <ScrollableNumberField
              value={effectiveRadiusYMm * 2}
              onChange={(value) => setState({ radiusYMm: clampFloat(value * 0.5, 0.2, 20, 2) })}
              min={0.4}
              max={40}
              step={0.1}
              unit="mm"
              ariaLabel="Hole diameter Y in millimeters"
              disabled={disabled || isApplying || linked}
              className="mt-0"
            />
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              className="ui-button ui-button-secondary flex-1 !min-h-8 px-1.5 py-1 text-[10px] sm:text-[11px] whitespace-normal text-center leading-tight disabled:opacity-60"
              onClick={onReset}
              disabled={disabled || isApplying || !canReset}
            >
              Reset
            </button>
            <button
              type="button"
              className="ui-button ui-button-accent flex-1 !min-h-8 px-1.5 py-1 text-[10px] sm:text-[11px] whitespace-normal text-center leading-tight disabled:opacity-60"
              onClick={onApply}
              disabled={disabled || isApplying || !canApply}
            >
              <span className="inline-flex items-center justify-center gap-1.5">
                {isApplying && <Loader2 className="h-3 w-3 animate-spin" />}
                <span>{isApplying ? 'Applying...' : 'Apply'}</span>
              </span>
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}
