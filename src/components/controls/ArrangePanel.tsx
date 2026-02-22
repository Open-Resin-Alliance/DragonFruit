import React from 'react';
import { LayoutGrid, Loader2, Minus, Plus, RotateCw } from 'lucide-react';
import { NumberInput } from '@/components/ui/NumberInput';
import { Button, Card, CardHeader, IconButton, Select } from '@/components/ui/primitives';

export type ArrangeAnchorMode = 'center' | 'front_left' | 'front_right' | 'back_left' | 'back_right';
export type ArrangeLayoutMode = 'auto' | 'array';
export type ArrangePrecisionMode = 'standard' | 'high_precision';

interface ArrangePanelProps {
  precisionMode: ArrangePrecisionMode;
  onPrecisionModeChange: (value: ArrangePrecisionMode) => void;
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
    <div className="min-w-0" onWheel={(e) => {
      if (disabled) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? 1 : -1;
      apply(clamped + delta);
    }}>
      <NumberInput
        value={clamped}
        onChange={apply}
        min={min}
        max={max}
        step={1}
        disabled={disabled}
        className="ui-input h-8 w-full min-w-0 pl-1.5 pr-5 text-xs text-center no-spinners"
      />
    </div>
  );
}

export function ArrangePanel({
  precisionMode,
  onPrecisionModeChange,
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
  const panelCardStyle: React.CSSProperties = {
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

  const sanitizeNumber = React.useCallback((value: number, fallback: number) => (
    Number.isFinite(value) ? value : fallback
  ), []);
  const setClampedSpacing = React.useCallback((value: number) => {
    const next = sanitizeNumber(value, 0.5);
    const rounded = Number((Math.round(next * 10) / 10).toFixed(1));
    onSpacingMmChange(Math.min(5, Math.max(0, rounded)));
  }, [onSpacingMmChange, sanitizeNumber]);

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
        <div className="px-2 pb-2 space-y-2 sm:px-2.5 sm:pb-2.5">
          <div className="rounded-md border p-2" style={accentCardStyle}>
            <div className="ui-meta mb-1" style={{ color: 'var(--text-muted)' }}>Layout mode</div>
            <div className="grid grid-cols-2 gap-1">
              <button
                type="button"
                className="ui-button ui-button-secondary !h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
                onClick={() => onLayoutModeChange('auto')}
                disabled={isApplying}
                style={layoutMode === 'auto' ? activeModeStyle : undefined}
              >
                Auto
              </button>
              <button
                type="button"
                className="ui-button ui-button-secondary !h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
                onClick={() => onLayoutModeChange('array')}
                disabled={isApplying}
                style={layoutMode === 'array' ? activeModeStyle : undefined}
              >
                Manual
              </button>
            </div>
          </div>

          {layoutMode === 'auto' && (
            <div className="rounded-md border p-2" style={accentCardStyle}>
              <div className="ui-meta mb-1" style={{ color: 'var(--text-muted)' }}>Arrange mode</div>
              <div className="grid grid-cols-2 gap-1">
                <button
                  type="button"
                  className="ui-button ui-button-secondary !h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
                  onClick={() => onPrecisionModeChange('standard')}
                  disabled={isApplying}
                  style={precisionMode === 'standard' ? activeModeStyle : undefined}
                  title="Current arrange algorithm"
                >
                  Standard
                </button>
                <button
                  type="button"
                  className="ui-button ui-button-secondary !h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
                  onClick={() => {
                    onPrecisionModeChange('high_precision');
                    onAllowRotateOnZChange(true);
                  }}
                  disabled={isApplying}
                  style={precisionMode === 'high_precision' ? activeModeStyle : undefined}
                  title="Hull-based SAT packing for tighter fit"
                >
                  High-Precision
                </button>
              </div>
            </div>
          )}

          {layoutMode === 'auto' ? (
          <div className="rounded-md border p-2" style={panelCardStyle}>
            <label className="ui-meta" style={{ color: 'var(--text-muted)' }}>Arrange distance (mm)</label>
            <div className="mt-1 flex min-w-0 items-center gap-1">
              <IconButton
                className="!h-8 !w-8 shrink-0 !p-0"
                onClick={() => setClampedSpacing(spacingMm - 0.1)}
                disabled={spacingMm <= 0 || isApplying}
                title="Decrease spacing"
              >
                <Minus className="h-3.5 w-3.5" />
              </IconButton>

              <NumberInput
                value={spacingMm}
                onChange={setClampedSpacing}
                showStepper={false}
                onWheel={(e) => {
                  if (isApplying) return;
                  e.preventDefault();
                  setClampedSpacing(spacingMm + (e.deltaY < 0 ? 0.1 : -0.1));
                }}
                disabled={isApplying}
                className="ui-input h-8 w-0 min-w-0 flex-1 px-0 text-xs sm:text-sm text-center tabular-nums font-semibold no-spinners"
              />

              <IconButton
                className="!h-8 !w-8 shrink-0 !p-0"
                onClick={() => setClampedSpacing(spacingMm + 0.1)}
                disabled={spacingMm >= 5 || isApplying}
                title="Increase spacing"
              >
                <Plus className="h-3.5 w-3.5" />
              </IconButton>
            </div>
          </div>

          ) : (
            <div className="rounded-md border p-2" style={panelCardStyle}>
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

          <div className="rounded-md border p-2" style={panelCardStyle}>
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
              style={allowRotateOnZ ? accentCardStyle : panelCardStyle}
              onClick={() => onAllowRotateOnZChange(!allowRotateOnZ)}
              disabled={isApplying || precisionMode === 'high_precision'}
              title={precisionMode === 'high_precision'
                ? 'High-Precision mode requires Z-rotation and keeps it enabled'
                : 'Allow auto-arrange to rotate models by 90° on Z when beneficial'}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <RotateCw
                    className="h-3.5 w-3.5"
                    style={{ color: precisionMode === 'high_precision' ? 'var(--text-muted)' : 'var(--accent)' }}
                  />
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
                  {precisionMode === 'high_precision' ? 'ON (Required)' : (allowRotateOnZ ? 'ON' : 'OFF')}
                </span>
              </div>
            </button>
          )}

          <div className="grid grid-cols-2 gap-2">
            <Button
              onClick={onApplyAll}
              variant="primary"
              size="sm"
              className="w-full !min-h-8 px-1.5 py-1 text-[10px] sm:text-[11px] whitespace-normal text-center leading-tight"
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
              variant="accent"
              size="sm"
              className="w-full !min-h-8 px-1.5 py-1 text-[10px] sm:text-[11px] whitespace-normal text-center leading-tight"
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
