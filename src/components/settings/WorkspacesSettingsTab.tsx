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
        className="rounded-lg border p-3"
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
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              3D View
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Build volume boundaries and display resolution hints used across workspaces.
            </p>
          </div>
        </div>

        <div className="mt-3 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          {isBuildVolumeManagedByPrinter ? (
            <div className="rounded-md border px-2 py-1.5" style={{ borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 45%)', background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 94%)' }}>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Bounding box dimensions are handled by the selected printer profile (<span style={{ color: 'var(--text-strong)' }}>{activePrinterProfile?.name}</span>).
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                    Enable build volume bounds
                  </div>
                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    Shows a faint printer volume outline and enables out-of-bounds checks.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => patchView3dSettings({ enabled: !view3dSettings.enabled })}
                  className="h-10 min-w-[92px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
                  style={view3dSettings.enabled
                    ? {
                        borderColor: 'color-mix(in srgb, var(--accent), white 10%)',
                        background: 'color-mix(in srgb, var(--accent), var(--surface-0) 76%)',
                        color: 'var(--accent-contrast)',
                      }
                    : {
                        borderColor: 'var(--border-subtle)',
                        background: 'var(--surface-1)',
                        color: 'var(--text-muted)',
                      }}
                >
                  {view3dSettings.enabled ? 'ON' : 'OFF'}
                </button>
              </div>

              {view3dSettings.enabled && (
                <>
                  <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
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

            <label className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
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

            <label className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
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
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Build Volume</div>
              <div className="mt-0.5 text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                {Math.round(view3dSettings.widthMm)} × {Math.round(view3dSettings.depthMm)} × {Math.round(view3dSettings.maxZMm)} mm
              </div>
            </div>

            <div className="col-span-2 rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
              <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                Build volume origin
              </div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Choose where XYZ 0,0,0 is located for the printer volume.
              </div>
              <div className="mt-2 flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => patchView3dSettings({ originMode: 'center' })}
                  className="h-10 min-w-[140px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
                  style={view3dSettings.originMode === 'center'
                    ? {
                        borderColor: 'color-mix(in srgb, var(--accent), white 10%)',
                        background: 'color-mix(in srgb, var(--accent), var(--surface-0) 76%)',
                        color: 'var(--accent-contrast)',
                      }
                    : {
                        borderColor: 'var(--border-subtle)',
                        background: 'var(--surface-1)',
                        color: 'var(--text-muted)',
                      }}
                >
                  Center
                </button>
                <button
                  type="button"
                  onClick={() => patchView3dSettings({ originMode: 'front_left' })}
                  className="h-10 min-w-[140px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
                  style={view3dSettings.originMode === 'front_left'
                    ? {
                        borderColor: 'color-mix(in srgb, var(--accent), white 10%)',
                        background: 'color-mix(in srgb, var(--accent), var(--surface-0) 76%)',
                        color: 'var(--accent-contrast)',
                      }
                    : {
                        borderColor: 'var(--border-subtle)',
                        background: 'var(--surface-1)',
                        color: 'var(--text-muted)',
                      }}
                >
                  Front-left corner
                </button>
              </div>
            </div>

            <label className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
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

            <label className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
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

          <div className="mt-2 flex items-center justify-between gap-3 rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div>
              <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                Show out-of-bounds warnings
              </div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Warn when any visible model extends beyond the configured build volume.
              </div>
            </div>
            <button
              type="button"
              onClick={() => patchView3dSettings({ showViolationWarning: !view3dSettings.showViolationWarning })}
              className="h-10 min-w-[92px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
              style={view3dSettings.showViolationWarning
                ? {
                    borderColor: 'color-mix(in srgb, var(--accent), white 10%)',
                    background: 'color-mix(in srgb, var(--accent), var(--surface-0) 76%)',
                    color: 'var(--accent-contrast)',
                  }
                : {
                    borderColor: 'var(--border-subtle)',
                    background: 'var(--surface-1)',
                    color: 'var(--text-muted)',
                  }}
            >
              {view3dSettings.showViolationWarning ? 'ON' : 'OFF'}
            </button>
          </div>

          <div className="mt-2 flex items-center justify-between gap-3 rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div>
              <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                Show model bounding boxes
              </div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Debug overlay: draws world-space bounds for each visible model (red if out-of-bounds).
              </div>
            </div>
            <button
              type="button"
              onClick={() => patchView3dSettings({ showModelBoundingBoxes: !view3dSettings.showModelBoundingBoxes })}
              className="h-10 min-w-[92px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
              style={view3dSettings.showModelBoundingBoxes
                ? {
                    borderColor: 'color-mix(in srgb, var(--accent), white 10%)',
                    background: 'color-mix(in srgb, var(--accent), var(--surface-0) 76%)',
                    color: 'var(--accent-contrast)',
                  }
                : {
                    borderColor: 'var(--border-subtle)',
                    background: 'var(--surface-1)',
                    color: 'var(--text-muted)',
                  }}
            >
              {view3dSettings.showModelBoundingBoxes ? 'ON' : 'OFF'}
            </button>
          </div>

          <div className="mt-2 flex items-center justify-between gap-3 rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div>
              <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                Show slice SAT bounding mesh
              </div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                SAT debug overlay for nesting and diagnostics.
              </div>
            </div>
            <button
              type="button"
              onClick={() => patchView3dSettings({ showSliceSatBoundingMesh: !view3dSettings.showSliceSatBoundingMesh })}
              className="h-10 min-w-[92px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
              style={view3dSettings.showSliceSatBoundingMesh
                ? {
                    borderColor: 'color-mix(in srgb, var(--accent), white 10%)',
                    background: 'color-mix(in srgb, var(--accent), var(--surface-0) 76%)',
                    color: 'var(--accent-contrast)',
                  }
                : {
                    borderColor: 'var(--border-subtle)',
                    background: 'var(--surface-1)',
                    color: 'var(--text-muted)',
                  }}
            >
              {view3dSettings.showSliceSatBoundingMesh ? 'ON' : 'OFF'}
            </button>
          </div>

          {view3dSettings.showSliceSatBoundingMesh && (
            <div className="mt-2 flex items-center justify-between gap-3 rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
              <div>
                <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                  SAT debug scope
                </div>
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  Show SAT mesh on the active model only, or on all visible models.
                </div>
              </div>
              <button
                type="button"
                onClick={() => patchView3dSettings({ showSliceSatBoundingMeshForAllModels: !view3dSettings.showSliceSatBoundingMeshForAllModels })}
                className="h-10 min-w-[130px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
                style={view3dSettings.showSliceSatBoundingMeshForAllModels
                  ? {
                      borderColor: 'color-mix(in srgb, var(--accent), white 10%)',
                      background: 'color-mix(in srgb, var(--accent), var(--surface-0) 76%)',
                      color: 'var(--accent-contrast)',
                    }
                  : {
                      borderColor: 'var(--border-subtle)',
                      background: 'var(--surface-1)',
                      color: 'var(--text-muted)',
                    }}
              >
                {view3dSettings.showSliceSatBoundingMeshForAllModels ? 'ALL MODELS' : 'ACTIVE ONLY'}
              </button>
            </div>
          )}

          {view3dSettings.showSliceSatBoundingMesh && (
            <div className="mt-2 rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
              <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                SAT mode
              </div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Choose accurate convex-hull SAT for nesting, or experimental slice-derived SAT for diagnostics.
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => patchView3dSettings({ sliceSatBoundingMeshMode: 'accurate_hull' })}
                  className="h-10 min-w-[180px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
                  style={view3dSettings.sliceSatBoundingMeshMode === 'accurate_hull'
                    ? {
                        borderColor: 'color-mix(in srgb, var(--accent), white 10%)',
                        background: 'color-mix(in srgb, var(--accent), var(--surface-0) 76%)',
                        color: 'var(--accent-contrast)',
                      }
                    : {
                        borderColor: 'var(--border-subtle)',
                        background: 'var(--surface-1)',
                        color: 'var(--text-muted)',
                      }}
                >
                  Accurate Hull-based SAT
                </button>
                <button
                  type="button"
                  onClick={() => patchView3dSettings({ sliceSatBoundingMeshMode: 'experimental_slice' })}
                  className="h-10 min-w-[200px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
                  style={view3dSettings.sliceSatBoundingMeshMode === 'experimental_slice'
                    ? {
                        borderColor: 'color-mix(in srgb, var(--accent), white 10%)',
                        background: 'color-mix(in srgb, var(--accent), var(--surface-0) 76%)',
                        color: 'var(--accent-contrast)',
                      }
                    : {
                        borderColor: 'var(--border-subtle)',
                        background: 'var(--surface-1)',
                        color: 'var(--text-muted)',
                      }}
                >
                  Experimental Slice-based SAT
                </button>
              </div>

              {view3dSettings.sliceSatBoundingMeshMode === 'experimental_slice' && (
                <div className="mt-2 flex items-center justify-between gap-3 rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
                  <div>
                    <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                      Experimental slice display
                    </div>
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      Pick how the experimental slice-derived SAT is visualized.
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => patchView3dSettings({ experimentalSliceSatBoundingMeshRenderMode: 'shaded' })}
                      className="h-10 min-w-[90px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
                      style={view3dSettings.experimentalSliceSatBoundingMeshRenderMode === 'shaded'
                        ? {
                            borderColor: 'color-mix(in srgb, var(--accent), white 10%)',
                            background: 'color-mix(in srgb, var(--accent), var(--surface-0) 76%)',
                            color: 'var(--accent-contrast)',
                          }
                        : {
                            borderColor: 'var(--border-subtle)',
                            background: 'var(--surface-1)',
                            color: 'var(--text-muted)',
                          }}
                    >
                      Shaded
                    </button>
                    <button
                      type="button"
                      onClick={() => patchView3dSettings({ experimentalSliceSatBoundingMeshRenderMode: 'wireframe' })}
                      className="h-10 min-w-[90px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
                      style={view3dSettings.experimentalSliceSatBoundingMeshRenderMode === 'wireframe'
                        ? {
                            borderColor: 'color-mix(in srgb, var(--accent), white 10%)',
                            background: 'color-mix(in srgb, var(--accent), var(--surface-0) 76%)',
                            color: 'var(--accent-contrast)',
                          }
                        : {
                            borderColor: 'var(--border-subtle)',
                            background: 'var(--surface-1)',
                            color: 'var(--text-muted)',
                          }}
                    >
                      Wireframe
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

      </section>

    </div>
  );
}
