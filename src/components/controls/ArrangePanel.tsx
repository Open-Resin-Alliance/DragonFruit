import React from 'react';
import { ChevronDown, ChevronUp, LayoutGrid, Loader2, RotateCw } from 'lucide-react';
import { NumberInput } from '@/components/ui/NumberInput';
import { Button, Card, CardHeader, IconButton, Select } from '@/components/ui/primitives';

export type ArrangeAnchorMode = 'center' | 'front_left' | 'front_right' | 'back_left' | 'back_right';
export type ArrangeLayoutMode = 'auto' | 'array';

interface ArrangePanelProps {
  layoutMode: ArrangeLayoutMode;
  onLayoutModeChange: (value: ArrangeLayoutMode) => void;
  spacingMm: number;
  onSpacingMmChange: (value: number) => void;
  allowRotateOnZ: boolean;
  onAllowRotateOnZChange: (value: boolean) => void;
  arrayCountX: number;
  arrayCountY: number;
  arrayCountZ: number;
  onArrayCountXChange: (value: number) => void;
  onArrayCountYChange: (value: number) => void;
  onArrayCountZChange: (value: number) => void;
  arrayGapX: number;
  arrayGapY: number;
  arrayGapZ: number;
  onArrayGapXChange: (value: number) => void;
  onArrayGapYChange: (value: number) => void;
  onArrayGapZChange: (value: number) => void;
  anchorMode: ArrangeAnchorMode;
  onAnchorModeChange: (value: ArrangeAnchorMode) => void;
  onApplyAll: () => void;
  onApplySelected: () => void;
  modelCount: number;
  selectedModelCount: number;
  isApplying?: boolean;
}

type MiniStepperFieldProps = {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  disabled?: boolean;
};

function MiniStepperField({ value, onChange, min, max, disabled = false }: MiniStepperFieldProps) {
  const safe = Number.isFinite(value) ? value : min;
  const clamped = Math.min(max, Math.max(min, Math.round(safe)));

  const apply = React.useCallback((next: number) => {
    const normalized = Math.min(max, Math.max(min, Math.round(Number.isFinite(next) ? next : min)));
    onChange(normalized);
  }, [max, min, onChange]);

  return (
    <div
      className="relative min-w-0"
      onWheel={(e) => {
        if (disabled) return;
        e.preventDefault();
        const delta = e.deltaY < 0 ? 1 : -1;
        apply(clamped + delta);
      }}
    >
      <NumberInput
        value={clamped}
        onChange={apply}
        disabled={disabled}
        className="ui-input h-8 w-full min-w-0 pl-1.5 pr-5 text-xs text-center no-spinners"
      />

      <div className="absolute inset-y-0 right-0.5 flex w-4 flex-col items-center justify-center gap-0.5">
        <button
          type="button"
          className="inline-flex h-3 w-3 items-center justify-center rounded hover:bg-white/10 disabled:opacity-50"
          onClick={() => apply(clamped + 1)}
          disabled={disabled || clamped >= max}
          tabIndex={-1}
          aria-label="Increase value"
        >
          <ChevronUp className="h-2.5 w-2.5" />
        </button>
        <button
          type="button"
          className="inline-flex h-3 w-3 items-center justify-center rounded hover:bg-white/10 disabled:opacity-50"
          onClick={() => apply(clamped - 1)}
          disabled={disabled || clamped <= min}
          tabIndex={-1}
          aria-label="Decrease value"
        >
          <ChevronDown className="h-2.5 w-2.5" />
        </button>
      </div>
    </div>
  );
}

