import React from 'react';
import { CopyPlus, Loader2 } from 'lucide-react';
import { Button, Card, CardHeader, IconButton } from '@/components/ui/primitives';
import { ScrollableNumberField } from '@/components/ui/scrollableNumberField';
import type { ArrangePrecisionMode } from '@/components/controls/ArrangePanel';

export type DuplicateLayoutMode = 'auto' | 'array';

interface DuplicatePanelProps {
  activeModelName: string | null;
  layoutMode: DuplicateLayoutMode;
  onLayoutModeChange: (value: DuplicateLayoutMode) => void;
  precisionMode: ArrangePrecisionMode;
  onPrecisionModeChange: (value: ArrangePrecisionMode) => void;
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

export function DuplicatePanel({
  activeModelName,
  layoutMode,
  onLayoutModeChange,
  precisionMode,
  onPrecisionModeChange,
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
  const panelDisabled = !hasSelection || isApplying;

  const panelCardStyle: React.CSSProperties = {
    borderColor: 'var(--border-subtle)',
    background: 'var(--surface-1)',
  };

  const panelCardStyleDisabled: React.CSSProperties = {
    borderColor: 'color-mix(in srgb, var(--border-subtle), black 10%)',
    background: 'color-mix(in srgb, var(--surface-1), black 8%)',
  };

  const accentCardStyle: React.CSSProperties = {
    borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 76%)',
    background: 'color-mix(in srgb, var(--accent), var(--surface-1) 95%)',
  };

  const accentCardStyleDisabled: React.CSSProperties = {
    borderColor: 'color-mix(in srgb, var(--border-subtle), black 10%)',
    background: 'color-mix(in srgb, var(--surface-1), black 6%)',
  };

  const activeModeStyle: React.CSSProperties = {
    borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 30%)',
    background: 'color-mix(in srgb, var(--accent), var(--surface-1) 85%)',
    color: 'var(--text-strong)',
  };

  const disabledButtonStyle: React.CSSProperties = {
    background: 'color-mix(in srgb, var(--surface-1), black 8%)',
    borderColor: 'color-mix(in srgb, var(--border-subtle), black 10%)',
    color: 'color-mix(in srgb, var(--text-muted), var(--surface-2) 18%)',
    boxShadow: 'none',
  };

  const sanitizeNumber = React.useCallback((value: number, fallback: number) => {
    return Number.isFinite(value) ? value : fallback;
  }, []);

  const setClampedCopies = React.useCallback((value: number) => {
    const next = sanitizeNumber(value, 1);
    onTotalCopiesChange(Math.min(128, Math.max(1, Math.round(next))));
  }, [onTotalCopiesChange, sanitizeNumber]);

