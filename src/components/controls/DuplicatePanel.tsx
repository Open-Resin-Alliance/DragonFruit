import React from 'react';
import { CopyPlus, Loader2, Minus, Plus } from 'lucide-react';
import { NumberInput } from '@/components/ui/NumberInput';
import { Button, Card, CardHeader, IconButton } from '@/components/ui/primitives';

interface DuplicatePanelProps {
  activeModelName: string | null;
  totalCopies: number;
  onTotalCopiesChange: (value: number) => void;
  spacingMm: number;
  onSpacingMmChange: (value: number) => void;
  onConfirm: () => void;
  previewCount: number;
  isApplying?: boolean;
}

export function DuplicatePanel({
  activeModelName,
  totalCopies,
  onTotalCopiesChange,
  spacingMm,
  onSpacingMmChange,
  onConfirm,
  previewCount,
  isApplying = false,
}: DuplicatePanelProps) {
  const [expanded, setExpanded] = React.useState(true);
  const hasSelection = !!activeModelName;

  const setClampedCopies = React.useCallback((value: number) => {
    onTotalCopiesChange(Math.min(64, Math.max(1, Math.round(value))));
  }, [onTotalCopiesChange]);

  const setClampedSpacing = React.useCallback((value: number) => {
    onSpacingMmChange(Math.min(120, Math.max(2, Math.round(value))));
  }, [onSpacingMmChange]);

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
                disabled={isApplying}
                className="ui-input h-8 flex-1 px-2 text-sm text-center no-spinners"
              />

              <IconButton
                className="!h-8 !w-8 !p-0"
                onClick={() => setClampedCopies(totalCopies + 1)}
                disabled={totalCopies >= 64 || isApplying}
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
                disabled={spacingMm <= 2 || isApplying}
                title="Decrease spacing"
              >
                <Minus className="h-3.5 w-3.5" />
              </IconButton>

              <NumberInput
                value={spacingMm}
                onChange={setClampedSpacing}
                disabled={isApplying}
                className="ui-input h-8 flex-1 px-2 text-sm text-center no-spinners"
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

          <Button
            onClick={onConfirm}
            variant="accent"
            size="sm"
            className="w-full !h-8 text-[11px]"
            disabled={!hasSelection || totalCopies <= 1 || isApplying}
            title={!hasSelection ? 'Select a model to duplicate' : 'Generate duplicates from preview'}
          >
            {isApplying ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Duplicating…
              </span>
            ) : (
              `Confirm Duplicate (${Math.max(0, totalCopies - 1)} new)`
            )}
          </Button>
        </div>
      )}
    </Card>
  );
}
