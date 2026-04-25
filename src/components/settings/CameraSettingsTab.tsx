'use client';

import React from 'react';
import type { SupportMode } from '@/supports/types';
import { Camera as CameraIcon, Hand as HandIcon } from 'lucide-react';
import type { CameraProjectionMode } from '@/components/settings/cameraProjectionPreferences';
import type { CameraFeelPreset } from '@/components/settings/cameraFeelPreferences';
import type { CameraTrackpadModifierKey, CameraTrackpadPrimaryAction } from '@/components/settings/cameraTrackpadPreferences';
import type { CameraScopeMode, WorkspaceCameraDefaults } from '@/components/settings/workspaceCameraPreferences';

interface CameraSettingsTabProps {
  cameraScope: CameraScopeMode;
  onCameraScopeChange: (scope: CameraScopeMode) => void;
  cameraProjectionMode: CameraProjectionMode;
  onCameraProjectionModeChange: (mode: CameraProjectionMode) => void;
  cameraFeelPreset: CameraFeelPreset;
  onCameraFeelPresetChange: (preset: CameraFeelPreset) => void;
  cameraTrackpadPrimaryAction: CameraTrackpadPrimaryAction;
  onCameraTrackpadPrimaryActionChange: (action: CameraTrackpadPrimaryAction) => void;
  cameraTrackpadModifierKey: CameraTrackpadModifierKey;
  onCameraTrackpadModifierKeyChange: (modifierKey: CameraTrackpadModifierKey) => void;
  cameraTrackpadPanAcceleration: number;
  onCameraTrackpadPanAccelerationChange: (value: number) => void;
  cameraTrackpadOrbitAcceleration: number;
  onCameraTrackpadOrbitAccelerationChange: (value: number) => void;
  cameraTrackpadZoomAcceleration: number;
  onCameraTrackpadZoomAccelerationChange: (value: number) => void;
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
  cameraTrackpadPrimaryAction,
  onCameraTrackpadPrimaryActionChange,
  cameraTrackpadModifierKey,
  onCameraTrackpadModifierKeyChange,
  cameraTrackpadPanAcceleration,
  onCameraTrackpadPanAccelerationChange,
  cameraTrackpadOrbitAcceleration,
  onCameraTrackpadOrbitAccelerationChange,
  cameraTrackpadZoomAcceleration,
  onCameraTrackpadZoomAccelerationChange,
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
                      color: 'color-mix(in srgb, var(--accent), var(--text-strong) 25%)',
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
                      color: 'color-mix(in srgb, var(--accent), var(--text-strong) 25%)',
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
                        color: 'color-mix(in srgb, var(--accent), var(--text-strong) 25%)',
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
                        color: 'color-mix(in srgb, var(--accent), var(--text-strong) 25%)',
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
                          color: 'color-mix(in srgb, var(--accent), var(--text-strong) 25%)',
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
                        color: 'color-mix(in srgb, var(--accent), var(--text-strong) 25%)',
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
                        color: 'color-mix(in srgb, var(--accent), var(--text-strong) 25%)',
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
                          color: 'color-mix(in srgb, var(--accent), var(--text-strong) 25%)',
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
            <HandIcon className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="flex-1">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              Trackpad Navigation
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Configure two-finger gestures and alternate modifier behavior.
            </p>
          </div>
        </div>

