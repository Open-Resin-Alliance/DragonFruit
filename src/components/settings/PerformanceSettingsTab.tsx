'use client';

import React from 'react';
import { Cpu, Gauge, Sparkles, Zap, Trash2 } from 'lucide-react';
import type { SlicingPerformanceSettings, PngCompressionStrategy } from '@/components/settings/performancePreferences';
import { cleanupAllPrintTempArtifacts, cleanupStalePrintTempArtifacts } from '@/features/slicing/tauri/nativeSlicerBridge';

interface PerformanceSettingsTabProps {
  settings: SlicingPerformanceSettings;
  onChange: (settings: SlicingPerformanceSettings) => void;
}

export function PerformanceSettingsTab({
  settings,
  onChange,
}: PerformanceSettingsTabProps) {
  const patch = React.useCallback((partial: Partial<SlicingPerformanceSettings>) => {
    onChange({ ...settings, ...partial });
  }, [onChange, settings]);

  return (
    <div className="space-y-3">
      {/* Compute Backend Section */}
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
              Compute Backend
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Native Rust slicer backend (Tauri desktop).
            </p>
          </div>
        </div>

        <div className="mt-3 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          <div className="flex gap-2">
            {([
              { key: 'auto', label: 'Auto', desc: 'Best available' },
              { key: 'cpu', label: 'CPU', desc: 'Stable' },
              { key: 'gpu', label: 'GPU', desc: 'Experimental' },
            ] as const).map((option) => {
              const active = settings.computeBackend === option.key;
              return (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => patch({ computeBackend: option.key })}
                  className="flex-1 rounded-md border px-2.5 py-2 text-center transition-all"
                  style={{
                    borderColor: active ? 'var(--accent)' : 'var(--border-subtle)',
                    background: active ? 'color-mix(in srgb, var(--accent), var(--surface-0) 84%)' : 'var(--surface-1)',
                  }}
                >
                  <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: active ? 'var(--accent)' : 'var(--text-strong)' }}>
                    {option.label}
                  </div>
                  <div className="text-[9px] mt-0.5" style={{ color: active ? 'var(--accent)' : 'var(--text-muted)' }}>
                    {option.desc}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* CPU Profile Section */}
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
            <Gauge className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="flex-1">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              CPU Profile
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Trade-off between speed and output quality.
            </p>
          </div>
        </div>

        <div className="mt-3 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          <div className="flex gap-2">
            {([
              { key: 'balanced', label: 'Balanced', icon: Gauge },
              { key: 'max', label: 'Max', icon: Sparkles },
            ] as const).map((option) => {
              const active = settings.cpuProfile === option.key;
              const Icon = option.icon;
              return (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => patch({ cpuProfile: option.key })}
                  className="flex-1 h-9 rounded-md border px-2 text-xs font-semibold uppercase tracking-wide transition-all inline-flex items-center justify-center gap-1.5"
                  style={{
                    borderColor: active ? 'var(--accent)' : 'var(--border-subtle)',
                    background: active ? 'color-mix(in srgb, var(--accent), var(--surface-0) 84%)' : 'var(--surface-1)',
                    color: active ? 'var(--accent)' : 'var(--text-muted)',
                  }}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* PNG Compression Section */}
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
              Lossless PNG encoding strategy.
            </p>
          </div>
        </div>

        <div className="mt-3 space-y-2">
          {([
            { key: 'fastest', label: 'Fastest', desc: '5-10µs – Real-time previews' },
            { key: 'balanced', label: 'Balanced', desc: '50-100µs – Default balance' },
            { key: 'smallest', label: 'Smallest', desc: '200-400µs – Compact files' },
            { key: 'optimal', label: 'Optimal', desc: '300-500µs – Maximum compression' },
          ] as const).map((option) => {
            const active = settings.pngCompressionStrategy === option.key;
            return (
              <button
                key={option.key}
                type="button"
                onClick={() => patch({ pngCompressionStrategy: option.key as PngCompressionStrategy })}
                className="w-full rounded-md border p-2.5 text-left transition-all"
                style={{
                  borderColor: active ? 'var(--accent)' : 'var(--border-subtle)',
                  background: active ? 'color-mix(in srgb, var(--accent), var(--surface-0) 84%)' : 'var(--surface-0)',
                }}
              >
                <div className="text-xs font-semibold" style={{ color: active ? 'var(--accent)' : 'var(--text-strong)' }}>
                  {option.label}
                </div>
                <div className="text-[11px] mt-0.5" style={{ color: active ? 'var(--accent)' : 'var(--text-muted)' }}>
                  {option.desc}
                </div>
              </button>
            );
          })}
        </div>
      </section>

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
