'use client';

import React from 'react';
import { Cpu, Gauge, Sparkles, Bug, Zap, Activity } from 'lucide-react';
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
    <div className="space-y-4">
      {/* Compute Backend */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Cpu className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          <span className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
            Compute Backend
          </span>
        </div>
        <div
          className="rounded-lg border p-3"
          style={{
            background: 'var(--surface-1)',
            borderColor: 'var(--border-subtle)',
          }}
        >
          <div className="flex items-center gap-2">
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
                  className="flex-1 h-11 rounded-md border px-3 text-xs font-semibold uppercase tracking-wide transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                  style={active
                    ? {
                        borderColor: 'var(--accent)',
                        background: 'color-mix(in srgb, var(--accent), transparent 88%)',
                        color: 'var(--accent)',
                      }
                    : {
                        borderColor: 'var(--border-subtle)',
                        background: 'var(--surface-0)',
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

      {/* CPU Profile & Progress */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Gauge className="h-4 w-4" style={{ color: 'var(--accent)' }} />
            <span className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              CPU Profile
            </span>
          </div>
          <div
            className="rounded-lg border p-3"
            style={{
              background: 'var(--surface-1)',
              borderColor: 'var(--border-subtle)',
            }}
          >
            <div className="flex flex-col gap-2">
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
                    className="h-10 rounded-md border px-3 text-xs font-semibold uppercase tracking-wide transition-all inline-flex items-center justify-center gap-2"
                    style={active
                      ? {
                          borderColor: 'var(--accent)',
                          background: 'color-mix(in srgb, var(--accent), transparent 88%)',
                          color: 'var(--accent)',
                        }
                      : {
                          borderColor: 'var(--border-subtle)',
                          background: 'var(--surface-0)',
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

        <div>
          <div className="flex items-center gap-2 mb-2">
            <Activity className="h-4 w-4" style={{ color: 'var(--accent)' }} />
            <span className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              Progress
            </span>
          </div>
          <div
            className="rounded-lg border p-3"
            style={{
              background: 'var(--surface-1)',
              borderColor: 'var(--border-subtle)',
            }}
          >
            <div className="flex flex-col gap-2">
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
                    className="h-10 rounded-md border px-3 text-xs font-semibold uppercase tracking-wide transition-all"
                    style={active
                      ? {
                          borderColor: 'var(--accent)',
                          background: 'color-mix(in srgb, var(--accent), transparent 88%)',
                          color: 'var(--accent)',
                        }
                      : {
                          borderColor: 'var(--border-subtle)',
                          background: 'var(--surface-0)',
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
      </div>

      {/* Debug & Benchmarking */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Bug className="h-4 w-4" style={{ color: '#ff9e64' }} />
          <span className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
            Debug & Benchmarking
          </span>
        </div>
        <div
          className="rounded-lg border p-3"
          style={{
            background: 'var(--surface-1)',
            borderColor: 'var(--border-subtle)',
          }}
        >
          {/* Debug Mode */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium" style={{ color: 'var(--text-strong)' }}>
                Debug Mode
              </div>
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                Record timing metrics and enable force-backend control
              </div>
            </div>
            <button
              type="button"
              onClick={() => patch({ debugMode: !settings.debugMode })}
              className="h-9 w-20 rounded-md border text-xs font-semibold uppercase tracking-wide transition-all"
              style={{
                borderColor: settings.debugMode ? '#ff9e64' : 'var(--border-subtle)',
                background: settings.debugMode ? 'color-mix(in srgb, #ff9e64, transparent 88%)' : 'var(--surface-0)',
                color: settings.debugMode ? '#ff9e64' : 'var(--text-muted)',
              }}
            >
              {settings.debugMode ? 'On' : 'Off'}
            </button>
          </div>

          {/* Force Backend (conditional) */}
          {settings.debugMode && (
            <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="text-xs font-semibold mb-2" style={{ color: 'var(--text-strong)' }}>
                Force Backend
              </div>
              <div className="flex gap-2">
                {([
                  { key: 'none', label: 'Auto' },
                  { key: 'cpu', label: 'CPU' },
                  { key: 'webgpu', label: 'GPU' },
                ] as const).map((option) => {
                  const active = settings.debugForceBackend === option.key;
                  const disabled = option.key === 'webgpu' && !webGpuSupported;
                  return (
                    <button
                      key={option.key}
                      type="button"
                      onClick={() => !disabled && patch({ debugForceBackend: option.key })}
                      disabled={disabled}
                      className="flex-1 h-9 rounded-md border text-xs font-semibold uppercase tracking-wide transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                      style={active
                        ? {
                            borderColor: '#ff9e64',
                            background: 'color-mix(in srgb, #ff9e64, transparent 88%)',
                            color: '#ff9e64',
                          }
                        : {
                            borderColor: 'var(--border-subtle)',
                            background: 'var(--surface-0)',
                            color: 'var(--text-muted)',
                          }}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Benchmarking Mode */}
          <div className={`flex items-center justify-between ${settings.debugMode ? 'mt-3 pt-3 border-t' : 'mt-3 pt-3 border-t'}`} style={{ borderColor: 'var(--border-subtle)' }}>
            <div>
              <div className="text-sm font-medium" style={{ color: 'var(--text-strong)' }}>
                Benchmarking
              </div>
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                Show detailed performance metrics modal during slicing
              </div>
            </div>
            <button
              type="button"
              onClick={() => patch({ benchmarkingMode: !settings.benchmarkingMode })}
              className="h-9 w-20 rounded-md border text-xs font-semibold uppercase tracking-wide transition-all"
              style={{
                borderColor: settings.benchmarkingMode ? '#ff9e64' : 'var(--border-subtle)',
                background: settings.benchmarkingMode ? 'color-mix(in srgb, #ff9e64, transparent 88%)' : 'var(--surface-0)',
                color: settings.benchmarkingMode ? '#ff9e64' : 'var(--text-muted)',
              }}
            >
              {settings.benchmarkingMode ? 'On' : 'Off'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default PerformanceSettingsTab;