        <div className="mt-3 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                Trackpad navigation mode
              </div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Two-finger gestures can pan or orbit directly on a trackpad. Pinch-to-zoom stays available either way.
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              {([
                { key: 'off', label: 'Off' },
                { key: 'pan', label: 'Pan' },
                { key: 'orbit', label: 'Orbit' },
              ] as Array<{ key: CameraTrackpadPrimaryAction; label: string }>).map((option) => {
                const active = cameraTrackpadPrimaryAction === option.key;
                return (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => onCameraTrackpadPrimaryActionChange(option.key)}
                    className="h-10 min-w-[96px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
                    style={active
                      ? {
                          borderColor: 'color-mix(in srgb, var(--accent), white 10%)',
                          background: 'color-mix(in srgb, var(--accent), var(--surface-0) 76%)',
                          color: 'color-mix(in srgb, var(--accent), var(--text-strong) 25%)',
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

          {cameraTrackpadPrimaryAction !== 'off' && (
            <>
              <div className="mt-2 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                      Alternate gesture modifier
                    </div>
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      Hold this key to temporarily switch two-finger drag to {cameraTrackpadPrimaryAction === 'pan' ? 'orbit' : 'pan'}.
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {([
                      { key: 'alt', label: 'Option' },
                      { key: 'shift', label: 'Shift' },
                    ] as Array<{ key: CameraTrackpadModifierKey; label: string }>).map((option) => {
                      const active = cameraTrackpadModifierKey === option.key;
                      return (
                        <button
                          key={option.key}
                          type="button"
                          onClick={() => onCameraTrackpadModifierKeyChange(option.key)}
                          className="h-10 min-w-[120px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
                          style={active
                            ? {
                                borderColor: 'color-mix(in srgb, var(--accent), white 10%)',
                                background: 'color-mix(in srgb, var(--accent), var(--surface-0) 76%)',
                                color: 'color-mix(in srgb, var(--accent), var(--text-strong) 25%)',
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

              <div className="mt-2 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
                <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                  Trackpad acceleration
                </div>
                <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  Tune movement speed for two-finger pan/orbit gestures.
                </div>

                <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                  <div className="space-y-0.5">
                    <label className="text-xs flex justify-between" style={{ color: 'var(--text-muted)' }}>
                      <span>Pan acceleration</span>
                      <span style={{ color: 'var(--text-strong)' }}>{cameraTrackpadPanAcceleration.toFixed(2)}x</span>
                    </label>
                    <input
                      type="range"
                      min="0.4"
                      max="4"
                      step="0.05"
                      value={cameraTrackpadPanAcceleration}
                      onChange={(e) => onCameraTrackpadPanAccelerationChange(parseFloat(e.target.value))}
                      className="w-full h-2 rounded-lg appearance-none cursor-pointer"
                      style={{ accentColor: 'var(--accent)', background: 'color-mix(in srgb, var(--text-muted), transparent 72%)' }}
                    />
                  </div>

                  <div className="space-y-0.5">
                    <label className="text-xs flex justify-between" style={{ color: 'var(--text-muted)' }}>
                      <span>Orbit acceleration</span>
                      <span style={{ color: 'var(--text-strong)' }}>{cameraTrackpadOrbitAcceleration.toFixed(2)}x</span>
                    </label>
                    <input
                      type="range"
                      min="0.4"
                      max="4"
                      step="0.05"
                      value={cameraTrackpadOrbitAcceleration}
                      onChange={(e) => onCameraTrackpadOrbitAccelerationChange(parseFloat(e.target.value))}
                      className="w-full h-2 rounded-lg appearance-none cursor-pointer"
                      style={{ accentColor: 'var(--accent)', background: 'color-mix(in srgb, var(--text-muted), transparent 72%)' }}
                    />
                  </div>

                  <div className="space-y-0.5">
                    <label className="text-xs flex justify-between" style={{ color: 'var(--text-muted)' }}>
                      <span>Zoom acceleration</span>
                      <span style={{ color: 'var(--text-strong)' }}>{cameraTrackpadZoomAcceleration.toFixed(2)}x</span>
                    </label>
                    <input
                      type="range"
                      min="0.4"
                      max="4"
                      step="0.05"
                      value={cameraTrackpadZoomAcceleration}
                      onChange={(e) => onCameraTrackpadZoomAccelerationChange(parseFloat(e.target.value))}
                      className="w-full h-2 rounded-lg appearance-none cursor-pointer"
                      style={{ accentColor: 'var(--accent)', background: 'color-mix(in srgb, var(--text-muted), transparent 72%)' }}
                    />
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
