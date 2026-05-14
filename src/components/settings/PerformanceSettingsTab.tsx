'use client';

import React from 'react';
import { Cpu, ImageIcon, Sparkles, Trash2, Zap } from 'lucide-react';
import type { SlicingPerformanceSettings } from '@/components/settings/performancePreferences';
import { cleanupAllPrintTempArtifacts, cleanupStalePrintTempArtifacts } from '@/features/slicing/tauri/nativeSlicerBridge';

const SLICING_ENGINE_CRATE = 'dragonfruit-slicing-engine';
const SLICING_ENGINE_VERSION = '3.1.0';

export type SlicingThumbnailRenderSettings = {
  includeGradient: boolean;
  includeBuildPlate: boolean;
  includeGrid: boolean;
};

interface PerformanceSettingsTabProps {
  settings: SlicingPerformanceSettings;
  onChange: (settings: SlicingPerformanceSettings) => void;
  thumbnailSettings: SlicingThumbnailRenderSettings;
  onThumbnailSettingsChange: (settings: SlicingThumbnailRenderSettings) => void;
  showPngCompressionControls?: boolean;
}

export function PerformanceSettingsTab({
  settings,
  onChange,
  thumbnailSettings,
  onThumbnailSettingsChange,
  showPngCompressionControls = true,
}: PerformanceSettingsTabProps) {
  const patch = React.useCallback((partial: Partial<SlicingPerformanceSettings>) => {
    onChange({ ...settings, ...partial });
  }, [onChange, settings]);

  const patchThumbnailSettings = React.useCallback((partial: Partial<SlicingThumbnailRenderSettings>) => {
    onThumbnailSettingsChange({
      ...thumbnailSettings,
      ...partial,
    });
  }, [onThumbnailSettingsChange, thumbnailSettings]);

  const pngCompressionMode: 'auto' | 'on' | 'off' = settings.pngCompressionStrategy === 'auto'
    ? 'auto'
    : settings.pngCompressionStrategy === 'fastest'
      ? 'off'
      : 'on';

  return (
    <div className="space-y-3">
      {/* Slicing Engine Metadata */}
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
            <Cpu className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="flex-1">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              Slicing Engine
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Native Rust slicing via the DragonFruit engine.
            </p>
          </div>
        </div>

        <div className="mt-3 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
            <div>
              <div style={{ color: 'var(--text-muted)' }}>Crate</div>
              <div className="font-semibold" style={{ color: 'var(--text-strong)' }}>{SLICING_ENGINE_CRATE}</div>
            </div>
            <div>
              <div style={{ color: 'var(--text-muted)' }}>Version</div>
              <div className="font-semibold" style={{ color: 'var(--text-strong)' }}>{SLICING_ENGINE_VERSION}</div>
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
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border shrink-0"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'color-mix(in srgb, var(--surface-2), transparent 8%)',
            }}
          >
            <ImageIcon className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="flex-1">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              Thumbnail Rendering
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Configure what appears in generated export/slice thumbnails.
            </p>
          </div>
        </div>

        <div className="mt-3 rounded-md border p-2.5 space-y-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                Background gradient
              </div>
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                Scene mood overlay in thumbnail
              </div>
            </div>
            <button
              type="button"
              aria-pressed={thumbnailSettings.includeGradient}
              onClick={() => patchThumbnailSettings({ includeGradient: !thumbnailSettings.includeGradient })}
              className="h-10 min-w-[92px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
              style={thumbnailSettings.includeGradient
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
              {thumbnailSettings.includeGradient ? 'ON' : 'OFF'}
            </button>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                Build plate
              </div>
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                Render build plate in thumbnail
              </div>
            </div>
            <button
              type="button"
              aria-pressed={thumbnailSettings.includeBuildPlate}
              onClick={() => patchThumbnailSettings({ includeBuildPlate: !thumbnailSettings.includeBuildPlate })}
              className="h-10 min-w-[92px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
              style={thumbnailSettings.includeBuildPlate
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
              {thumbnailSettings.includeBuildPlate ? 'ON' : 'OFF'}
            </button>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                Grid
              </div>
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                Render build grid in thumbnail
              </div>
            </div>
            <button
              type="button"
              aria-pressed={thumbnailSettings.includeGrid}
              onClick={() => patchThumbnailSettings({ includeGrid: !thumbnailSettings.includeGrid })}
              className="h-10 min-w-[92px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
              style={thumbnailSettings.includeGrid
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
              {thumbnailSettings.includeGrid ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>
      </section>

      {showPngCompressionControls && (
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
              <Zap className="h-4 w-4" style={{ color: 'var(--accent)' }} />
            </span>
            <div className="flex-1">
              <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                PNG Compression
              </h3>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                Enable or disable PNG compression for PNG-based formats.
              </p>
            </div>
          </div>

          <div className="mt-3 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                  Compression
                </div>
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  Auto adapts by AA level, Off is fastest, On favors smaller PNG files
                </div>
              </div>
              <div className="flex gap-1.5">
                {([
                  { key: 'auto', label: 'Auto' },
                  { key: 'off', label: 'Off' },
                  { key: 'on', label: 'On' },
                ] as const).map((option) => {
                  const active = pngCompressionMode === option.key;
                  return (
                    <button
                      key={option.key}
                      type="button"
                      onClick={() => patch({
                        pngCompressionStrategy: option.key === 'auto'
                          ? 'auto'
                          : option.key === 'off'
                            ? 'fastest'
                            : 'balanced',
                      })}
                      className="h-10 min-w-[76px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
                      style={active
                        ? {
                            borderColor: 'color-mix(in srgb, var(--accent), white 10%)',
                            background: 'color-mix(in srgb, var(--accent), var(--surface-0) 76%)',
                            color: 'var(--accent)',
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
      )}

      {/* BVH Acceleration Section */}
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
            <Sparkles className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="flex-1">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              Spatial Acceleration
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Bounding Volume Hierarchy for complex geometry.
            </p>
          </div>
        </div>

        <div className="mt-3 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                BVH Acceleration
              </div>
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                Auto-enabled for 10K+ triangles
              </div>
            </div>
            <button
              type="button"
              onClick={() => patch({ bvhAccelerationEnabled: !settings.bvhAccelerationEnabled })}
              className="h-10 min-w-[92px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
              style={settings.bvhAccelerationEnabled
                ? {
                    borderColor: 'color-mix(in srgb, var(--accent), white 10%)',
                    background: 'color-mix(in srgb, var(--accent), var(--surface-0) 76%)',
                    color: 'var(--accent)',
                  }
                : {
                    borderColor: 'var(--border-subtle)',
                    background: 'var(--surface-1)',
                    color: 'var(--text-muted)',
                  }}
            >
              {settings.bvhAccelerationEnabled ? 'On' : 'Off'}
            </button>
          </div>
        </div>
      </section>

      {/* Experimental Slicing Toggles */}
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
            <Sparkles className="h-4 w-4" style={{ color: 'var(--accent-secondary)' }} />
          </span>
          <div className="flex-1">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              Experimental
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Advanced slicing toggles that are not recommended for most prints.
            </p>
          </div>
        </div>

        <div className="mt-3 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                AA on Supports
              </div>
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                Off by default. Keeps support/raft geometry crisp and avoids unnecessary anti-aliased halos.
              </div>
            </div>
            <button
              type="button"
              onClick={() => patch({ aaOnSupportsExperimental: !settings.aaOnSupportsExperimental })}
              className="h-10 min-w-[92px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
              style={settings.aaOnSupportsExperimental
                ? {
                    borderColor: 'color-mix(in srgb, var(--accent), white 10%)',
                    background: 'color-mix(in srgb, var(--accent), var(--surface-0) 76%)',
                    color: 'var(--accent)',
                  }
                : {
                    borderColor: 'var(--border-subtle)',
                    background: 'var(--surface-1)',
                    color: 'var(--text-muted)',
                  }}
            >
              {settings.aaOnSupportsExperimental ? 'On' : 'Off'}
            </button>
          </div>
        </div>
      </section>

      {/* Temp File Cleanup Section */}
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
            <Trash2 className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="flex-1">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              Temp File Cleanup
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Free disk space by removing temporary slice files.
            </p>
          </div>
        </div>

        <div className="mt-3 space-y-2">
          <button
            type="button"
            onClick={async () => {
              try {
                const removed = await cleanupStalePrintTempArtifacts(60 * 60);
                alert(`Cleaned ${removed} temp file(s) older than 1 hour.`);
              } catch (error) {
                console.error('[Cleanup] Failed:', error);
                alert('Cleanup failed. See console for details.');
              }
            }}
            className="w-full rounded-md border p-2.5 text-left transition-all hover:border-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent),var(--surface-0)_92%)]"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'var(--surface-0)',
            }}
          >
            <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
              Clean Stale Files
            </div>
            <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Remove temp files older than 1 hour
            </div>
          </button>

          <button
            type="button"
            onClick={async () => {
              if (!confirm('Delete ALL temporary slice files? This cannot be undone.')) return;
              try {
                const removed = await cleanupAllPrintTempArtifacts();
                alert(`Cleaned ${removed} temp file(s).`);
              } catch (error) {
                console.error('[Cleanup] Failed:', error);
                alert('Cleanup failed. See console for details.');
              }
            }}
            className="w-full rounded-md border p-2.5 text-left transition-all hover:border-red-500/50 hover:bg-red-500/5"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'var(--surface-0)',
            }}
          >
            <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
              Clean All Files
            </div>
            <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Emergency cleanup: delete all temp slices
            </div>
          </button>
        </div>
      </section>
    </div>
  );
}

export default PerformanceSettingsTab;
