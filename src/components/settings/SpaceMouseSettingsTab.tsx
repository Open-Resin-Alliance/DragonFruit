'use client';

import React from 'react';
import { ArrowLeftRight, Gamepad2, MousePointer2, SlidersHorizontal } from 'lucide-react';
import type { SpaceMouseSettings } from '@/components/settings/spacemousePreferences';
import { Select } from '@/components/ui/primitives';

type SpaceMouseSettingsTabProps = {
  settings: SpaceMouseSettings;
  onChange: (partial: Partial<SpaceMouseSettings>) => void;
};

function formatNumber(value: number) {
  return value.toFixed(2);
}

export function SpaceMouseSettingsTab({ settings, onChange }: SpaceMouseSettingsTabProps) {
  const [connectedDevice, setConnectedDevice] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return;

    const matchSpaceMouse = () => {
      const pads = navigator.getGamepads?.() ?? [];
      const found = Array.from(pads).find((pad) => pad && /spacemouse|3dconnexion|space navigator|spacepilot/i.test(pad.id));
      setConnectedDevice(found?.id ?? null);
    };

    matchSpaceMouse();
    const interval = window.setInterval(matchSpaceMouse, 800);

    window.addEventListener('gamepadconnected', matchSpaceMouse);
    window.addEventListener('gamepaddisconnected', matchSpaceMouse);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener('gamepadconnected', matchSpaceMouse);
      window.removeEventListener('gamepaddisconnected', matchSpaceMouse);
    };
  }, []);

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
            <MousePointer2 className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="flex-1">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              3D Mouse Input
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              6-DoF navigation for pan, orbit, zoom, and roll using compatible 3D mouse devices.
            </p>
          </div>
        </div>

        <div className="mt-3 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                Enable 3D Mouse
              </div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Uses browser gamepad input from supported 3D mouse devices.
              </div>
            </div>
            <button
              type="button"
              onClick={() => onChange({ enabled: !settings.enabled })}
              className="h-10 min-w-[92px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
              style={settings.enabled
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
              {settings.enabled ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>

        <div className="mt-2 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          <div className="flex items-start gap-2">
            <Gamepad2 className="h-4 w-4 mt-0.5" style={{ color: connectedDevice ? 'var(--accent)' : 'var(--text-muted)' }} />
            <div className="min-w-0">
              <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                Device status
              </div>
              <div className="text-[11px] break-words" style={{ color: 'var(--text-muted)' }}>
                {connectedDevice ?? 'No 3D mouse detected yet. Ensure driver is installed and browser input is permitted.'}
              </div>
              <div className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                Note: some Bluetooth 3D mouse models may still work even if they do not appear in detected device status.
              </div>
            </div>
          </div>
        </div>

        <div className="mt-2 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          <div className="space-y-1">
            <label className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
              Pivot mode
            </label>
            <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Auto picks selected/single/nearest model center. Camera Raycast picks the model center nearest your current view beam.
            </p>
            <Select
              value={settings.pivotMode}
              onChange={(e) => onChange({ pivotMode: e.target.value as SpaceMouseSettings['pivotMode'] })}
              className="w-full !h-8"
            >
              <option value="auto">Auto</option>
              <option value="camera-ray">Camera Raycast</option>
            </Select>
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
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border shrink-0"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'color-mix(in srgb, var(--surface-2), transparent 8%)',
            }}
          >
            <SlidersHorizontal className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="flex-1">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              Motion Tuning
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Adjust sensitivity and movement behavior for translation, rotation, zoom, and deadzone.
            </p>
          </div>
        </div>

        <div className="mt-2 grid grid-cols-2 gap-2">
          <div className="space-y-0.5">
            <label className="text-xs flex justify-between" style={{ color: 'var(--text-muted)' }}>
              <span>Translation</span>
              <span style={{ color: 'var(--text-strong)' }}>{formatNumber(settings.translationSensitivity)}</span>
            </label>
            <input
              type="range"
              min="0.1"
              max="4"
              step="0.05"
              value={settings.translationSensitivity}
              onChange={(e) => onChange({ translationSensitivity: parseFloat(e.target.value) })}
              className="w-full h-2 rounded-lg appearance-none cursor-pointer"
              style={{ accentColor: 'var(--accent)', background: 'color-mix(in srgb, var(--text-muted), transparent 72%)' }}
            />
          </div>

          <div className="space-y-0.5">
            <label className="text-xs flex justify-between" style={{ color: 'var(--text-muted)' }}>
              <span>Rotation</span>
              <span style={{ color: 'var(--text-strong)' }}>{formatNumber(settings.rotationSensitivity)}</span>
            </label>
            <input
              type="range"
              min="0.1"
              max="4"
              step="0.05"
              value={settings.rotationSensitivity}
              onChange={(e) => onChange({ rotationSensitivity: parseFloat(e.target.value) })}
              className="w-full h-2 rounded-lg appearance-none cursor-pointer"
              style={{ accentColor: 'var(--accent)', background: 'color-mix(in srgb, var(--text-muted), transparent 72%)' }}
            />
          </div>

          <div className="space-y-0.5">
            <label className="text-xs flex justify-between" style={{ color: 'var(--text-muted)' }}>
              <span>Zoom</span>
              <span style={{ color: 'var(--text-strong)' }}>{formatNumber(settings.zoomSensitivity)}</span>
            </label>
            <input
              type="range"
              min="0.1"
              max="4"
              step="0.05"
              value={settings.zoomSensitivity}
              onChange={(e) => onChange({ zoomSensitivity: parseFloat(e.target.value) })}
              className="w-full h-2 rounded-lg appearance-none cursor-pointer"
              style={{ accentColor: 'var(--accent)', background: 'color-mix(in srgb, var(--text-muted), transparent 72%)' }}
            />
          </div>

          <div className="space-y-0.5">
            <label className="text-xs flex justify-between" style={{ color: 'var(--text-muted)' }}>
              <span>Deadzone</span>
              <span style={{ color: 'var(--text-strong)' }}>{formatNumber(settings.deadzone)}</span>
            </label>
            <input
              type="range"
              min="0"
              max="0.3"
              step="0.01"
              value={settings.deadzone}
              onChange={(e) => onChange({ deadzone: parseFloat(e.target.value) })}
              className="w-full h-2 rounded-lg appearance-none cursor-pointer"
              style={{ accentColor: 'var(--accent)', background: 'color-mix(in srgb, var(--text-muted), transparent 72%)' }}
            />
          </div>
        </div>

        <div className="mt-2 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                Dominant axis mode
              </div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Prioritize strongest axis per translation/rotation group for steadier input.
              </div>
            </div>
            <button
              type="button"
              onClick={() => onChange({ dominantAxis: !settings.dominantAxis })}
              className="h-10 min-w-[92px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
              style={settings.dominantAxis
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
              {settings.dominantAxis ? 'ON' : 'OFF'}
            </button>
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
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border shrink-0"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'color-mix(in srgb, var(--surface-2), transparent 8%)',
            }}
          >
            <ArrowLeftRight className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="flex-1">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              Axis Inversion
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Flip the direction of individual pan, zoom, pitch, yaw, and roll axes.
            </p>
          </div>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
          {([
            ['invertTx', 'Invert X pan'],
            ['invertTy', 'Invert Y pan'],
            ['invertTz', 'Invert zoom'],
            ['invertRx', 'Invert pitch'],
            ['invertRy', 'Invert yaw'],
            ['invertRz', 'Invert roll'],
          ] as Array<[keyof SpaceMouseSettings, string]>).map(([key, label]) => (
            <label key={key} className="inline-flex items-center gap-2 rounded border px-2 py-1.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
              <input
                type="checkbox"
                checked={!!settings[key]}
                onChange={(e) => onChange({ [key]: e.target.checked })}
                className="ui-checkbox !w-3.5 !h-3.5"
              />
              <span style={{ color: 'var(--text-muted)' }}>{label}</span>
            </label>
          ))}
        </div>
      </section>

      <div
        className="rounded-md border px-3 py-2"
        style={{
          borderColor: 'color-mix(in srgb, var(--border-subtle), var(--accent) 20%)',
          background: 'color-mix(in srgb, var(--surface-1), var(--accent) 4%)',
        }}
      >
        <p className="text-[10px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          Supports 3Dconnexion SpaceMouse devices. “SpaceMouse” is a trademark of 3Dconnexion.
        </p>
      </div>
    </div>
  );
}
