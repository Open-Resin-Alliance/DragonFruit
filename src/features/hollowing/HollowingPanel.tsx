import React from 'react';
import { Droplets } from 'lucide-react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { HollowMode, InfillMode, OpenFace } from '@/utils/meshHollowing';
import { Button, Card, CardHeader, Select, Spinner } from '@/components/atoms';
import { PanelCollapseToggle } from '@/components/atoms/PanelCollapseToggle';
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
  canEdit = true,
  isEditMode = false,
  isHollowingApplied = false,
  shellFaceSelectionPending = false,
}: HollowingPanelProps) {
  const { _ } = useLingui();
  const [expanded, setExpanded] = React.useState(true);
  const minInfillCellMm = 3;
  const maxInfillCellMm = 24;
  const minInfillDiameterMm = 0.5;
  const maxInfillDiameterMm = 6.0;

  const setState = React.useCallback((patch: Partial<HollowingPanelState>) => {
    onStateChange({ ...state, ...patch });
  }, [onStateChange, state]);

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
            <PanelCollapseToggle expanded={expanded} onToggle={() => setExpanded((prev) => !prev)} />
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}><Trans>Hollowing</Trans></h3>
          </>
        )}
        right={(
            <div className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5" style={{ borderColor: 'var(--border-subtle)' }}>
            <Droplets className="w-3 h-3" style={{ color: 'var(--accent)' }} />
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              {state.mode === 'infill'
                  ? _(msg`Infill`)
                  : _(msg`Cavity`)}
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
              <div className="ui-meta font-semibold" style={{ color: 'var(--accent-secondary-action-color)' }}><Trans>Solid Areas</Trans></div>
              <div className="flex items-start justify-center min-h-8">
                <p className="text-[10px] leading-snug line-clamp-2" style={{ color: 'var(--text-muted)' }}>
                  <Trans>Click or lasso to keep voxels solid, <span style={{ color: 'var(--accent-secondary-action-color)', fontWeight: 600 }}>Alt+Lasso</span> to release.<br /><span style={{ color: 'var(--accent-secondary-action-color)', fontWeight: 600 }}>Clear</span> to reset all, <span style={{ color: 'var(--accent-secondary-action-color)', fontWeight: 600 }}>Done</span> to apply.</Trans>
                </p>
              </div>
            </div>
          ) : (
            <div className="rounded-md border p-2 space-y-1.5 min-h-[4.5rem] box-border" style={accentCardStyle}>
              <div className="ui-meta" style={{ color: 'var(--text-muted)' }}><Trans>Mode</Trans></div>
              <div className="grid grid-cols-2 gap-1 min-h-8">
                <Button
                  variant="secondary"
                  size="auto"
                  className="!h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
                  onClick={() => setState({ mode: 'cavity' })}
                  style={state.mode === 'cavity' ? activeModeStyle : undefined}
                  disabled={isApplying}
                >
                  <Trans>Cavity</Trans>
                </Button>

                <Button
                  variant="secondary"
                  size="auto"
                  className="!h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
                  onClick={() => setState({ mode: 'infill' })}
                  style={state.mode === 'infill' ? activeModeStyle : undefined}
                  disabled={isApplying}
                >
                  <Trans>Infill</Trans>
                </Button>

              </div>
            </div>
          )}

          <div className="rounded-md border p-2 space-y-1.5" style={panelCardStyle}>
            <label className="ui-meta block" style={{ color: 'var(--text-muted)' }}><Trans>Voxel Size</Trans></label>
            <ScrollableNumberField
              value={state.voxelSizeMm}
              onChange={(value) => setState({ voxelSizeMm: clampFloat(value, 0.2, 10, 2) })}
              min={0.2}
              max={10}
              step={0.1}
              unit="mm"
              ariaLabel={_(msg`Voxel Size`)}
              disabled={isApplying}
              className="mt-1"
            />
          </div>

          <div className="rounded-md border p-2 space-y-1.5" style={panelCardStyle}>
            <label className="ui-meta block" style={{ color: 'var(--text-muted)' }}><Trans>Shell Thickness</Trans></label>
            <ScrollableNumberField
              value={state.shellThicknessMm}
              onChange={(value) => setState({ shellThicknessMm: clampFloat(value, 0.2, 10, 1) })}
              min={0.2}
              max={10}
              step={0.1}
              unit="mm"
              ariaLabel={_(msg`Shell thickness in millimeters`)}
              disabled={isApplying}
              className="mt-1"
            />
          </div>

          {state.mode === 'infill' && (
            <>
              <div className="rounded-md border p-2 space-y-1.5" style={panelCardStyle}>
                <div className="ui-meta" style={{ color: 'var(--text-muted)' }}><Trans>Infill Type</Trans></div>
                <div className="grid grid-cols-2 gap-1">
                  <Button
                    variant="secondary"
                    size="auto"
                    className="!h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
                    onClick={() => setState({ infillMode: 'lattice' })}
                    style={state.infillMode === 'lattice' ? activeModeStyle : undefined}
                    disabled={isApplying}
                  >
                    <Trans>Lattice</Trans>
                  </Button>

                  <Button
                    variant="secondary"
                    size="auto"
                    className="!h-8 whitespace-nowrap px-1.5 text-[10px] sm:text-[11px]"
                    onClick={() => setState({ infillMode: 'pillar' })}
                    style={state.infillMode === 'pillar' ? activeModeStyle : undefined}
                    disabled={isApplying}
                  >
                    <Trans>Pillar</Trans>
                  </Button>

                </div>
              </div>

              <div className="rounded-md border p-2 space-y-1.5" style={panelCardStyle}>
                <label className="ui-meta block" style={{ color: 'var(--text-muted)' }}>
                  {state.infillMode === 'pillar' ? _(msg`Pillar Spacing`) : _(msg`Infill Density`)}
                </label>
                <ScrollableNumberField
                  value={infillDensityPct}
                  onChange={(value) => setState({ infillCellMm: densityPctToCellMm(value) })}
                  min={1}
                  max={100}
                  step={1}
                  unit="%"
                  ariaLabel={state.infillMode === 'pillar' ? _(msg`Pillar spacing percent`) : _(msg`Infill density percent`)}
                  disabled={isApplying}
                  className="mt-1"
                />
              </div>

              <div className="rounded-md border p-2 space-y-1.5" style={panelCardStyle}>
                <label className="ui-meta block" style={{ color: 'var(--text-muted)' }}><Trans>Infill Diameter</Trans></label>
                <ScrollableNumberField
                  value={infillDiameterMm}
                  onChange={(value) => setState({ infillBeamRadiusMm: clampFloat(value / 2, minInfillDiameterMm / 2, maxInfillDiameterMm / 2, 2) })}
                  min={minInfillDiameterMm}
                  max={maxInfillDiameterMm}
                  step={0.1}
                  unit="mm"
                  ariaLabel={_(msg`Infill diameter in millimeters`)}
                  disabled={isApplying}
                  className="mt-1"
                />
              </div>
            </>
          )}

          {state.mode === 'shell_open_face' && (
            <div className="rounded-md border p-2" style={panelCardStyle}>
              <label className="ui-meta block" style={{ color: 'var(--text-muted)' }}><Trans>Open Face</Trans></label>
              <Select
                className="mt-1 w-full !h-8 px-2 text-xs"
                value={state.openFace}
                onChange={(e) => setState({ openFace: e.target.value as OpenFace })}
                disabled={isApplying}
              >
                <option value="x_min">{_(msg`X Min`)}</option>
                <option value="x_max">{_(msg`X Max`)}</option>
                <option value="y_min">{_(msg`Y Min`)}</option>
                <option value="y_max">{_(msg`Y Max`)}</option>
                <option value="z_min">{_(msg`Z Min`)}</option>
                <option value="z_max">{_(msg`Z Max`)}</option>
              </Select>

              {shellFaceSelectionPending && (
                <p className="mt-1.5 text-[11px] leading-tight" style={{ color: 'var(--text-muted)' }}>
                  <Trans>Click the face you want to open in the scene.</Trans>
                </p>
              )}
            </div>
          )}

          {isEditMode ? (
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="auto"
                className="flex-1 !min-h-8 px-1.5 py-1 text-[10px] sm:text-[11px] whitespace-normal text-center leading-tight disabled:opacity-60"
                onClick={onClearEdit}
                disabled={isApplying || isPreviewing}
              >
                <Trans>Clear</Trans>
              </Button>

              <Button
                variant="accent"
                size="auto"
                className="flex-1 !min-h-8 px-1.5 py-1 text-[10px] sm:text-[11px] whitespace-normal text-center leading-tight disabled:opacity-60"
                onClick={onDoneEdit}
                disabled={isApplying || isPreviewing || isApplyingBlockers}
              >
                {isApplyingBlockers ? (
                  <span className="inline-flex items-center justify-center gap-1.5">
                    <Spinner size="xs" />
                    <span><Trans>Applying Solid Areas</Trans></span>
                  </span>
                ) : _(msg`Done`)}
              </Button>

            </div>
          ) : (
            <div className="flex gap-2">
              {isHollowingApplied ? (
                <>
                  {canApply && (
                    <Button
                      variant="secondary"
                      size="auto"
                      className="flex-1 !min-h-8 px-1.5 py-1 text-[10px] sm:text-[11px] whitespace-normal text-center leading-tight disabled:opacity-60"
                      onClick={onResetSettings}
                      disabled={isApplying || isPreviewing}
                    >
                      <Trans>Reset</Trans>
                    </Button>

                  )}
                  <Button
                    variant="accent"
                    size="auto"
                    className="flex-1 !min-h-8 px-1.5 py-1 text-[10px] sm:text-[11px] whitespace-normal text-center leading-tight disabled:opacity-60"
                    onClick={onReset}
                    disabled={isApplying || isPreviewing}
                  >
                    <Trans>Remove Hollowing</Trans>
                  </Button>

                </>
              ) : (
                <>
                  <Button
                    variant="secondary"
                    size="auto"
                    className="flex-1 !min-h-8 px-1.5 py-1 text-[10px] sm:text-[11px] whitespace-normal text-center leading-tight disabled:opacity-60"
                    onClick={onStartEdit}
                    disabled={isApplying || isPreviewing || !canEdit}
                  >
                    <Trans>Solid Areas</Trans>
                  </Button>

                  <Button
                    variant="accent"
                    size="auto"
                    className="flex-1 !min-h-8 px-1.5 py-1 text-[10px] sm:text-[11px] whitespace-normal text-center leading-tight disabled:opacity-60"
                    onClick={onApply}
                    disabled={isApplying || isPreviewing || !canApply}
                  >
                    {isApplying ? _(msg`Applying…`) : isPreviewing ? (
                      <span className="inline-flex items-center justify-center gap-1.5">
                        <Spinner size="xs" />
                        <span><Trans>Updating</Trans></span>
                      </span>
                    ) : _(msg`Apply`)}
                  </Button>

                </>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
