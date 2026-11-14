'use client';

import React from 'react';
import { useLingui } from '@lingui/react';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { SupportMode } from '@/supports/types';
import { Camera as CameraIcon, Hand as HandIcon } from 'lucide-react';
import type { CameraProjectionMode } from '@/components/settings/cameraProjectionPreferences';
import type { CameraFeelPreset } from '@/components/settings/cameraFeelPreferences';
import type { CameraTrackpadModifierKey, CameraTrackpadPrimaryAction } from '@/components/settings/cameraTrackpadPreferences';
import type { CameraScopeMode, WorkspaceCameraDefaults } from '@/components/settings/workspaceCameraPreferences';
import { FOV_MIN, FOV_MAX } from '@/components/settings/cameraFovPreferences';
import { SegmentedControl, SettingRow } from '@/components/atoms';
import { SelectDropdown } from '@/components/ui/SelectDropdown';
import { useLocaleFormat } from '@/hooks/useLocaleFormat';

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

type TranslateFn = (descriptor: MessageDescriptor) => string;

function formatWorkspaceDefaultCameraLabel(translate: TranslateFn, workspaceLabel: string): string {
  return translate(msg`${workspaceLabel} default camera`);
}

function formatAlternateGestureDescription(translate: TranslateFn, targetAction: string): string {
  return translate(msg`Hold this key to temporarily switch two-finger drag to ${targetAction}.`);
}

