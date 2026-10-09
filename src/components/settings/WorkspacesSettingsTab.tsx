'use client';

import React from 'react';
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
              3D View
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Build volume boundaries and display resolution hints used across workspaces.
            </p>
          </div>
        </div>

        <div className="mt-3">
          {isBuildVolumeManagedByPrinter ? (
            <div className="rounded-md border px-2 py-1.5" style={{ borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 45%)', background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 94%)' }}>
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Bounding box dimensions are handled by the selected printer profile (<span style={{ color: 'var(--text-strong)' }}>{activePrinterProfile?.name}</span>).
              </div>
            </div>
          ) : (
            <>
              <SettingRow
                bordered
                label="Enable build volume bounds"
                description="Shows a faint printer volume outline and enables out-of-bounds checks."
              >
                <SegmentedControl
                  label="Enable build volume bounds"
                  value={view3dSettings.enabled ? 'on' : 'off'}
                  onChange={(next) => patchView3dSettings({ enabled: next === 'on' })}
                  options={[
                    { value: 'off', label: 'OFF' },
                    { value: 'on', label: 'ON' },
                  ]}
                />
              </SettingRow>

              {view3dSettings.enabled && (
                <>
                  <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Build Width (mm)
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
              Build Depth (mm)
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
              Max Z Height (mm)
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
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Build Volume</div>
              <div className="mt-0.5 text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                {Math.round(view3dSettings.widthMm)} × {Math.round(view3dSettings.depthMm)} × {Math.round(view3dSettings.maxZMm)} mm
              </div>
            </div>

            <SettingRow
              bordered
              className="col-span-2"
              label="Build volume origin"
              description="Choose where XYZ 0,0,0 is located for the printer volume."
            >
              <SegmentedControl
                label="Build volume origin"
                value={view3dSettings.originMode}
                onChange={(next) => patchView3dSettings({ originMode: next })}
                options={[
                  { value: 'center', label: 'Center' },
                  { value: 'front_left', label: 'Front-left corner' },
                ]}
              />
            </SettingRow>

            <label className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Screen Width (px)
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
              Screen Height (px)
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
            label="Show out-of-bounds warnings"
            description="Warn when any visible model extends beyond the configured build volume."
          >
            <SegmentedControl
              label="Show out-of-bounds warnings"
              value={view3dSettings.showViolationWarning ? 'on' : 'off'}
              onChange={(next) => patchView3dSettings({ showViolationWarning: next === 'on' })}
              options={[
                { value: 'off', label: 'OFF' },
                { value: 'on', label: 'ON' },
              ]}
            />
          </SettingRow>

          <SettingRow
            bordered
            className="mt-2"
            label="Show model bounding boxes"
            description="Debug overlay: draws world-space bounds for each visible model (red if out-of-bounds)."
          >
            <SegmentedControl
              label="Show model bounding boxes"
              value={view3dSettings.showModelBoundingBoxes ? 'on' : 'off'}
              onChange={(next) => patchView3dSettings({ showModelBoundingBoxes: next === 'on' })}
              options={[
                { value: 'off', label: 'OFF' },
                { value: 'on', label: 'ON' },
              ]}
            />
          </SettingRow>

          <SettingRow
            bordered
            className="mt-2"
            label="Show slice SAT bounding mesh"
            description="SAT debug overlay for nesting and diagnostics."
          >
            <SegmentedControl
              label="Show slice SAT bounding mesh"
              value={view3dSettings.showSliceSatBoundingMesh ? 'on' : 'off'}
              onChange={(next) => patchView3dSettings({ showSliceSatBoundingMesh: next === 'on' })}
              options={[
                { value: 'off', label: 'OFF' },
                { value: 'on', label: 'ON' },
              ]}
            />
          </SettingRow>

          {view3dSettings.showSliceSatBoundingMesh && (
            <SettingRow
              bordered
              className="mt-2"
              label="SAT debug scope"
              description="Show SAT mesh on the active model only, or on all visible models."
            >
              <SegmentedControl
                label="SAT debug scope"
                value={view3dSettings.showSliceSatBoundingMeshForAllModels ? 'all' : 'active'}
                onChange={(next) => patchView3dSettings({ showSliceSatBoundingMeshForAllModels: next === 'all' })}
                options={[
                  { value: 'active', label: 'ACTIVE ONLY' },
                  { value: 'all', label: 'ALL MODELS' },
                ]}
              />
            </SettingRow>
          )}

          {view3dSettings.showSliceSatBoundingMesh && (
            <>
              <SettingRow
                bordered
                className="mt-2"
                label="SAT mode"
                description="Choose accurate convex-hull SAT for nesting, or experimental slice-derived SAT for diagnostics."
              >
                <SegmentedControl
                  label="SAT mode"
                  value={view3dSettings.sliceSatBoundingMeshMode}
                  onChange={(next) => patchView3dSettings({ sliceSatBoundingMeshMode: next })}
                  options={[
                    { value: 'accurate_hull', label: 'Accurate Hull-based SAT' },
                    { value: 'experimental_slice', label: 'Experimental Slice-based SAT' },
                  ]}
                />
              </SettingRow>

              {view3dSettings.sliceSatBoundingMeshMode === 'experimental_slice' && (
                <SettingRow
                  bordered
                  className="mt-2"
                  label="Experimental slice display"
                  description="Pick how the experimental slice-derived SAT is visualized."
                >
                  <SegmentedControl
                    label="Experimental slice display"
                    value={view3dSettings.experimentalSliceSatBoundingMeshRenderMode}
                    onChange={(next) => patchView3dSettings({ experimentalSliceSatBoundingMeshRenderMode: next })}
                    options={[
                      { value: 'shaded', label: 'Shaded' },
                      { value: 'wireframe', label: 'Wireframe' },
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
