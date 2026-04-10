'use client';

import React from 'react';
import type { SupportMode } from '@/supports/types';
import { Camera as CameraIcon } from 'lucide-react';
import type { CameraProjectionMode } from '@/components/settings/cameraProjectionPreferences';
import type { CameraFeelPreset } from '@/components/settings/cameraFeelPreferences';
import type { CameraScopeMode, WorkspaceCameraDefaults } from '@/components/settings/workspaceCameraPreferences';

interface CameraSettingsTabProps {
  cameraScope: CameraScopeMode;
  onCameraScopeChange: (scope: CameraScopeMode) => void;
  cameraProjectionMode: CameraProjectionMode;
  onCameraProjectionModeChange: (mode: CameraProjectionMode) => void;
  cameraFeelPreset: CameraFeelPreset;
  onCameraFeelPresetChange: (preset: CameraFeelPreset) => void;
  workspaceCameraDefaults: WorkspaceCameraDefaults;
  onWorkspaceCameraModeChange: (workspace: SupportMode, mode: CameraProjectionMode) => void;
}

const workspaceMeta: Array<{ key: SupportMode; label: string; hint: string }> = [
  { key: 'prepare', label: 'Prepare', hint: 'Model prep and transform workflows' },
  { key: 'analysis', label: 'Analysis', hint: 'Island diagnostics and inspection tools' },
  { key: 'support', label: 'Support', hint: 'Support placement and editing workspace' },
  { key: 'export', label: 'Export', hint: 'Final output and export pipeline' },
];

export function CameraSettingsTab({
  cameraScope,
  onCameraScopeChange,
  cameraProjectionMode,
  onCameraProjectionModeChange,
  cameraFeelPreset,
  onCameraFeelPresetChange,
  workspaceCameraDefaults,
  onWorkspaceCameraModeChange,
}: CameraSettingsTabProps) {
  const [activeWorkspace, setActiveWorkspace] = React.useState<SupportMode>('prepare');
  const usingGlobalScope = cameraScope === 'global';
  const usingWorkspaceScope = cameraScope === 'workspace';

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
            <CameraIcon className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="flex-1">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              Camera Defaults
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Global camera projection mode and navigation behavior.
            </p>
          </div>
        </div>

        <div className="mt-3 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                Camera scope
              </div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Choose one global projection mode for every workspace, or set projection defaults per workspace.
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => onCameraScopeChange('global')}
                className="h-10 min-w-[120px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
                style={usingGlobalScope
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
                Global
              </button>
              <button
                type="button"
                onClick={() => onCameraScopeChange('workspace')}
                className="h-10 min-w-[120px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
                style={usingWorkspaceScope
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
                Workspace
              </button>
            </div>
          </div>
        </div>

        {usingGlobalScope && (
          <div
            className="mt-2 rounded-md border p-2.5"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'var(--surface-0)',
            }}
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                  Projection mode
                </div>
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  Use one projection mode everywhere when global scope is active.
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => onCameraProjectionModeChange('orthographic')}
                  className="h-10 min-w-[120px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
                  style={cameraProjectionMode === 'orthographic'
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
                  onClick={() => onCameraProjectionModeChange('perspective')}
                  className="h-10 min-w-[120px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
                  style={cameraProjectionMode === 'perspective'
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
            </div>
          </div>
        )}

        {usingWorkspaceScope && (
          <div
            className="mt-2 rounded-md border p-2.5"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'var(--surface-0)',
            }}
          >
            <div>
              <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                Workspace camera defaults
              </div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Pick the default projection mode used when you enter each workspace.
              </div>
            </div>

            <div className="mt-2 grid grid-cols-2 gap-1.5 md:grid-cols-4">
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
                {workspaceMeta.find((workspace) => workspace.key === activeWorkspace)?.label} default camera
              </div>
              <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {workspaceMeta.find((workspace) => workspace.key === activeWorkspace)?.hint}
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
            </div>
          </div>
        )}

        <div className="mt-2 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                Camera feel
              </div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Controls smoothing and movement acceleration while orbiting, panning, and zooming.
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              {([
                { key: 'raw', label: 'Raw' },
                { key: 'precise', label: 'Precise' },
                { key: 'balanced', label: 'Balanced' },
                { key: 'fast', label: 'Fast' },
              ] as Array<{ key: CameraFeelPreset; label: string }>).map((option) => {
                const active = cameraFeelPreset === option.key;
                return (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => onCameraFeelPresetChange(option.key)}
                    className="h-10 min-w-[104px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
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
