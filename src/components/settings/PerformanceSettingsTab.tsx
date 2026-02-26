'use client';

import React from 'react';
import { Cpu, Gauge, Sparkles } from 'lucide-react';
import type { SlicingPerformanceSettings } from '@/components/settings/performancePreferences';

interface PerformanceSettingsTabProps {
  settings: SlicingPerformanceSettings;
  webGpuSupported: boolean;
  webGpuStatusText: string;
  onChange: (settings: SlicingPerformanceSettings) => void;
}

export function PerformanceSettingsTab({
  settings,
  webGpuSupported,
  webGpuStatusText,
  onChange,
}: PerformanceSettingsTabProps) {
  const patch = React.useCallback((partial: Partial<SlicingPerformanceSettings>) => {
    onChange({ ...settings, ...partial });
  }, [onChange, settings]);

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
            <Cpu className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="flex-1">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              Slicing Performance
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Tune compute backend choice, CPU saturation profile, and progress feedback responsiveness.
            </p>
          </div>
        </div>

        <div className="mt-3 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                Compute backend
              </div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                WebGPU is experimental; unsupported environments auto-fallback to CPU/WASM workers.
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              {([
                { key: 'auto', label: 'Auto' },
                { key: 'cpu', label: 'CPU' },
                { key: 'webgpu', label: 'WebGPU' },
              ] as const).map((option) => {
                const active = settings.computeBackend === option.key;
                const disabled = option.key === 'webgpu' && !webGpuSupported;
                return (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => !disabled && patch({ computeBackend: option.key })}
                    disabled={disabled}
                    className="h-10 min-w-[100px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors disabled:opacity-45 disabled:cursor-not-allowed"
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
          <div className="mt-2 text-[11px]" style={{ color: webGpuSupported ? '#86efac' : 'var(--text-muted)' }}>
            WebGPU availability: {webGpuSupported ? 'Detected' : 'Not detected'}
          </div>
          <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {webGpuStatusText}
          </div>
        </div>

        <div className="mt-2 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                CPU profile
              </div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Max uses nearly all logical cores; Balanced leaves more headroom for UI multitasking.
              </div>
            </div>
            <div className="flex items-center gap-1.5">
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
                    className="h-10 min-w-[120px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors inline-flex items-center justify-center gap-1.5"
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
                    <Icon className="h-3.5 w-3.5" />
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
                Progress feedback
              </div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Granular injects smooth in-flight estimates; Balanced reduces event churn slightly.
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              {([
                { key: 'balanced', label: 'Balanced' },
                { key: 'granular', label: 'Granular' },
              ] as const).map((option) => {
                const active = settings.progressGranularity === option.key;
                return (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => patch({ progressGranularity: option.key })}
                    className="h-10 min-w-[120px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
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
      </section>
    </div>
  );
}

export default PerformanceSettingsTab;
