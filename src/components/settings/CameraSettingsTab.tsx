'use client';

import React from 'react';
import { Camera as CameraIcon } from 'lucide-react';
import type { CameraProjectionMode } from '@/components/settings/cameraProjectionPreferences';
import type { CameraFeelPreset } from '@/components/settings/cameraFeelPreferences';
import type { SelectionHighlightMode } from '@/components/selection';
import { SelectionHighlightDropdown } from '@/components/controls/SelectionHighlightDropdown';

interface CameraSettingsTabProps {
  cameraProjectionMode: CameraProjectionMode;
  onCameraProjectionModeChange: (mode: CameraProjectionMode) => void;
  cameraFeelPreset: CameraFeelPreset;
  onCameraFeelPresetChange: (preset: CameraFeelPreset) => void;
  selectionHighlightMode: SelectionHighlightMode;
  onSelectionHighlightModeChange: (mode: SelectionHighlightMode) => void;
}

export function CameraSettingsTab({
  cameraProjectionMode,
  onCameraProjectionModeChange,
  cameraFeelPreset,
  onCameraFeelPresetChange,
  selectionHighlightMode,
  onSelectionHighlightModeChange,
}: CameraSettingsTabProps) {
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
              Global camera projection mode and selection highlight behavior.
            </p>
          </div>
        </div>

        <div className="mt-3 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                Projection mode
              </div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Immediate camera mode (independent from per-workspace defaults).
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

        <div className="mt-2 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                Selection highlight mode
              </div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                In Spotlight mode, DragonFruit combines spotlight and mesh tint together.
              </div>
            </div>
            <SelectionHighlightDropdown
              value={selectionHighlightMode}
              onChange={onSelectionHighlightModeChange}
              fullWidth={false}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
