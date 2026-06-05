import React from 'react';
import { Droplets } from 'lucide-react';
import type { HollowMode, OpenFace } from '@/utils/meshHollowing';
import { Card, CardHeader, IconButton, Select } from '@/components/ui/primitives';
import { ScrollableNumberField } from '@/components/ui/scrollableNumberField';

export interface HollowingPanelState {
  mode: HollowMode;
  voxelResolution: number;
  shellThicknessMm: number;
  infillCellMm: number;
  infillBeamRadiusMm: number;
  openFace: OpenFace;
}

interface HollowingPanelProps {
  state: HollowingPanelState;
  onStateChange: (next: HollowingPanelState) => void;
  onReset: () => void;
  onApply: () => void;
  isApplying?: boolean;
  isPreviewing?: boolean;
  canApply?: boolean;
  canReset?: boolean;
  shellFaceSelectionPending?: boolean;
}

export function HollowingPanel({
  state,
  onStateChange,
  onReset,
  onApply,
  isApplying = false,
  isPreviewing = false,
  canApply = true,
  canReset = true,
  shellFaceSelectionPending = false,
}: HollowingPanelProps) {
  const [expanded, setExpanded] = React.useState(true);

  const setState = React.useCallback((patch: Partial<HollowingPanelState>) => {
    onStateChange({ ...state, ...patch });
  }, [onStateChange, state]);

  const clampInt = React.useCallback((value: number, min: number, max: number) => {
    const safe = Number.isFinite(value) ? value : min;
    return Math.min(max, Math.max(min, Math.round(safe)));
  }, []);

  const clampFloat = React.useCallback((value: number, min: number, max: number, decimals = 1) => {
    const safe = Number.isFinite(value) ? value : min;
    const rounded = Number(safe.toFixed(decimals));
    return Math.min(max, Math.max(min, rounded));
  }, []);

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
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Hollowing</h3>
          </>
        )}
        right={(
            <div className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5" style={{ borderColor: 'var(--border-subtle)' }}>
            <Droplets className="w-3 h-3" style={{ color: 'var(--accent)' }} />
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              {state.mode === 'shell_open_face'
                ? 'Open Face'
                : state.mode === 'infill'
                  ? 'Infill'
                  : 'Cavity'}
            </span>
          </div>
        )}
      />

      {expanded && (
        <div className="px-2 pb-2 space-y-2 sm:px-2.5 sm:pb-2.5">
          <div className="rounded-md border p-2 space-y-1.5" style={accentCardStyle}>
            <div className="ui-meta" style={{ color: 'var(--text-muted)' }}>Mode</div>
            <div className="grid grid-cols-3 gap-1">
              <button
                type="button"
                className="ui-button ui-button-secondary !h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
                onClick={() => setState({ mode: 'cavity' })}
                style={state.mode === 'cavity' ? activeModeStyle : undefined}
                disabled={isApplying}
              >
                Cavity
              </button>
              <button
                type="button"
                className="ui-button ui-button-secondary !h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
                onClick={() => setState({ mode: 'infill' })}
                style={state.mode === 'infill' ? activeModeStyle : undefined}
                disabled={isApplying}
              >
                Infill
              </button>
              <button
                type="button"
                className="ui-button ui-button-secondary !h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
                onClick={() => setState({ mode: 'shell_open_face' })}
                style={state.mode === 'shell_open_face' ? activeModeStyle : undefined}
                disabled
                title="Work in Progress"
              >
                Shell
              </button>
            </div>
          </div>

          <div className="rounded-md border p-2 space-y-1.5" style={panelCardStyle}>
            <label className="ui-meta block" style={{ color: 'var(--text-muted)' }}>Voxel Resolution</label>
            <ScrollableNumberField
              value={state.voxelResolution}
              onChange={(value) => setState({ voxelResolution: clampInt(value, 24, 192) })}
              min={24}
              max={192}
              step={1}
              unit="vox"
              ariaLabel="Voxel resolution"
              disabled={isApplying}
              className="mt-1"
            />
          </div>

          <div className="rounded-md border p-2 space-y-1.5" style={panelCardStyle}>
            <label className="ui-meta block" style={{ color: 'var(--text-muted)' }}>Shell Thickness</label>
            <ScrollableNumberField
              value={state.shellThicknessMm}
              onChange={(value) => setState({ shellThicknessMm: clampFloat(value, 0.2, 10, 1) })}
              min={0.2}
              max={10}
              step={0.1}
              unit="mm"
              ariaLabel="Shell thickness in millimeters"
              disabled={isApplying}
              className="mt-1"
            />
          </div>

          {state.mode === 'infill' && (
            <>
              <div className="rounded-md border p-2 space-y-1.5" style={panelCardStyle}>
                <label className="ui-meta block" style={{ color: 'var(--text-muted)' }}>Cell Size</label>
                <ScrollableNumberField
                  value={state.infillCellMm}
                  onChange={(value) => setState({ infillCellMm: clampFloat(value, 3, 24, 1) })}
                  min={3}
                  max={24}
                  step={0.5}
                  unit="mm"
                  ariaLabel="Infill cell size in millimeters"
                  disabled={isApplying}
                  className="mt-1"
                />
              </div>

              <div className="rounded-md border p-2 space-y-1.5" style={panelCardStyle}>
                <label className="ui-meta block" style={{ color: 'var(--text-muted)' }}>Beam Radius</label>
                <ScrollableNumberField
                  value={state.infillBeamRadiusMm}
                  onChange={(value) => setState({ infillBeamRadiusMm: clampFloat(value, 0.3, 3, 2) })}
                  min={0.3}
                  max={3}
                  step={0.05}
                  unit="mm"
                  ariaLabel="Infill beam radius in millimeters"
                  disabled={isApplying}
                  className="mt-1"
                />
              </div>
            </>
          )}

          {state.mode === 'shell_open_face' && (
            <div className="rounded-md border p-2" style={panelCardStyle}>
              <label className="ui-meta block" style={{ color: 'var(--text-muted)' }}>Open Face</label>
              <Select
                className="mt-1 w-full !h-8 px-2 text-xs"
                value={state.openFace}
                onChange={(e) => setState({ openFace: e.target.value as OpenFace })}
                disabled={isApplying}
              >
                <option value="x_min">X Min</option>
                <option value="x_max">X Max</option>
                <option value="y_min">Y Min</option>
                <option value="y_max">Y Max</option>
                <option value="z_min">Z Min</option>
                <option value="z_max">Z Max</option>
              </Select>

              {shellFaceSelectionPending && (
                <p className="mt-1.5 text-[11px] leading-tight" style={{ color: 'var(--text-muted)' }}>
                  Click the face you want to open in the scene.
                </p>
              )}
            </div>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              className="ui-button ui-button-secondary flex-1 !min-h-8 px-1.5 py-1 text-[10px] sm:text-[11px] whitespace-normal text-center leading-tight disabled:opacity-60"
              onClick={onReset}
              disabled={isApplying || isPreviewing || !canReset}
            >
              Reset
            </button>

            <button
              type="button"
              className="ui-button ui-button-accent flex-1 !min-h-8 px-1.5 py-1 text-[10px] sm:text-[11px] whitespace-normal text-center leading-tight disabled:opacity-60"
              onClick={onApply}
              disabled={isApplying || isPreviewing || !canApply}
            >
              {isApplying ? 'Applying...' : isPreviewing ? (
                <span className="inline-flex items-center justify-center gap-1.5">
                  <svg
                    className="h-3 w-3 animate-spin"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                  >
                    <circle
                      cx="12"
                      cy="12"
                      r="9"
                      stroke="currentColor"
                      strokeOpacity="0.25"
                      strokeWidth="3"
                    />
                    <path
                      d="M21 12a9 9 0 0 0-9-9"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                    />
                  </svg>
                  <span>Updating</span>
                </span>
              ) : 'Apply'}
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}
