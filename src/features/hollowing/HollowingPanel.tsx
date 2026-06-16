import React from 'react';
import { Droplets } from 'lucide-react';
import type { HollowMode, InfillMode, OpenFace } from '@/utils/meshHollowing';
import { Card, CardHeader, IconButton, Select } from '@/components/ui/primitives';
import { ScrollableNumberField } from '@/components/ui/scrollableNumberField';

export interface HollowingPanelState {
  mode: HollowMode;
  voxelSizeMm: number;
  shellThicknessMm: number;
  infillMode: InfillMode;
  infillCellMm: number;
  infillBeamRadiusMm: number;
  openFace: OpenFace;
}

interface HollowingPanelProps {
  state: HollowingPanelState;
  onStateChange: (next: HollowingPanelState) => void;
  onReset: () => void;
  onResetSettings: () => void;
  onStartEdit: () => void;
  onDoneEdit: () => void;
  onClearEdit: () => void;
  onApply: () => void;
  isApplying?: boolean;
  isPreviewing?: boolean;
  isApplyingBlockers?: boolean;
  canApply?: boolean;
  canReset?: boolean;
  canEdit?: boolean;
  isEditMode?: boolean;
  isHollowingApplied?: boolean;
  shellFaceSelectionPending?: boolean;
}

export function HollowingPanel({
  state,
  onStateChange,
  onReset,
  onResetSettings,
  onStartEdit,
  onDoneEdit,
  onClearEdit,
  onApply,
  isApplying = false,
  isPreviewing = false,
  isApplyingBlockers = false,
  canApply = true,
  canReset = true,
  canEdit = true,
  isEditMode = false,
  isHollowingApplied = false,
  shellFaceSelectionPending = false,
}: HollowingPanelProps) {
  const [expanded, setExpanded] = React.useState(true);
  const minInfillCellMm = 3;
  const maxInfillCellMm = 24;
  const minInfillDiameterMm = 0.5;
  const maxInfillDiameterMm = 6.0;

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

  const infillDensityPct = React.useMemo(() => {
    const clampedCell = Math.min(maxInfillCellMm, Math.max(minInfillCellMm, state.infillCellMm));
    return clampFloat((minInfillCellMm * minInfillCellMm * 100) / (clampedCell * clampedCell), 1, 100, 0);
  }, [clampFloat, state.infillCellMm]);

  const infillDiameterMm = React.useMemo(() => (
    clampFloat(state.infillBeamRadiusMm * 2, minInfillDiameterMm, maxInfillDiameterMm, 2)
  ), [clampFloat, state.infillBeamRadiusMm]);

  const densityPctToCellMm = React.useCallback((densityPct: number) => {
    const clampedDensity = clampFloat(densityPct, 1, 100, 0);
    return clampFloat(minInfillCellMm / Math.sqrt(clampedDensity / 100), minInfillCellMm, maxInfillCellMm, 1);
  }, [clampFloat]);

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
              {state.mode === 'infill'
                  ? 'Infill'
                  : 'Cavity'}
            </span>
          </div>
        )}
      />

      {expanded && (
        <div className="px-2 pb-2 space-y-2 sm:px-2.5 sm:pb-2.5">
          {isEditMode ? (
            <div
              className="rounded-md border p-2 space-y-1.5 text-center min-h-[4.5rem] box-border"
              style={{
                borderColor: 'var(--accent-secondary-action-border)',
                background: 'var(--accent-secondary-action-bg-92)',
              }}
            >
              <div className="ui-meta font-semibold" style={{ color: 'var(--accent-secondary-action-color)' }}>Voxel Editing Mode</div>
              <div className="flex items-start justify-center min-h-8">
                <p className="text-[10px] leading-snug line-clamp-2" style={{ color: 'var(--text-muted)' }}>
                  Lasso to set blockers, <span style={{ color: 'var(--accent-secondary-action-color)', fontWeight: 600 }}>Alt+Lasso</span> to clear.<br /><span style={{ color: 'var(--accent-secondary-action-color)', fontWeight: 600 }}>Clear</span> to reset all, <span style={{ color: 'var(--accent-secondary-action-color)', fontWeight: 600 }}>Done</span> to apply.
                </p>
              </div>
            </div>
          ) : (
            <div className="rounded-md border p-2 space-y-1.5 min-h-[4.5rem] box-border" style={accentCardStyle}>
              <div className="ui-meta" style={{ color: 'var(--text-muted)' }}>Mode</div>
              <div className="grid grid-cols-2 gap-1 min-h-8">
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
              </div>
            </div>
          )}

          <div className="rounded-md border p-2 space-y-1.5" style={panelCardStyle}>
            <label className="ui-meta block" style={{ color: 'var(--text-muted)' }}>Voxel Size</label>
            <ScrollableNumberField
              value={state.voxelSizeMm}
              onChange={(value) => setState({ voxelSizeMm: clampFloat(value, 0.2, 10, 2) })}
              min={0.2}
              max={10}
              step={0.1}
              unit="mm"
              ariaLabel="Voxel size"
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
                <div className="ui-meta" style={{ color: 'var(--text-muted)' }}>Infill Type</div>
                <div className="grid grid-cols-2 gap-1">
                  <button
                    type="button"
                    className="ui-button ui-button-secondary !h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
                    onClick={() => setState({ infillMode: 'lattice' })}
                    style={state.infillMode === 'lattice' ? activeModeStyle : undefined}
                    disabled={isApplying}
                  >
                    Lattice
                  </button>
                  <button
                    type="button"
                    className="ui-button ui-button-secondary !h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
                    onClick={() => setState({ infillMode: 'pillar' })}
                    style={state.infillMode === 'pillar' ? activeModeStyle : undefined}
                    disabled={isApplying}
                  >
                    Pillar
                  </button>
                </div>
              </div>

              <div className="rounded-md border p-2 space-y-1.5" style={panelCardStyle}>
                <label className="ui-meta block" style={{ color: 'var(--text-muted)' }}>
                  {state.infillMode === 'pillar' ? 'Pillar Spacing' : 'Infill Density'}
                </label>
                <ScrollableNumberField
                  value={infillDensityPct}
                  onChange={(value) => setState({ infillCellMm: densityPctToCellMm(value) })}
                  min={1}
                  max={100}
                  step={1}
                  unit="%"
                  ariaLabel={state.infillMode === 'pillar' ? 'Pillar spacing percent' : 'Infill density percent'}
                  disabled={isApplying}
                  className="mt-1"
                />
              </div>

              <div className="rounded-md border p-2 space-y-1.5" style={panelCardStyle}>
                <label className="ui-meta block" style={{ color: 'var(--text-muted)' }}>Infill Diameter</label>
                <ScrollableNumberField
                  value={infillDiameterMm}
                  onChange={(value) => setState({ infillBeamRadiusMm: clampFloat(value / 2, minInfillDiameterMm / 2, maxInfillDiameterMm / 2, 2) })}
                  min={minInfillDiameterMm}
                  max={maxInfillDiameterMm}
                  step={0.1}
                  unit="mm"
                  ariaLabel="Infill diameter in millimeters"
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

          {isEditMode ? (
            <div className="flex gap-2">
              <button
                type="button"
                className="ui-button ui-button-secondary flex-1 !min-h-8 px-1.5 py-1 text-[10px] sm:text-[11px] whitespace-normal text-center leading-tight disabled:opacity-60"
                onClick={onClearEdit}
                disabled={isApplying || isPreviewing}
              >
                Clear
              </button>
              <button
                type="button"
                className="ui-button ui-button-accent flex-1 !min-h-8 px-1.5 py-1 text-[10px] sm:text-[11px] whitespace-normal text-center leading-tight disabled:opacity-60"
                onClick={onDoneEdit}
                disabled={isApplying || isPreviewing || isApplyingBlockers}
              >
                {isApplyingBlockers ? (
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
                    <span>Applying Blockers</span>
                  </span>
                ) : 'Done'}
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              {isHollowingApplied ? (
                <>
                  {canApply && (
                    <button
                      type="button"
                      className="ui-button ui-button-secondary flex-1 !min-h-8 px-1.5 py-1 text-[10px] sm:text-[11px] whitespace-normal text-center leading-tight disabled:opacity-60"
                      onClick={onResetSettings}
                      disabled={isApplying || isPreviewing}
                    >
                      Reset
                    </button>
                  )}
                  <button
                    type="button"
                    className="ui-button ui-button-accent flex-1 !min-h-8 px-1.5 py-1 text-[10px] sm:text-[11px] whitespace-normal text-center leading-tight disabled:opacity-60"
                    onClick={onReset}
                    disabled={isApplying || isPreviewing}
                  >
                    Remove Hollowing
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="ui-button ui-button-secondary flex-1 !min-h-8 px-1.5 py-1 text-[10px] sm:text-[11px] whitespace-normal text-center leading-tight disabled:opacity-60"
                    onClick={onStartEdit}
                    disabled={isApplying || isPreviewing || !canEdit}
                  >
                    Blockers
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
                </>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