export function ArrangePanel({
  layoutMode,
  onLayoutModeChange,
  spacingMm,
  onSpacingMmChange,
  allowRotateOnZ,
  onAllowRotateOnZChange,
  arrayCountX,
  arrayCountY,
  arrayCountZ,
  onArrayCountXChange,
  onArrayCountYChange,
  onArrayCountZChange,
  arrayGapX,
  arrayGapY,
  arrayGapZ,
  onArrayGapXChange,
  onArrayGapYChange,
  onArrayGapZChange,
  anchorMode,
  onAnchorModeChange,
  onApplyAll,
  onApplySelected,
  modelCount,
  selectedModelCount,
  isApplying = false,
}: ArrangePanelProps) {
  const [expanded, setExpanded] = React.useState(true);

  const clampCount = React.useCallback((value: number) => Math.min(64, Math.max(1, Math.round(value))), []);
  const clampGap = React.useCallback((value: number) => Math.min(120, Math.max(0, Math.round(value))), []);

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
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Arrange</h3>
          </>
        )}
        right={(
          <div className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5" style={{ borderColor: 'var(--border-subtle)' }}>
            <LayoutGrid className="w-3 h-3" style={{ color: 'var(--accent)' }} />
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{modelCount} model{modelCount === 1 ? '' : 's'}</span>
          </div>
        )}
      />

      {expanded && (
        <div className="px-2.5 pb-2.5 space-y-2">
          <div className="rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="ui-meta mb-1" style={{ color: 'var(--text-muted)' }}>Layout mode</div>
            <div className="grid grid-cols-2 gap-1">
              <button
                type="button"
                className="ui-button ui-button-secondary !h-8 text-[11px]"
                onClick={() => onLayoutModeChange('auto')}
                disabled={isApplying}
                style={layoutMode === 'auto'
                  ? {
                      borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 30%)',
                      background: 'color-mix(in srgb, var(--accent), var(--surface-1) 85%)',
                      color: 'var(--text-strong)',
                    }
                  : undefined}
              >
                Auto
              </button>
              <button
                type="button"
                className="ui-button ui-button-secondary !h-8 text-[11px]"
                onClick={() => onLayoutModeChange('array')}
                disabled={isApplying}
                style={layoutMode === 'array'
                  ? {
                      borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 30%)',
                      background: 'color-mix(in srgb, var(--accent), var(--surface-1) 85%)',
                      color: 'var(--text-strong)',
                    }
                  : undefined}
              >
                Array
              </button>
            </div>
          </div>

          {layoutMode === 'auto' ? (
          <div className="rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <label className="ui-meta" style={{ color: 'var(--text-muted)' }}>Spacing (mm)</label>
            <NumberInput
              value={spacingMm}
              onChange={(next) => {
                if (next >= 2 && next <= 120) {
                  onSpacingMmChange(next);
                }
              }}
              disabled={isApplying}
              className="ui-input mt-1 w-full !h-8 px-2 text-sm no-spinners"
            />
          </div>

          ) : (
            <div className="rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
              <div className="grid grid-cols-[24px_minmax(0,1fr)_minmax(0,1fr)] gap-1 items-center text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--text-muted)' }}>
                <span />
                <span className="text-center">Count</span>
                <span className="text-center">Gap</span>
              </div>

              {([
                ['X', arrayCountX, onArrayCountXChange, arrayGapX, onArrayGapXChange],
                ['Y', arrayCountY, onArrayCountYChange, arrayGapY, onArrayGapYChange],
                ['Z', arrayCountZ, onArrayCountZChange, arrayGapZ, onArrayGapZChange],
              ] as const).map(([axis, countValue, onCountChange, gapValue, onGapChange]) => (
                <div key={axis} className="grid grid-cols-[24px_minmax(0,1fr)_minmax(0,1fr)] gap-1 items-center mb-1 last:mb-0 min-w-0">
                  <span className="text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>{axis}:</span>
                  <MiniStepperField
                    value={countValue}
                    onChange={(next) => onCountChange(clampCount(next))}
                    min={1}
                    max={64}
                    disabled={isApplying}
                  />
                  <MiniStepperField
                    value={gapValue}
                    onChange={(next) => onGapChange(clampGap(next))}
                    min={0}
                    max={120}
                    disabled={isApplying}
                  />
                </div>
              ))}
            </div>
          )}

          <div className="rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="ui-meta" style={{ color: 'var(--text-muted)' }}>Placement anchor</div>
            <Select
              value={anchorMode}
              onChange={(e) => onAnchorModeChange(e.target.value as ArrangeAnchorMode)}
              disabled={isApplying}
              className="mt-1 w-full !h-8 px-2 text-xs"
            >
              <option value="center">Center</option>
              <option value="front_left">Front Left</option>
              <option value="front_right">Front Right</option>
              <option value="back_left">Back Left</option>
              <option value="back_right">Back Right</option>
            </Select>
          </div>

          {layoutMode === 'auto' && (
            <button
              type="button"
              className="w-full rounded-md border px-2 py-2 text-left transition-colors disabled:opacity-60"
              style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
              onClick={() => onAllowRotateOnZChange(!allowRotateOnZ)}
              disabled={isApplying}
              title="Allow auto-arrange to rotate models by 90° on Z when beneficial"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <RotateCw className="h-3.5 w-3.5" style={{ color: 'var(--accent)' }} />
                  <span className="text-xs font-medium" style={{ color: 'var(--text-strong)' }}>Allow Z-rotation</span>
                </div>
                <span
                  className="rounded-full border px-2 py-0.5 text-[10px]"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    color: allowRotateOnZ ? 'var(--accent)' : 'var(--text-muted)',
                    background: allowRotateOnZ ? 'color-mix(in srgb, var(--accent), transparent 88%)' : 'transparent',
                  }}
                >
                  {allowRotateOnZ ? 'ON' : 'OFF'}
                </span>
              </div>
            </button>
          )}

          <div className="grid grid-cols-2 gap-2">
            <Button
              onClick={onApplyAll}
              variant="accent"
              size="sm"
              className="w-full !h-8 text-[11px]"
              disabled={modelCount <= 1 || isApplying}
              title={modelCount <= 1 ? 'Need at least 2 visible models to arrange' : 'Arrange all visible models'}
            >
              {isApplying ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Arranging…
                </span>
              ) : (
                'Arrange All'
              )}
            </Button>

            <Button
              onClick={onApplySelected}
              variant="secondary"
              size="sm"
              className="w-full !h-8 text-[11px]"
              disabled={selectedModelCount <= 1 || isApplying}
              title={selectedModelCount <= 1 ? 'Select at least 2 visible models to arrange' : 'Arrange selected models only'}
            >
              {isApplying ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Arranging…
                </span>
              ) : (
                'Arrange Selected'
              )}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
