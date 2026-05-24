'use client';

import React from 'react';
import { Compass } from 'lucide-react';
import { NumberInput } from '@/components/ui/NumberInput';
import {
  DEFAULT_ROTATION_SNAP_SETTINGS,
  ROTATION_SNAP_PRESETS,
  ROTATION_SNAP_PRESET_LABELS,
  MIN_TIER_DEGREES,
  MAX_TIER_DEGREES,
  getSavedRotationSnapSettings,
  saveRotationSnapSettings,
  getRotationSnapPresetId,
  toSnapTickConfig,
  type RotationSnapSettings,
  type RotationSnapPresetId,
  type SnapTierRole,
} from '@/components/settings/rotationSnapPreferences';
import { getSnapTicks } from '@/components/gizmo/rotate/snapRotation';

const PRESET_SUBTITLES: Record<keyof typeof ROTATION_SNAP_PRESETS, string> = {
  standard: '45 / 15 / 5',
  fine: '15 / 5 / 1',
};

const TIER_META: { role: SnapTierRole; label: string; hint: string }[] = [
  { role: 'coarse', label: 'Coarse', hint: 'Cmd/Ctrl + Drag snap · longest tick' },
  { role: 'fine', label: 'Fine', hint: 'Cmd/Ctrl + Shift + Drag snap · medium tick' },
  { role: 'visual', label: 'Visual', hint: 'Ticks only, no snap · shortest tick' },
];

function degreesForRole(settings: RotationSnapSettings, role: SnapTierRole): number {
  return settings.tiers.find((tier) => tier.role === role)?.degrees ?? 0;
}

/** Small top-down SVG of the ring showing tick positions for the current config. */
function TickPreview({ settings }: { settings: RotationSnapSettings }) {
  const size = 132;
  const center = size / 2;
  const outer = center - 6;
  const ticks = getSnapTicks(toSnapTickConfig(settings));
  const tierOpacity: Record<string, number> = { major: 1, medium: 0.72, minor: 0.4 };
  const maxLen = outer * 0.42;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="Tick mark preview"
    >
      <circle
        cx={center}
        cy={center}
        r={outer}
        fill="none"
        stroke="var(--border-strong)"
        strokeWidth={1}
      />
      {ticks.map((tick, i) => {
        const len = maxLen * tick.lengthMult;
        const cos = Math.cos(tick.angleRad);
        const sin = Math.sin(tick.angleRad);
        return (
          <line
            key={i}
            x1={center + cos * outer}
            y1={center - sin * outer}
            x2={center + cos * (outer - len)}
            y2={center - sin * (outer - len)}
            stroke="var(--accent)"
            strokeWidth={tick.tier === 'major' ? 1.6 : tick.tier === 'medium' ? 1.1 : 0.7}
            strokeOpacity={tierOpacity[tick.tier]}
            strokeLinecap="round"
          />
        );
      })}
    </svg>
  );
}

/**
 * TransformSettingsTab — configure the rotation gizmo's snap increments and tick
 * intervals. Self-contained (own state, saves on change like SceneAutosaveSettingsTab),
 * so edits apply immediately and the gizmo subscribes for live updates. The live
 * preview is rendered in-tab because the settings modal occludes the 3D gizmo.
 *
 * Preset mode (Standard / Fine) is an explicit selection; "Custom" is also a
 * real choice that seeds 45/15/5 and lets the user type arbitrary whole-degree
 * intervals. Editing any field switches the selection to Custom.
 */
