'use client';

import React from 'react';
import type { SupportMode } from '@/supports/types';
import type { CameraProjectionMode } from '@/components/settings/cameraProjectionPreferences';
import type { WorkspaceCameraDefaults } from '@/components/settings/workspaceCameraPreferences';
import { Layers3 } from 'lucide-react';

interface WorkspacesSettingsTabProps {
  workspaceCameraDefaults: WorkspaceCameraDefaults;
  onWorkspaceCameraModeChange: (workspace: SupportMode, mode: CameraProjectionMode) => void;
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
}: WorkspacesSettingsTabProps) {
  const [activeWorkspace, setActiveWorkspace] = React.useState<SupportMode>('prepare');

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
          </div>
        </div>
      </section>
    </div>
  );
}
