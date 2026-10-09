'use client';

import React from 'react';
import type { SupportMode } from '@/supports/types';
import { Camera as CameraIcon, Hand as HandIcon } from 'lucide-react';
import type { CameraProjectionMode } from '@/components/settings/cameraProjectionPreferences';
import type { CameraFeelPreset } from '@/components/settings/cameraFeelPreferences';
import type { CameraTrackpadModifierKey, CameraTrackpadPrimaryAction } from '@/components/settings/cameraTrackpadPreferences';
import type { CameraScopeMode, WorkspaceCameraDefaults } from '@/components/settings/workspaceCameraPreferences';
import { FOV_MIN, FOV_MAX } from '@/components/settings/cameraFovPreferences';
import { SegmentedControl, SettingRow } from '@/components/atoms';
import { SelectDropdown } from '@/components/ui/SelectDropdown';

interface CameraSettingsTabProps {
  cameraScope: CameraScopeMode;
  onCameraScopeChange: (scope: CameraScopeMode) => void;
  cameraProjectionMode: CameraProjectionMode;
  onCameraProjectionModeChange: (mode: CameraProjectionMode) => void;
  perspectiveFov: number;
  onPerspectiveFovChange: (fov: number) => void;
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
  higherContrastModelEdges?: boolean;
  onHigherContrastModelEdgesChange?: (value: boolean) => void;
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
  perspectiveFov,
  onPerspectiveFovChange,
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
  higherContrastModelEdges = false,
  onHigherContrastModelEdgesChange,
}: CameraSettingsTabProps) {
  const [activeWorkspace, setActiveWorkspace] = React.useState<SupportMode>('prepare');
  const usingGlobalScope = cameraScope === 'global';
  const usingWorkspaceScope = cameraScope === 'workspace';

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
            <CameraIcon className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="flex-1">
            <h3 className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
              Camera Defaults
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Global camera projection mode and navigation behavior.
            </p>
          </div>
        </div>

        <SettingRow
          bordered
          className="mt-3"
          label="Camera scope"
          description="Choose one global projection mode for every workspace, or set projection defaults per workspace."
        >
          <SegmentedControl
            label="Camera scope"
            value={cameraScope}
            onChange={(next) => onCameraScopeChange(next as CameraScopeMode)}
            options={[
              { value: 'global', label: 'Global' },
              { value: 'workspace', label: 'Workspace' },
            ]}
          />
        </SettingRow>

        {usingGlobalScope && (
          <div className="mt-2 space-y-1.5">
            <SettingRow
              bordered
              label="Projection mode"
              description="Use one projection mode everywhere when global scope is active."
            >
              <SegmentedControl
                label="Projection mode"
                value={cameraProjectionMode}
                onChange={(next) => onCameraProjectionModeChange(next as CameraProjectionMode)}
                options={[
                  { value: 'orthographic', label: 'Ortho' },
                  { value: 'perspective', label: 'Perspective' },
                ]}
              />
            </SettingRow>

            {cameraProjectionMode === 'perspective' && (
              <div className="rounded-md border px-2.5 py-1.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
                <div className="space-y-0.5">
                  <label className="text-xs flex justify-between" style={{ color: 'var(--text-muted)' }}>
                    <span>Field of view</span>
                    <span style={{ color: 'var(--text-strong)' }}>{perspectiveFov}°</span>
                  </label>
                  <input
                    type="range"
                    min={FOV_MIN}
                    max={FOV_MAX}
                    step={1}
                    value={perspectiveFov}
                    onChange={(e) => onPerspectiveFovChange(parseInt(e.target.value, 10))}
                    className="ui-range w-full"
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {usingWorkspaceScope && (
          <div className="mt-2 space-y-1.5">
            <div className="rounded-md border px-2.5 py-1.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
              <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                Workspace camera defaults
              </div>
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Pick the default projection mode used when you enter each workspace.
              </div>

              <div className="mt-2">
                <SegmentedControl<SupportMode>
                  label="Workspace camera defaults"
                  fullWidth
                  value={activeWorkspace}
                  onChange={(next) => setActiveWorkspace(next)}
                  options={workspaceMeta.map((workspace) => ({ value: workspace.key, label: workspace.label }))}
                />
              </div>
            </div>

            <SettingRow
              bordered
              label={`${workspaceMeta.find((workspace) => workspace.key === activeWorkspace)?.label} default camera`}
              description={workspaceMeta.find((workspace) => workspace.key === activeWorkspace)?.hint}
            >
              <SegmentedControl
                label={`${workspaceMeta.find((workspace) => workspace.key === activeWorkspace)?.label} default camera`}
                value={workspaceCameraDefaults[activeWorkspace]}
                onChange={(next) => onWorkspaceCameraModeChange(activeWorkspace, next as CameraProjectionMode)}
                options={[
                  { value: 'orthographic', label: 'Ortho' },
                  { value: 'perspective', label: 'Perspective' },
                ]}
              />
            </SettingRow>
          </div>
        )}

        <SettingRow
          bordered
          className="mt-2"
          label="Camera feel"
          description="Controls smoothing and movement acceleration while orbiting, panning, and zooming."
        >
          <SelectDropdown<CameraFeelPreset>
            value={cameraFeelPreset}
            options={[
              { value: 'raw', label: 'Raw' },
              { value: 'precise', label: 'Precise' },
              { value: 'balanced', label: 'Balanced' },
              { value: 'fast', label: 'Fast' },
            ]}
            onChange={(next) => onCameraFeelPresetChange(next)}
            ariaLabel="Camera feel"
            title="Camera feel"
            className="w-36"
            menuAlign="right"
          />
        </SettingRow>
      </section>

      {/* ── Rendering — Higher Contrast Model Edges ── */}
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
            <CameraIcon className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="flex-1">
            <h3 className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
              Higher Contrast Model Edges
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Overlay black edge lines on model geometry to improve shape definition.
            </p>
          </div>
        </div>

        <SettingRow
          bordered
          className="mt-3"
          label="Edge lines"
          description="Draws black outlines along hard edges of the model for better visual clarity."
        >
          <SegmentedControl
            label="Edge lines"
            value={higherContrastModelEdges ? 'on' : 'off'}
            onChange={(next) => onHigherContrastModelEdgesChange?.(next === 'on')}
            options={[
              { value: 'off', label: 'OFF' },
              { value: 'on', label: 'ON' },
            ]}
          />
        </SettingRow>
      </section>

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
            <HandIcon className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="flex-1">
            <h3 className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
              Trackpad Navigation
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Configure two-finger gestures and alternate modifier behavior.
            </p>
          </div>
        </div>

        <div className="mt-3 space-y-1.5">
          <SettingRow
            bordered
            label="Trackpad navigation mode"
            description="What a two-finger drag does. Pinch-to-zoom still works either way."
          >
            <SelectDropdown<CameraTrackpadPrimaryAction>
              value={cameraTrackpadPrimaryAction}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'pan', label: 'Pan' },
                { value: 'orbit', label: 'Orbit' },
              ]}
              onChange={(next) => onCameraTrackpadPrimaryActionChange(next)}
              ariaLabel="Trackpad navigation mode"
              title="Trackpad navigation mode"
              className="w-36"
              menuAlign="right"
            />
          </SettingRow>

          {cameraTrackpadPrimaryAction !== 'off' && (
            <>
              <SettingRow
                bordered
                label="Alternate gesture modifier"
                description={`Hold this key to temporarily switch two-finger drag to ${cameraTrackpadPrimaryAction === 'pan' ? 'orbit' : 'pan'}.`}
              >
                <SegmentedControl
                  label="Alternate gesture modifier"
                  value={cameraTrackpadModifierKey}
                  onChange={(next) => onCameraTrackpadModifierKeyChange(next as CameraTrackpadModifierKey)}
                  options={[
                    { value: 'alt', label: 'Option' },
                    { value: 'shift', label: 'Shift' },
                  ]}
                />
              </SettingRow>

              <div className="rounded-md border px-2.5 py-1.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
                <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                  Trackpad acceleration
                </div>
                <div className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
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
                      className="ui-range w-full"
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
                      className="ui-range w-full"
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
                      className="ui-range w-full"
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
