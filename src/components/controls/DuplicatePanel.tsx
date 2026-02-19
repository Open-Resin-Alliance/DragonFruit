import React from 'react';
import { ChevronDown, ChevronUp, CopyPlus, Loader2, Minus, Plus } from 'lucide-react';
import { NumberInput } from '@/components/ui/NumberInput';
import { Button, Card, CardHeader, IconButton } from '@/components/ui/primitives';

export type DuplicateLayoutMode = 'auto' | 'array';

interface DuplicatePanelProps {
  activeModelName: string | null;
  layoutMode: DuplicateLayoutMode;
  onLayoutModeChange: (value: DuplicateLayoutMode) => void;
  totalCopies: number;
  onTotalCopiesChange: (value: number) => void;
  spacingMm: number;
  onSpacingMmChange: (value: number) => void;
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
  onConfirm: () => void;
  onFillPlate: () => void;
  previewCount: number;
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

export function DuplicatePanel({
  activeModelName,
  layoutMode,
  onLayoutModeChange,
  totalCopies,
  onTotalCopiesChange,
  spacingMm,
  onSpacingMmChange,
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
  onConfirm,
  onFillPlate,
  previewCount,
  isApplying = false,
}: DuplicatePanelProps) {
  const [expanded, setExpanded] = React.useState(true);
  const hasSelection = !!activeModelName;

  const sanitizeNumber = React.useCallback((value: number, fallback: number) => {
    return Number.isFinite(value) ? value : fallback;
  }, []);

  const setClampedCopies = React.useCallback((value: number) => {
    const next = sanitizeNumber(value, 1);
    onTotalCopiesChange(Math.min(128, Math.max(1, Math.round(next))));
  }, [onTotalCopiesChange, sanitizeNumber]);

  const setClampedSpacing = React.useCallback((value: number) => {
    const next = sanitizeNumber(value, 0);
    onSpacingMmChange(Math.min(120, Math.max(0, Math.round(next))));
  }, [onSpacingMmChange, sanitizeNumber]);

  const setClampedArrayCount = React.useCallback((setter: (value: number) => void, value: number) => {
    const next = sanitizeNumber(value, 1);
    setter(Math.min(32, Math.max(1, Math.round(next))));
  }, [sanitizeNumber]);

  const setClampedArrayGap = React.useCallback((setter: (value: number) => void, value: number) => {
    const next = sanitizeNumber(value, 0);
    setter(Math.min(120, Math.max(0, Math.round(next))));
  }, [sanitizeNumber]);

  const displayTotalCopies = Math.max(1, layoutMode === 'array'
    ? (Math.max(1, Math.round(arrayCountX)) * Math.max(1, Math.round(arrayCountY)) * Math.max(1, Math.round(arrayCountZ)))
    : Math.max(1, Math.round(totalCopies)));

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
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Duplicate</h3>
          </>
        )}
        right={(
          <div className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5" style={{ borderColor: 'var(--border-subtle)' }}>
            <CopyPlus className="w-3 h-3" style={{ color: 'var(--accent)' }} />
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>+{previewCount} preview</span>
          </div>
        )}
      />

      {expanded && (
        <div className="px-2.5 pb-2.5 space-y-2">
          <div className="rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="ui-meta" style={{ color: 'var(--text-muted)' }}>Selected model</div>
            <div className="mt-0.5 text-xs font-medium truncate" style={{ color: 'var(--text-strong)' }}>
              {activeModelName ?? 'Select a model first'}
            </div>
          </div>

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
                Auto layout
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
            <>
              <div className="rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <label className="ui-meta" style={{ color: 'var(--text-muted)' }}>Total copies</label>
                <div className="mt-1 flex items-center gap-1">
                  <IconButton
                    className="!h-8 !w-8 !p-0"
                    onClick={() => setClampedCopies(totalCopies - 1)}
                    disabled={totalCopies <= 1 || isApplying}
                    title="Decrease total copies"
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </IconButton>

                  <NumberInput
                    value={totalCopies}
                    onChange={setClampedCopies}
                    onWheel={(e) => {
                      if (isApplying) return;
                      e.preventDefault();
                      setClampedCopies(totalCopies + (e.deltaY < 0 ? 1 : -1));
                    }}
                    disabled={isApplying}
                    className="ui-input h-8 flex-1 px-0 text-sm text-center tabular-nums font-semibold no-spinners"
                  />

                  <IconButton
                    className="!h-8 !w-8 !p-0"
                    onClick={() => setClampedCopies(totalCopies + 1)}
                    disabled={totalCopies >= 128 || isApplying}
                    title="Increase total copies"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </IconButton>
                </div>
              </div>

              <div className="rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <label className="ui-meta" style={{ color: 'var(--text-muted)' }}>Arrange distance (mm)</label>
                <div className="mt-1 flex items-center gap-1">
                  <IconButton
                    className="!h-8 !w-8 !p-0"
                    onClick={() => setClampedSpacing(spacingMm - 1)}
                    disabled={spacingMm <= 0 || isApplying}
                    title="Decrease spacing"
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </IconButton>

                  <NumberInput
                    value={spacingMm}
                    onChange={setClampedSpacing}
                    onWheel={(e) => {
                      if (isApplying) return;
                      e.preventDefault();
                      setClampedSpacing(spacingMm + (e.deltaY < 0 ? 1 : -1));
                    }}
                    disabled={isApplying}
                    className="ui-input h-8 flex-1 px-0 text-sm text-center tabular-nums font-semibold no-spinners"
                  />

                  <IconButton
                    className="!h-8 !w-8 !p-0"
                    onClick={() => setClampedSpacing(spacingMm + 1)}
                    disabled={spacingMm >= 120 || isApplying}
                    title="Increase spacing"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </IconButton>
                </div>
              </div>
            </>
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
                    onChange={(next) => setClampedArrayCount(onCountChange, next)}
                    min={1}
                    max={32}
                    disabled={isApplying}
                  />
                  <MiniStepperField
                    value={gapValue}
                    onChange={(next) => setClampedArrayGap(onGapChange, next)}
                    min={0}
                    max={120}
                    disabled={isApplying}
                  />
                </div>
              ))}
            </div>
          )}

          <div className="rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <label className="ui-meta" style={{ color: 'var(--text-muted)' }}>Total copies</label>
            <div className="mt-0.5 text-center text-sm font-semibold tabular-nums" style={{ color: 'var(--text-strong)' }}>
              {displayTotalCopies}
            </div>
          </div>

          <Button
            onClick={onConfirm}
            variant="accent"
            size="sm"
            className="w-full !h-8 text-[11px]"
            disabled={!hasSelection || previewCount <= 0 || isApplying}
            title={!hasSelection ? 'Select a model to duplicate' : 'Generate duplicates from preview'}
          >
            {isApplying ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Duplicating…
              </span>
            ) : (
              `Confirm Duplicate (${Math.max(0, previewCount)} new)`
            )}
          </Button>

          <Button
            onClick={onFillPlate}
            variant="secondary"
            size="sm"
            className="w-full !h-8 text-[11px]"
            disabled={!hasSelection || isApplying || layoutMode !== 'auto'}
            title={
              layoutMode !== 'auto'
                ? 'Fill Plate is available in Auto layout mode'
                : (!hasSelection ? 'Select a model to fill the plate' : 'Set copies to fill current plate capacity')
            }
          >
            Fill Plate
          </Button>
        </div>
      )}
    </Card>
  );
}