  const setClampedSpacing = React.useCallback((value: number) => {
    const next = sanitizeNumber(value, 0.5);
    const rounded = Number((Math.round(next * 10) / 10).toFixed(1));
    onSpacingMmChange(Math.min(5, Math.max(0, rounded)));
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
  const isHighPrecisionFillMode = layoutMode === 'auto' && precisionMode === 'high_precision';

  const isConfirmDuplicateDisabled = panelDisabled || previewCount <= 0 || displayTotalCopies <= 1;
  const isFillPlateDisabled = panelDisabled || layoutMode !== 'auto';

  return (
    <Card
      className={!hasSelection ? 'opacity-70' : undefined}
      style={!hasSelection
        ? {
            borderColor: 'color-mix(in srgb, var(--border-subtle), black 8%)',
            background: 'color-mix(in srgb, var(--surface-0), black 8%)',
          }
        : undefined}
    >
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
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              {isHighPrecisionFillMode ? 'SAT fill' : `+${previewCount} preview`}
            </span>
          </div>
        )}
      />

      {expanded && (
        <div className="px-2 pb-2 space-y-2 sm:px-2.5 sm:pb-2.5">
          <div className="rounded-md border p-2" style={panelDisabled ? panelCardStyleDisabled : panelCardStyle}>
            <div className="text-xs font-medium truncate text-center" style={{ color: 'var(--text-strong)' }}>
              {activeModelName ?? 'Select a model first'}
            </div>
          </div>

          <div className="rounded-md border p-2" style={panelDisabled ? accentCardStyleDisabled : accentCardStyle}>
            <div className="ui-meta mb-1" style={{ color: 'var(--text-muted)' }}>Layout Mode</div>
            <div className="grid grid-cols-2 gap-1 min-w-0">
              <button
                type="button"
                className="ui-button ui-button-secondary !h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
                onClick={() => onLayoutModeChange('auto')}
                disabled={panelDisabled}
                style={panelDisabled ? undefined : (layoutMode === 'auto' ? activeModeStyle : undefined)}
              >
                Auto Layout 
              </button>
              <button
                type="button"
                className="ui-button ui-button-secondary !h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
                onClick={() => onLayoutModeChange('array')}
                disabled={panelDisabled}
                style={panelDisabled ? undefined : (layoutMode === 'array' ? activeModeStyle : undefined)}
              >
                Array
              </button>
            </div>
          </div>

          {layoutMode === 'auto' && (
            <div className="rounded-md border p-2" style={panelDisabled ? accentCardStyleDisabled : accentCardStyle}>
              <div className="ui-meta mb-1" style={{ color: 'var(--text-muted)' }}>Precision Mode</div>
              <div className="grid grid-cols-2 gap-1 min-w-0">
                <button
                  type="button"
                  className="ui-button ui-button-secondary !h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
                  onClick={() => onPrecisionModeChange('standard')}
                  disabled={panelDisabled}
                  style={panelDisabled ? undefined : (precisionMode === 'standard' ? activeModeStyle : undefined)}
                  title="Current duplicate auto-layout algorithm"
                >
                  Standard
                </button>
                <button
                  type="button"
                  className="ui-button ui-button-secondary !h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
                  onClick={() => onPrecisionModeChange('high_precision')}
                  disabled={panelDisabled}
                  style={panelDisabled ? undefined : (precisionMode === 'high_precision' ? activeModeStyle : undefined)}
                  title="Use SAT-based fill-plate packing"
                >
                  High-Precision
                </button>
              </div>
            </div>
          )}

          {layoutMode === 'auto' ? (
            <>
              {precisionMode !== 'high_precision' && (
                <div className="rounded-md border p-2" style={panelDisabled ? panelCardStyleDisabled : panelCardStyle}>
                  <label className="ui-meta" style={{ color: 'var(--text-muted)' }}>Total Copies</label>
                  <ScrollableNumberField
                    className="mt-1"
                    value={totalCopies}
                    onChange={setClampedCopies}
                    min={1}
                    max={128}
                    step={1}
                    disabled={panelDisabled}
                    ariaLabel="Total copies"
                    decreaseTitle="Decrease total copies"
                    increaseTitle="Increase total copies"
                  />
                </div>
              )}

              <div className="rounded-md border p-2" style={panelDisabled ? panelCardStyleDisabled : panelCardStyle}>
                <label className="ui-meta" style={{ color: 'var(--text-muted)' }}>Arrange Distance</label>
                <ScrollableNumberField
                  className="mt-1"
                  value={spacingMm}
                  onChange={setClampedSpacing}
                  min={0}
                  max={5}
                  step={0.1}
                  unit="mm"
                  disabled={panelDisabled}
                  ariaLabel="Arrange distance"
                  decreaseTitle="Decrease spacing"
                  increaseTitle="Increase spacing"
                />
              </div>
            </>
          ) : (
            <div className="rounded-md border p-2" style={panelDisabled ? panelCardStyleDisabled : panelCardStyle}>
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
                  <ScrollableNumberField
                    value={countValue}
                    onChange={(next) => setClampedArrayCount(onCountChange, next)}
                    min={1}
                    max={32}
                    step={1}
                    disabled={panelDisabled}
                    ariaLabel={`${axis} array count`}
                    decreaseTitle={`Decrease ${axis} count`}
                    increaseTitle={`Increase ${axis} count`}
                  />
                  <ScrollableNumberField
                    value={gapValue}
                    onChange={(next) => setClampedArrayGap(onGapChange, next)}
                    min={0}
                    max={120}
                    step={1}
                    unit="mm"
                    disabled={panelDisabled}
                    ariaLabel={`${axis} array gap`}
                    decreaseTitle={`Decrease ${axis} gap`}
                    increaseTitle={`Increase ${axis} gap`}
                  />
                </div>
              ))}
            </div>
          )}

          <Button
            onClick={onFillPlate}
            variant={isFillPlateDisabled ? 'secondary' : 'accent'}
            size="sm"
            className="w-full !h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
            disabled={isFillPlateDisabled}
            style={isFillPlateDisabled ? disabledButtonStyle : undefined}
            title={
              layoutMode !== 'auto'
                ? 'Fill Plate is available in Auto layout mode'
                : (!hasSelection
                  ? 'Select a model to fill the plate'
                  : (precisionMode === 'high_precision'
                    ? 'Compute SAT-packed duplicates that fit on the plate'
                    : 'Set copies to fill current plate capacity'))
            }
          >
            {isApplying && isHighPrecisionFillMode ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Filling Plate…
              </span>
            ) : (
              'Fill Plate'
            )}
          </Button>

          {!isHighPrecisionFillMode && (
            <Button
              onClick={onConfirm}
              variant={isConfirmDuplicateDisabled ? 'secondary' : 'primary'}
              size="sm"
              className="w-full !h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
              disabled={isConfirmDuplicateDisabled}
              style={isConfirmDuplicateDisabled ? disabledButtonStyle : undefined}
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
          )}
        </div>
      )}
    </Card>
  );
}
