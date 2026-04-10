'use client';

import React from 'react';
import { Cpu, Sparkles, Zap, Trash2 } from 'lucide-react';
import type { SlicingPerformanceSettings } from '@/components/settings/performancePreferences';
import { cleanupAllPrintTempArtifacts, cleanupStalePrintTempArtifacts } from '@/features/slicing/tauri/nativeSlicerBridge';

const SLICING_ENGINE_CRATE = 'dragonfruit-slicing-engine';
const SLICING_ENGINE_VERSION = '3.1.0';

interface PerformanceSettingsTabProps {
  settings: SlicingPerformanceSettings;
  onChange: (settings: SlicingPerformanceSettings) => void;
  showPngCompressionControls?: boolean;
}

export function PerformanceSettingsTab({
  settings,
  onChange,
  showPngCompressionControls = true,
}: PerformanceSettingsTabProps) {
  const patch = React.useCallback((partial: Partial<SlicingPerformanceSettings>) => {
    onChange({ ...settings, ...partial });
  }, [onChange, settings]);

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