const workspaceMeta: Array<{ key: SupportMode; label: MessageDescriptor; hint: MessageDescriptor }> = [
  { key: 'prepare', label: msg`Prepare`, hint: msg`Model prep and transform workflows` },
  { key: 'analysis', label: msg`Analysis`, hint: msg`Island diagnostics and inspection tools` },
  { key: 'support', label: msg`Support`, hint: msg`Support placement and editing workspace` },
  { key: 'export', label: msg`Export`, hint: msg`Final output and export pipeline` },
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
  const { _ } = useLingui();
  const fmt = useLocaleFormat();
  const [activeWorkspace, setActiveWorkspace] = React.useState<SupportMode>('prepare');
  const usingGlobalScope = cameraScope === 'global';
  const usingWorkspaceScope = cameraScope === 'workspace';

  const activeWorkspaceMeta = workspaceMeta.find((workspace) => workspace.key === activeWorkspace);
  const activeWorkspaceLabel = activeWorkspaceMeta ? _(activeWorkspaceMeta.label) : '';
  const activeWorkspaceHint = activeWorkspaceMeta ? _(activeWorkspaceMeta.hint) : undefined;

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
              <Trans>Camera Defaults</Trans>
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              <Trans>Global camera projection mode and navigation behavior.</Trans>
            </p>
          </div>
        </div>

        <SettingRow
          bordered
          className="mt-3"
          label={_(msg`Camera scope`)}
          description={_(msg`Choose one global projection mode for every workspace, or set projection defaults per workspace.`)}
        >
          <SegmentedControl
            label={_(msg`Camera scope`)}
            value={cameraScope}
            onChange={(next) => onCameraScopeChange(next as CameraScopeMode)}
            options={[
              { value: 'global', label: _(msg`Global`) },
              { value: 'workspace', label: _(msg`Workspace`) },
            ]}
          />
        </SettingRow>

        {usingGlobalScope && (
          <div className="mt-2 space-y-1.5">
            <SettingRow
              bordered
              label={_(msg`Projection mode`)}
              description={_(msg`Use one projection mode everywhere when global scope is active.`)}
            >
              <SegmentedControl
                label={_(msg`Projection mode`)}
                value={cameraProjectionMode}
                onChange={(next) => onCameraProjectionModeChange(next as CameraProjectionMode)}
                options={[
                  { value: 'orthographic', label: _(msg`Ortho`) },
                  { value: 'perspective', label: _(msg`Perspective`) },
                ]}
              />
            </SettingRow>

            {cameraProjectionMode === 'perspective' && (
              <div className="rounded-md border px-2.5 py-1.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
                <div className="space-y-0.5">
                  <label className="text-xs flex justify-between" style={{ color: 'var(--text-muted)' }}>
                    <span><Trans>Field of view</Trans></span>
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
                <Trans>Workspace camera defaults</Trans>
              </div>
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                <Trans>Pick the default projection mode used when you enter each workspace.</Trans>
              </div>

              <div className="mt-2">
                <SegmentedControl<SupportMode>
                  label={_(msg`Workspace camera defaults`)}
                  fullWidth
                  value={activeWorkspace}
                  onChange={(next) => setActiveWorkspace(next)}
                  options={workspaceMeta.map((workspace) => ({ value: workspace.key, label: _(workspace.label) }))}
                />
              </div>
            </div>

            <SettingRow
              bordered
              label={formatWorkspaceDefaultCameraLabel(_, activeWorkspaceLabel)}
              description={activeWorkspaceHint}
            >
              <SegmentedControl
                label={formatWorkspaceDefaultCameraLabel(_, activeWorkspaceLabel)}
                value={workspaceCameraDefaults[activeWorkspace]}
                onChange={(next) => onWorkspaceCameraModeChange(activeWorkspace, next as CameraProjectionMode)}
                options={[
                  { value: 'orthographic', label: _(msg`Ortho`) },
                  { value: 'perspective', label: _(msg`Perspective`) },
                ]}
              />
            </SettingRow>
          </div>
        )}

        <SettingRow
          bordered
          className="mt-2"
          label={_(msg`Camera feel`)}
          description={_(msg`Controls smoothing and movement acceleration while orbiting, panning, and zooming.`)}
        >
          <SelectDropdown<CameraFeelPreset>
            value={cameraFeelPreset}
            options={[
              { value: 'raw', label: _(msg`Raw`) },
              { value: 'precise', label: _(msg`Precise`) },
              { value: 'balanced', label: _(msg`Balanced`) },
              { value: 'fast', label: _(msg`Fast`) },
            ]}
            onChange={(next) => onCameraFeelPresetChange(next)}
            ariaLabel={_(msg`Camera feel`)}
            title={_(msg`Camera feel`)}
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
              <Trans>Higher Contrast Model Edges</Trans>
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              <Trans>Overlay black edge lines on model geometry to improve shape definition.</Trans>
            </p>
          </div>
        </div>

        <SettingRow
          bordered
          className="mt-3"
          label={_(msg`Edge lines`)}
          description={_(msg`Draws black outlines along hard edges of the model for better visual clarity.`)}
        >
          <SegmentedControl
            label={_(msg`Edge lines`)}
            value={higherContrastModelEdges ? 'on' : 'off'}
            onChange={(next) => onHigherContrastModelEdgesChange?.(next === 'on')}
            options={[
              { value: 'off', label: _(msg`OFF`) },
              { value: 'on', label: _(msg`ON`) },
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
              <Trans>Trackpad Navigation</Trans>
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              <Trans>Configure two-finger gestures and alternate modifier behavior.</Trans>
            </p>
          </div>
        </div>

        <div className="mt-3 space-y-1.5">
          <SettingRow
            bordered
            label={_(msg`Trackpad navigation mode`)}
            description={_(msg`What a two-finger drag does. Pinch-to-zoom still works either way.`)}
          >
            <SelectDropdown<CameraTrackpadPrimaryAction>
              value={cameraTrackpadPrimaryAction}
              options={[
                { value: 'off', label: _(msg`Off`) },
                { value: 'pan', label: _(msg`Pan`) },
                { value: 'orbit', label: _(msg`Orbit`) },
              ]}
              onChange={(next) => onCameraTrackpadPrimaryActionChange(next)}
              ariaLabel={_(msg`Trackpad navigation mode`)}
              title={_(msg`Trackpad navigation mode`)}
              className="w-36"
              menuAlign="right"
            />
          </SettingRow>

          {cameraTrackpadPrimaryAction !== 'off' && (
            <>
              <SettingRow
                bordered
                label={_(msg`Alternate gesture modifier`)}
                description={formatAlternateGestureDescription(
                  _,
                  cameraTrackpadPrimaryAction === 'pan' ? _(msg`orbit`) : _(msg`pan`),
                )}
              >
                <SegmentedControl
                  label={_(msg`Alternate gesture modifier`)}
                  value={cameraTrackpadModifierKey}
                  onChange={(next) => onCameraTrackpadModifierKeyChange(next as CameraTrackpadModifierKey)}
                  options={[
                    { value: 'alt', label: _(msg`Option`) },
                    { value: 'shift', label: _(msg`Shift`) },
                  ]}
                />
              </SettingRow>

              <div className="rounded-md border px-2.5 py-1.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
                <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                  <Trans>Trackpad acceleration</Trans>
                </div>
                <div className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                  <Trans>Tune movement speed for two-finger pan/orbit gestures.</Trans>
                </div>

                <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                  <div className="space-y-0.5">
                    <label className="text-xs flex justify-between" style={{ color: 'var(--text-muted)' }}>
                      <span><Trans>Pan acceleration</Trans></span>
                      <span style={{ color: 'var(--text-strong)' }}>{fmt.quantity(cameraTrackpadPanAcceleration, 2, 'times')}</span>
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
                      <span><Trans>Orbit acceleration</Trans></span>
                      <span style={{ color: 'var(--text-strong)' }}>{fmt.quantity(cameraTrackpadOrbitAcceleration, 2, 'times')}</span>
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
                      <span><Trans>Zoom acceleration</Trans></span>
                      <span style={{ color: 'var(--text-strong)' }}>{fmt.quantity(cameraTrackpadZoomAcceleration, 2, 'times')}</span>
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
