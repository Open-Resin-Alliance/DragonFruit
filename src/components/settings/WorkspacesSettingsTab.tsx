'use client';

import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import {
  getActivePrinterProfile,
  getProfileStoreSnapshot,
  getProfileStoreServerSnapshot,
  subscribeToProfileStore,
} from '@/features/profiles/profileStore';
import { Layers3 } from 'lucide-react';
import { NumberInput } from '@/components/ui/NumberInput';
import { SegmentedControl, SettingRow } from '@/components/atoms';
import type { View3DSettings } from '@/components/settings/view3dPreferences';

interface WorkspacesSettingsTabProps {
  view3dSettings: View3DSettings;
  onView3dSettingsChange: (settings: View3DSettings) => void;
}

export function WorkspacesSettingsTab({
  view3dSettings,
  onView3dSettingsChange,
}: WorkspacesSettingsTabProps) {
  const { _ } = useLingui();
  const profileState = React.useSyncExternalStore(subscribeToProfileStore, getProfileStoreSnapshot, getProfileStoreServerSnapshot);
  const activePrinterProfile = React.useMemo(() => getActivePrinterProfile(profileState), [profileState]);
  const isBuildVolumeManagedByPrinter = Boolean(activePrinterProfile);

  const patchView3dSettings = React.useCallback((patch: Partial<View3DSettings>) => {
    onView3dSettingsChange({ ...view3dSettings, ...patch });
  }, [onView3dSettingsChange, view3dSettings]);

  return (
    <div className="space-y-3">
      <section
        className="rounded-md border p-3"
        style={{
          background: 'var(--surface-1)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        <div className="flex items-start gap-2">
          <span
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'color-mix(in srgb, var(--surface-2), transparent 8%)',
            }}
          >
            <Layers3 className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="flex-1">
            <h3 className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
              <Trans>3D View</Trans>
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              <Trans>Build volume boundaries and display resolution hints used across the workspace.</Trans>
            </p>
          </div>
        </div>

        <div className="mt-3">
          {isBuildVolumeManagedByPrinter ? (
            <div className="rounded-md border px-2 py-1.5" style={{ borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 45%)', background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 94%)' }}>
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                <Trans>Bounding box dimensions are handled by the selected printer profile (<span style={{ color: 'var(--text-strong)' }}>{activePrinterProfile?.name}</span>).</Trans>
              </div>
            </div>
          ) : (
            <>
              <SettingRow
                bordered
                label={_(msg`Enable build volume bounds`)}
                description={_(msg`Shows a faint printer volume outline and enables out-of-bounds checks.`)}
              >
                <SegmentedControl
                  label={_(msg`Enable build volume bounds`)}
                  value={view3dSettings.enabled ? 'on' : 'off'}
                  onChange={(next) => patchView3dSettings({ enabled: next === 'on' })}
                  options={[
                    { value: 'off', label: _(msg`OFF`) },
                    { value: 'on', label: _(msg`ON`) },
                  ]}
                />
              </SettingRow>

              {view3dSettings.enabled && (
                <>
                  <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="text-xs" style={{ color: 'var(--text-muted)' }}>
              <Trans>Build Width (mm)</Trans>
              <NumberInput
                min={10}
                step={1}
                value={view3dSettings.widthMm}
                onChange={(next) => patchView3dSettings({ widthMm: Math.max(10, Math.round(next)) })}
                className="mt-1 h-9 w-full rounded-md border pl-2 pr-5 text-[12px]"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-strong)' }}
              />
            </label>

            <label className="text-xs" style={{ color: 'var(--text-muted)' }}>
              <Trans>Build Depth (mm)</Trans>
              <NumberInput
                min={10}
                step={1}
                value={view3dSettings.depthMm}
                onChange={(next) => patchView3dSettings({ depthMm: Math.max(10, Math.round(next)) })}
                className="mt-1 h-9 w-full rounded-md border pl-2 pr-5 text-[12px]"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-strong)' }}
              />
            </label>

            <label className="text-xs" style={{ color: 'var(--text-muted)' }}>
              <Trans>Max Z Height (mm)</Trans>
              <NumberInput
                min={10}
                step={1}
                value={view3dSettings.maxZMm}
                onChange={(next) => patchView3dSettings({ maxZMm: Math.max(10, Math.round(next)) })}
                className="mt-1 h-9 w-full rounded-md border pl-2 pr-5 text-[12px]"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-strong)' }}
              />
            </label>

            <div className="rounded-md border px-2 py-1.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}><Trans>Build Volume</Trans></div>
              <div className="mt-0.5 text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                {Math.round(view3dSettings.widthMm)} × {Math.round(view3dSettings.depthMm)} × {Math.round(view3dSettings.maxZMm)} mm
              </div>
            </div>

            <SettingRow
              bordered
              className="col-span-2"
              label={_(msg`Build volume origin`)}
              description={_(msg`Choose where XYZ 0,0,0 is located for the printer volume.`)}
            >
              <SegmentedControl
                label={_(msg`Build volume origin`)}
                value={view3dSettings.originMode}
                onChange={(next) => patchView3dSettings({ originMode: next })}
                options={[
                  { value: 'center', label: _(msg`Center`) },
                  { value: 'front_left', label: _(msg`Front-left corner`) },
                ]}
              />
            </SettingRow>

            <label className="text-xs" style={{ color: 'var(--text-muted)' }}>
              <Trans>Screen Width (px)</Trans>
              <NumberInput
                min={320}
                step={1}
                value={view3dSettings.screenWidthPx}
                onChange={(next) => patchView3dSettings({ screenWidthPx: Math.max(320, Math.round(next)) })}
                className="mt-1 h-9 w-full rounded-md border pl-2 pr-5 text-[12px]"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-strong)' }}
              />
            </label>

            <label className="text-xs" style={{ color: 'var(--text-muted)' }}>
              <Trans>Screen Height (px)</Trans>
              <NumberInput
                min={200}
                step={1}
                value={view3dSettings.screenHeightPx}
                onChange={(next) => patchView3dSettings({ screenHeightPx: Math.max(200, Math.round(next)) })}
                className="mt-1 h-9 w-full rounded-md border pl-2 pr-5 text-[12px]"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-strong)' }}
              />
            </label>
                  </div>
                </>
              )}
            </>
          )}

          <SettingRow
            bordered
            className="mt-2"
            label={_(msg`Show out-of-bounds warnings`)}
            description={_(msg`Warn when any visible model extends beyond the configured build volume.`)}
          >
            <SegmentedControl
              label={_(msg`Show out-of-bounds warnings`)}
              value={view3dSettings.showViolationWarning ? 'on' : 'off'}
              onChange={(next) => patchView3dSettings({ showViolationWarning: next === 'on' })}
              options={[
                { value: 'off', label: _(msg`OFF`) },
                { value: 'on', label: _(msg`ON`) },
              ]}
            />
          </SettingRow>

          <SettingRow
            bordered
            className="mt-2"
            label={_(msg`Show model bounding boxes`)}
            description={_(msg`Debug overlay: draws world-space bounds for each visible model (red if out-of-bounds).`)}
          >
            <SegmentedControl
              label={_(msg`Show model bounding boxes`)}
              value={view3dSettings.showModelBoundingBoxes ? 'on' : 'off'}
              onChange={(next) => patchView3dSettings({ showModelBoundingBoxes: next === 'on' })}
              options={[
                { value: 'off', label: _(msg`OFF`) },
                { value: 'on', label: _(msg`ON`) },
              ]}
            />
          </SettingRow>

          <SettingRow
            bordered
            className="mt-2"
            label={_(msg`Show slice SAT bounding mesh`)}
            description={_(msg`SAT debug overlay for nesting and diagnostics.`)}
          >
            <SegmentedControl
              label={_(msg`Show slice SAT bounding mesh`)}
              value={view3dSettings.showSliceSatBoundingMesh ? 'on' : 'off'}
              onChange={(next) => patchView3dSettings({ showSliceSatBoundingMesh: next === 'on' })}
              options={[
                { value: 'off', label: _(msg`OFF`) },
                { value: 'on', label: _(msg`ON`) },
              ]}
            />
          </SettingRow>

          {view3dSettings.showSliceSatBoundingMesh && (
            <SettingRow
              bordered
              className="mt-2"
              label={_(msg`SAT debug scope`)}
              description={_(msg`Show SAT mesh on the active model only, or on all visible models.`)}
            >
              <SegmentedControl
                label={_(msg`SAT debug scope`)}
                value={view3dSettings.showSliceSatBoundingMeshForAllModels ? 'all' : 'active'}
                onChange={(next) => patchView3dSettings({ showSliceSatBoundingMeshForAllModels: next === 'all' })}
                options={[
                  { value: 'active', label: _(msg`ACTIVE ONLY`) },
                  { value: 'all', label: _(msg`ALL MODELS`) },
                ]}
              />
            </SettingRow>
          )}

          {view3dSettings.showSliceSatBoundingMesh && (
            <>
              <SettingRow
                bordered
                className="mt-2"
                label={_(msg`SAT mode`)}
                description={_(msg`Choose accurate convex-hull SAT for nesting, or experimental slice-derived SAT for diagnostics.`)}
              >
                <SegmentedControl
                  label={_(msg`SAT mode`)}
                  value={view3dSettings.sliceSatBoundingMeshMode}
                  onChange={(next) => patchView3dSettings({ sliceSatBoundingMeshMode: next })}
                  options={[
                    { value: 'accurate_hull', label: _(msg`Accurate Hull-based SAT`) },
                    { value: 'experimental_slice', label: _(msg`Experimental Slice-based SAT`) },
                  ]}
                />
              </SettingRow>

              {view3dSettings.sliceSatBoundingMeshMode === 'experimental_slice' && (
                <SettingRow
                  bordered
                  className="mt-2"
                  label={_(msg`Experimental slice display`)}
                  description={_(msg`Pick how the experimental slice-derived SAT is visualized.`)}
                >
                  <SegmentedControl
                    label={_(msg`Experimental slice display`)}
                    value={view3dSettings.experimentalSliceSatBoundingMeshRenderMode}
                    onChange={(next) => patchView3dSettings({ experimentalSliceSatBoundingMeshRenderMode: next })}
                    options={[
                      { value: 'shaded', label: _(msg`Shaded`) },
                      { value: 'wireframe', label: _(msg`Wireframe`) },
                    ]}
                  />
                </SettingRow>
              )}
            </>
          )}
        </div>

      </section>

    </div>
  );
}
