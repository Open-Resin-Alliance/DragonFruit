'use client';

import React from 'react';
import type { SupportMode } from '@/supports/types';
import type { CameraProjectionMode } from '@/components/settings/cameraProjectionPreferences';
import type { SelectionHighlightMode } from '@/components/selection';
import {
  getActivePrinterProfile,
  getProfileStoreSnapshot,
  getProfileStoreServerSnapshot,
  subscribeToProfileStore,
} from '@/features/profiles/profileStore';
import type {
  WorkspaceCameraDefaults,
  WorkspaceSelectionHighlightDefaults,
} from '@/components/settings/workspaceCameraPreferences';
import type { View3DSettings } from '@/components/settings/view3dPreferences';
import { Layers3 } from 'lucide-react';

interface WorkspacesSettingsTabProps {
  workspaceCameraDefaults: WorkspaceCameraDefaults;
  onWorkspaceCameraModeChange: (workspace: SupportMode, mode: CameraProjectionMode) => void;
  workspaceSelectionHighlightDefaults: WorkspaceSelectionHighlightDefaults;
  onWorkspaceSelectionHighlightModeChange: (workspace: SupportMode, mode: SelectionHighlightMode) => void;
  view3dSettings: View3DSettings;
  onView3dSettingsChange: (settings: View3DSettings) => void;
}

const workspaceMeta: Array<{ key: SupportMode; label: string; hint: string }> = [
  { key: 'prepare', label: 'Prepare', hint: 'Model prep and transform workflows' },
  { key: 'analysis', label: 'Analysis', hint: 'Island diagnostics and inspection tools' },
  { key: 'support', label: 'Support', hint: 'Support placement and editing workspace' },
  { key: 'export', label: 'Export', hint: 'Final output and export pipeline' },
];

export function WorkspacesSettingsTab({
  workspaceCameraDefaults,
  onWorkspaceCameraModeChange,
  workspaceSelectionHighlightDefaults,
  onWorkspaceSelectionHighlightModeChange,
  view3dSettings,
  onView3dSettingsChange,
}: WorkspacesSettingsTabProps) {
  const [activeWorkspace, setActiveWorkspace] = React.useState<SupportMode>('prepare');
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
                Bounding box settings are handled by the selected printer profile (<span style={{ color: 'var(--text-strong)' }}>{activePrinterProfile?.name}</span>).
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
              <input
                type="number"
                min={10}
                step={1}
                value={view3dSettings.widthMm}
                onChange={(e) => patchView3dSettings({ widthMm: Number(e.target.value) })}
                className="mt-1 h-9 w-full rounded-md border px-2 text-[12px]"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-strong)' }}
              />
            </label>

            <label className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Build Depth (mm)
              <input
                type="number"
                min={10}
                step={1}
                value={view3dSettings.depthMm}
                onChange={(e) => patchView3dSettings({ depthMm: Number(e.target.value) })}
                className="mt-1 h-9 w-full rounded-md border px-2 text-[12px]"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-strong)' }}
              />
            </label>

            <label className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Max Z Height (mm)
              <input
                type="number"
                min={10}
                step={1}
                value={view3dSettings.maxZMm}
                onChange={(e) => patchView3dSettings({ maxZMm: Number(e.target.value) })}
                className="mt-1 h-9 w-full rounded-md border px-2 text-[12px]"
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
              <input
                type="number"
                min={320}
                step={1}
                value={view3dSettings.screenWidthPx}
                onChange={(e) => patchView3dSettings({ screenWidthPx: Number(e.target.value) })}
                className="mt-1 h-9 w-full rounded-md border px-2 text-[12px]"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-strong)' }}
              />
            </label>

            <label className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Screen Height (px)
              <input
                type="number"
                min={200}
                step={1}
                value={view3dSettings.screenHeightPx}
                onChange={(e) => patchView3dSettings({ screenHeightPx: Number(e.target.value) })}
                className="mt-1 h-9 w-full rounded-md border px-2 text-[12px]"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-strong)' }}
              />
            </label>
          </div>

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
          </>
          )}

            </>
          )}
        </div>
      </section>

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
              Workspace Camera Defaults
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Pick the default projection mode for each workspace. When you switch workspaces, the camera mode auto-adjusts.
            </p>
          </div>
        </div>

        <div className="mt-3 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5">
            {workspaceMeta.map((workspace) => {
              const active = activeWorkspace === workspace.key;
              return (
                <button
                  key={workspace.key}
                  type="button"
                  onClick={() => setActiveWorkspace(workspace.key)}
                  className="h-10 rounded-md border px-2 text-[12px] font-semibold uppercase tracking-wide transition-colors"
                  style={active
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
                  {workspace.label}
                </button>
              );
            })}
          </div>

          <div className="mt-3 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
              {workspaceMeta.find((w) => w.key === activeWorkspace)?.label} default camera
            </div>
            <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {workspaceMeta.find((w) => w.key === activeWorkspace)?.hint}
            </div>

            <div className="mt-2 flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => onWorkspaceCameraModeChange(activeWorkspace, 'orthographic')}
                className="h-10 min-w-[120px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
                style={workspaceCameraDefaults[activeWorkspace] === 'orthographic'
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
                Ortho
              </button>
              <button
                type="button"
                onClick={() => onWorkspaceCameraModeChange(activeWorkspace, 'perspective')}
                className="h-10 min-w-[120px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
                style={workspaceCameraDefaults[activeWorkspace] === 'perspective'
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
                Perspective
              </button>
            </div>

            <div className="mt-3 text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
              {workspaceMeta.find((w) => w.key === activeWorkspace)?.label} selection highlight
            </div>
            <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Controls default selection emphasis when entering this workspace.
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {([
                { key: 'tint', label: 'Mesh Tint' },
                { key: 'spotlight', label: 'Spotlight' },
                { key: 'fresnel', label: 'Fresnel' },
                { key: 'none', label: 'None' },
              ] as Array<{ key: SelectionHighlightMode; label: string }>).map((option) => {
                const active = workspaceSelectionHighlightDefaults[activeWorkspace] === option.key;
                return (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => onWorkspaceSelectionHighlightModeChange(activeWorkspace, option.key)}
                    className="h-10 min-w-[120px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
                    style={active
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
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