export function TransformSettingsTab() {
  const [settings, setSettings] = React.useState<RotationSnapSettings>(() =>
    getSavedRotationSnapSettings(),
  );
  const [selected, setSelected] = React.useState<RotationSnapPresetId>(() =>
    getRotationSnapPresetId(getSavedRotationSnapSettings()),
  );

  React.useEffect(() => {
    saveRotationSnapSettings(settings);
  }, [settings]);

  const applyPreset = React.useCallback((key: keyof typeof ROTATION_SNAP_PRESETS) => {
    setSettings(ROTATION_SNAP_PRESETS[key]);
    setSelected(key);
  }, []);

  const enterCustom = React.useCallback(() => {
    // Seed 45/15/5 when entering Custom from a preset; keep current values if
    // already Custom (don't clobber the user's edits).
    setSelected((prev) => {
      if (prev !== 'custom') setSettings(DEFAULT_ROTATION_SNAP_SETTINGS);
      return 'custom';
    });
  }, []);

  const setRoleDegrees = React.useCallback((role: SnapTierRole, raw: number) => {
    if (!Number.isFinite(raw)) return;
    const degrees = Math.max(MIN_TIER_DEGREES, Math.min(MAX_TIER_DEGREES, Math.round(raw)));
    setSettings((prev) => ({
      tiers: prev.tiers.map((tier) => (tier.role === role ? { ...tier, degrees } : tier)),
    }));
    setSelected('custom'); // editing an interval is a custom configuration
  }, []);

  const presetButtons: { key: RotationSnapPresetId; label: string; subtitle?: string }[] = [
    { key: 'standard', label: ROTATION_SNAP_PRESET_LABELS.standard, subtitle: PRESET_SUBTITLES.standard },
    { key: 'fine', label: ROTATION_SNAP_PRESET_LABELS.fine, subtitle: PRESET_SUBTITLES.fine },
    { key: 'custom', label: ROTATION_SNAP_PRESET_LABELS.custom },
  ];

  return (
    <div className="space-y-3">
      <section
        className="rounded-lg border p-3"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
      >
        <div className="flex items-start gap-2.5">
          <span
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'color-mix(in srgb, var(--surface-2), transparent 8%)',
            }}
          >
            <Compass className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              Rotation Snap &amp; Tick Marks
            </h3>
            <p className="mt-0.5 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              Tick intervals around the rotation gizmo ring. Coarse and fine intervals also set the
              snap increments held with Cmd/Ctrl (and Shift for fine). Custom intervals can be any
              whole number of degrees.
            </p>
          </div>
        </div>

        {/* Preset shortcuts (incl. clickable Custom) */}
        <div className="mt-3 flex flex-wrap gap-2">
          {presetButtons.map(({ key, label, subtitle }) => {
            const active = selected === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => (key === 'custom' ? enterCustom() : applyPreset(key))}
                className="h-8 rounded-md border px-3 text-[12px] font-semibold transition-colors"
                aria-pressed={active}
                style={
                  active
                    ? {
                        borderColor: 'color-mix(in srgb, var(--accent), white 10%)',
                        background: 'color-mix(in srgb, var(--accent), var(--surface-0) 76%)',
                        color: 'color-mix(in srgb, var(--accent), var(--text-strong) 25%)',
                      }
                    : {
                        borderColor: 'var(--border-subtle)',
                        background: 'var(--surface-1)',
                        color: 'var(--text-muted)',
                      }
                }
              >
                {label}
                {subtitle ? <span className="ml-1 opacity-70">({subtitle})</span> : null}
              </button>
            );
          })}
        </div>

        {/* Per-tier interval inputs + live preview */}
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="flex-1 grid gap-2">
            {TIER_META.map(({ role, label, hint }) => (
              <div
                key={role}
                className="rounded-md border px-2.5 py-2 flex items-center justify-between gap-3"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}
              >
                <div className="min-w-0">
                  <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                    {label}
                  </div>
                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {hint}
                  </div>
                </div>
                <div className="inline-flex items-center gap-2">
                  <NumberInput
                    min={MIN_TIER_DEGREES}
                    max={MAX_TIER_DEGREES}
                    step={1}
                    value={degreesForRole(settings, role)}
                    onChange={(next) => setRoleDegrees(role, next)}
                    className="ui-input h-[34px] w-[88px] pl-2.5 pr-5 py-1.5 text-sm"
                    aria-label={`${label} interval in degrees`}
                  />
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    deg
                  </span>
                </div>
              </div>
            ))}
          </div>

          <div
            className="flex flex-col items-center gap-1.5 rounded-md border p-2.5"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}
          >
            <TickPreview settings={settings} />
            <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              Live preview
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
