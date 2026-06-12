'use client';

import React from 'react';
import { X, Activity, Cpu, Zap, Clock, Info } from 'lucide-react';

export interface SlicingDebugMetrics {
  backend: 'cpu' | 'webgpu';
  totalLayers: number;
  layersProcessed: number;
  elapsedMs: number;
  estimatedRemainingMs: number;
  avgLayerMs: number;
  currentLayerMs: number;
  peakMemoryMb: number;
  currentMemoryMb: number;
  workerCount: number;
  renderMode: string;
  gpuDevice?: string;
  stageMetrics?: {
    stage: string;
    durationMs: number;
    percentage: number;
  }[];
}

interface SlicingDebugModalProps {
  isOpen: boolean;
  onClose: () => void;
  metrics: SlicingDebugMetrics | null;
  progress: number;
}

export function SlicingDebugModal({ isOpen, onClose, metrics, progress }: SlicingDebugModalProps) {
  if (!isOpen || !metrics) return null;

  const formatTime = (ms: number) => {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const sec = ms / 1000;
    if (sec < 60) return `${sec.toFixed(1)}s`;
    const min = Math.floor(sec / 60);
    const remSec = Math.round(sec % 60);
    return `${min}m ${remSec}s`;
  };

  const formatMemory = (mb: number) => {
    if (mb < 1024) return `${Math.round(mb)} MB`;
    return `${(mb / 1024).toFixed(2)} GB`;
  };

  const progressPercent = Math.round(progress * 100);
  const backendColor = metrics.backend === 'webgpu' ? '#7aa2f7' : '#ff9e64';
  const backendLabel = metrics.backend === 'webgpu' ? 'GPU (WebGPU)' : 'CPU (WASM)';

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      style={{ background: 'rgba(0, 0, 0, 0.75)' }}
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-3xl max-h-[90vh] overflow-auto rounded-xl border shadow-2xl"
        style={{
          background: 'var(--surface-0)',
          borderColor: 'var(--border-subtle)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="sticky top-0 flex items-center justify-between p-4 border-b"
          style={{
            background: 'var(--surface-0)',
            borderColor: 'var(--border-subtle)',
            backdropFilter: 'blur(8px)',
          }}
        >
          <div className="flex items-center gap-3">
            <div
              className="flex h-10 w-10 items-center justify-center rounded-lg border"
              style={{
                borderColor: 'var(--border-subtle)',
                background: `color-mix(in srgb, ${backendColor}, var(--surface-1) 85%)`,
              }}
            >
              <Activity className="h-5 w-5" style={{ color: backendColor }} />
            </div>
            <div>
              <h2 className="text-lg font-bold" style={{ color: 'var(--text-strong)' }}>
                Slicing Debug Monitor
              </h2>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Real-time performance metrics and backend analysis
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-lg border transition-colors hover:bg-red-500/10"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            <X className="h-4 w-4" style={{ color: 'var(--text-muted)' }} />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {/* Overall Progress */}
          <div
            className="rounded-lg border p-3"
            style={{
              background: 'var(--surface-1)',
              borderColor: 'var(--border-subtle)',
            }}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                Overall Progress
              </span>
              <span className="text-sm font-mono font-bold" style={{ color: backendColor }}>
                {progressPercent}%
              </span>
            </div>
            <div className="relative h-2 rounded-full overflow-hidden" style={{ background: 'var(--surface-0)' }}>
              <div
                className="absolute inset-y-0 left-0 rounded-full transition-all"
                style={{
                  width: `${progressPercent}%`,
                  background: `linear-gradient(90deg, ${backendColor}, ${backendColor}dd)`,
                }}
              />
            </div>
            <div className="flex items-center justify-between mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              <span>
                Layer {metrics.layersProcessed} / {metrics.totalLayers}
              </span>
              <span>{formatTime(metrics.estimatedRemainingMs)} remaining</span>
            </div>
          </div>

          {/* Backend Info */}
          <div
            className="rounded-lg border p-3"
            style={{
              background: 'var(--surface-1)',
              borderColor: 'var(--border-subtle)',
            }}
          >
            <div className="flex items-center gap-2 mb-3">
              {metrics.backend === 'webgpu' ? (
                <Zap className="h-4 w-4" style={{ color: backendColor }} />
              ) : (
                <Cpu className="h-4 w-4" style={{ color: backendColor }} />
              )}
              <span className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                {backendLabel}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-wide font-semibold mb-0.5" style={{ color: 'var(--text-muted)' }}>
                  Workers
                </div>
                <div className="text-lg font-mono font-bold" style={{ color: 'var(--text-strong)' }}>
                  {metrics.workerCount}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide font-semibold mb-0.5" style={{ color: 'var(--text-muted)' }}>
                  Render Mode
                </div>
                <div className="text-sm font-medium" style={{ color: 'var(--text-strong)' }}>
                  {metrics.renderMode}
                </div>
              </div>
            </div>
            {metrics.gpuDevice && (
              <div className="mt-3 pt-3 border-t text-xs" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
                <Info className="inline h-3 w-3 mr-1" />
                GPU: {metrics.gpuDevice}
              </div>
            )}
          </div>

          {/* Timing Metrics */}
          <div
            className="rounded-lg border p-3"
            style={{
              background: 'var(--surface-1)',
              borderColor: 'var(--border-subtle)',
            }}
          >
            <div className="flex items-center gap-2 mb-3">
              <Clock className="h-4 w-4" style={{ color: 'var(--accent)' }} />
              <span className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                Timing Analysis
              </span>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-wide font-semibold mb-0.5" style={{ color: 'var(--text-muted)' }}>
                  Current Layer
                </div>
                <div className="text-base font-mono font-bold" style={{ color: 'var(--text-strong)' }}>
                  {formatTime(metrics.currentLayerMs)}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide font-semibold mb-0.5" style={{ color: 'var(--text-muted)' }}>
                  Avg per Layer
                </div>
                <div className="text-base font-mono font-bold" style={{ color: 'var(--text-strong)' }}>
                  {formatTime(metrics.avgLayerMs)}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide font-semibold mb-0.5" style={{ color: 'var(--text-muted)' }}>
                  Total Elapsed
                </div>
                <div className="text-base font-mono font-bold" style={{ color: 'var(--text-strong)' }}>
                  {formatTime(metrics.elapsedMs)}
                </div>
              </div>
            </div>
          </div>

          {/* Memory Usage */}
          <div
            className="rounded-lg border p-3"
            style={{
              background: 'var(--surface-1)',
              borderColor: 'var(--border-subtle)',
            }}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                Memory Usage
              </span>
              <span className="text-sm font-mono" style={{ color: 'var(--text-strong)' }}>
                {formatMemory(metrics.currentMemoryMb)} / {formatMemory(metrics.peakMemoryMb)}
              </span>
            </div>
            <div className="relative h-2 rounded-full overflow-hidden" style={{ background: 'var(--surface-0)' }}>
              <div
                className="absolute inset-y-0 left-0 rounded-full transition-all"
                style={{
                  width: `${Math.min(100, (metrics.currentMemoryMb / metrics.peakMemoryMb) * 100)}%`,
                  background: 'linear-gradient(90deg, var(--accent), var(--accent-secondary))',
                }}
              />
            </div>
          </div>

          {/* Stage Breakdown */}
          {metrics.stageMetrics && metrics.stageMetrics.length > 0 && (
            <div
              className="rounded-lg border p-3"
              style={{
                background: 'var(--surface-1)',
                borderColor: 'var(--border-subtle)',
              }}
            >
              <div className="text-sm font-semibold mb-3" style={{ color: 'var(--text-strong)' }}>
                Stage Breakdown
              </div>
              <div className="space-y-2">
                {metrics.stageMetrics.map((stage, idx) => (
                  <div key={idx} className="flex items-center gap-3">
                    <div className="flex-1">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium" style={{ color: 'var(--text-strong)' }}>
                          {stage.stage}
                        </span>
                        <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                          {formatTime(stage.durationMs)} ({stage.percentage.toFixed(1)}%)
                        </span>
                      </div>
                      <div className="relative h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--surface-0)' }}>
                        <div
                          className="absolute inset-y-0 left-0 rounded-full"
                          style={{
                            width: `${stage.percentage}%`,
                            background: backendColor,
                          }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Hotkey Hint */}
          <div className="text-center pt-2 pb-1">
            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              Toggle: Ctrl+Shift+X (Printing Mode Only)
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
