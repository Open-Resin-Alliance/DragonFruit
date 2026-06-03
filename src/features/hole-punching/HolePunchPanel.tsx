import React from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { Card, CardHeader, IconButton } from '@/components/ui/primitives';
import { ScrollableNumberField } from '@/components/ui/scrollableNumberField';

export interface HolePunchPanelState {
  radiusMm: number;
  depthMm: number;
}

interface HolePunchPanelProps {
  state: HolePunchPanelState;
  onStateChange: (next: HolePunchPanelState) => void;
  onReset: () => void;
  onApply: () => void;
  placementCount: number;
  isApplying?: boolean;
  canApply?: boolean;
}

export function HolePunchPanel({
  state,
  onStateChange,
  onReset,
  onApply,
  placementCount,
  isApplying = false,
  canApply = false,
}: HolePunchPanelProps) {
  const [expanded, setExpanded] = React.useState(true);

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

  return (
    <Card>
      <CardHeader
        left={(
          <>
            <IconButton
              onClick={() => setExpanded((prev) => !prev)}
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
          <div className="rounded-md border p-2 space-y-1.5" style={cardStyle}>
            <div className="rounded-md border px-2 py-2 text-[11px] leading-snug" style={{ borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 76%)', background: 'color-mix(in srgb, var(--accent), var(--surface-1) 95%)', color: 'var(--text-strong)' }}>
              Click faces to place drain holes. Click an existing hole to edit its settings.
            </div>
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Placed holes: {placementCount}
            </div>
          </div>

          <div className="rounded-md border p-2 space-y-1.5" style={cardStyle}>
            <label className="ui-meta block" style={{ color: 'var(--text-muted)' }}>Hole Radius</label>
            <ScrollableNumberField
              value={state.radiusMm}
              onChange={(value) => setState({ radiusMm: clampFloat(value, 0.2, 20, 1) })}
              min={0.2}
              max={20}
              step={0.1}
              unit="mm"
              ariaLabel="Hole punch radius in millimeters"
              disabled={isApplying}
              className="mt-1"
            />
          </div>

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
              disabled={isApplying}
              className="mt-1"
            />
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              className="ui-button ui-button-secondary flex-1 !min-h-8 px-1.5 py-1 text-[10px] sm:text-[11px] whitespace-normal text-center leading-tight disabled:opacity-60"
              onClick={onReset}
              disabled={isApplying}
            >
              Reset
            </button>
            <button
              type="button"
              className="ui-button ui-button-accent flex-1 !min-h-8 px-1.5 py-1 text-[10px] sm:text-[11px] whitespace-normal text-center leading-tight disabled:opacity-60"
              onClick={onApply}
              disabled={isApplying || !canApply}
            >
              {isApplying ? (
                <span className="inline-flex items-center justify-center gap-1.5">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>Saving…</span>
                </span>
              ) : (
                <span className="inline-flex items-center justify-center gap-1.5">
                  <span>Apply</span>
                </span>
              )}
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}
