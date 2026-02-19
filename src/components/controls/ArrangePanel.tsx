import React from 'react';
import { LayoutGrid, Loader2, RotateCw } from 'lucide-react';
import { NumberInput } from '@/components/ui/NumberInput';
import { Button, Card, CardHeader, IconButton, Select } from '@/components/ui/primitives';

export type ArrangeAnchorMode = 'center' | 'front_left' | 'front_right' | 'back_left' | 'back_right';

interface ArrangePanelProps {
  spacingMm: number;
  onSpacingMmChange: (value: number) => void;
  allowRotateOnZ: boolean;
  onAllowRotateOnZChange: (value: boolean) => void;
  anchorMode: ArrangeAnchorMode;
  onAnchorModeChange: (value: ArrangeAnchorMode) => void;
  onApplyAll: () => void;
  onApplySelected: () => void;
  modelCount: number;
  selectedModelCount: number;
  isApplying?: boolean;
}

export function ArrangePanel({
  spacingMm,
  onSpacingMmChange,
  allowRotateOnZ,
  onAllowRotateOnZChange,
  anchorMode,
  onAnchorModeChange,
  onApplyAll,
  onApplySelected,
  modelCount,
  selectedModelCount,
  isApplying = false,
}: ArrangePanelProps) {
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
