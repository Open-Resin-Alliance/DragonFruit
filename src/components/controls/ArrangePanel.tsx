import React from 'react';
import { LayoutGrid, Loader2 } from 'lucide-react';
import { NumberInput } from '@/components/ui/NumberInput';
import { Button, Card, CardHeader, IconButton } from '@/components/ui/primitives';

interface ArrangePanelProps {
  spacingMm: number;
  onSpacingMmChange: (value: number) => void;
  onApply: () => void;
  modelCount: number;
  isApplying?: boolean;
}

export function ArrangePanel({ spacingMm, onSpacingMmChange, onApply, modelCount, isApplying = false }: ArrangePanelProps) {
  const [expanded, setExpanded] = React.useState(true);

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

          <Button
            onClick={onApply}
            variant="accent"
            size="sm"
            className="w-full !h-8 text-[11px]"
            disabled={modelCount <= 1 || isApplying}
            title={modelCount <= 1 ? 'Need at least 2 models to arrange' : 'Arrange visible models in grid'}
          >
            {isApplying ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Arranging…
              </span>
            ) : (
              'Auto Arrange Models'
            )}
          </Button>
        </div>
      )}
    </Card>
  );
}
