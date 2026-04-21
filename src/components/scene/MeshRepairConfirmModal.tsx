'use client';

import React from 'react';
import { Wrench, X, AlertTriangle } from 'lucide-react';
import type { MeshRepairConfirmPrompt } from '@/features/scene/useSceneCollectionManager';

type Props = {
  prompt: MeshRepairConfirmPrompt;
  onRepair: () => void;
  onLoadAsIs: () => void;
};

function StatRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1 border-b last:border-0" style={{ borderColor: 'var(--border-subtle)' }}>
      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span className="text-xs font-mono font-semibold tabular-nums" style={{ color: 'var(--text-strong)' }}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </span>
    </div>
  );
}

export function MeshRepairConfirmModal({ prompt, onRepair, onLoadAsIs }: Props) {
  const { fileName, analysis } = prompt;

  return (
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onLoadAsIs();
        }
      }}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border shadow-2xl"
        style={{
          background: 'var(--surface-0)',
          borderColor: 'var(--border-subtle)',
          boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
        }}
        role="dialog"
        aria-modal="true"
        aria-label="Mesh repair confirmation"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-4 border-b px-5 py-4" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="flex min-w-0 items-center gap-3">
            <span
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border"
              style={{
                borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 45%)',
                background: 'color-mix(in srgb, #d97706, var(--surface-1) 88%)',
                color: '#d97706',
              }}
            >
              <AlertTriangle className="h-4 w-4" />
            </span>

            <div className="min-w-0 pr-2">
              <h2 className="text-base font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>
                Complex mesh detected
              </h2>
              <p className="mt-0.5 text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                This model may require an intensive repair pass.
              </p>
            </div>
          </div>

          <button
            type="button"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border transition-colors"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'var(--surface-1)',
              color: 'var(--text-muted)',
            }}
            aria-label="Skip repair and load as-is"
            onClick={onLoadAsIs}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          {/* File info */}
          <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>File</div>
            <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-strong)' }} title={fileName}>
              {fileName}
            </div>
          </div>

          {/* Analysis stats */}
          <div className="rounded-md border px-3 pt-2 pb-1" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="text-[11px] uppercase tracking-wide mb-1" style={{ color: 'var(--text-muted)' }}>Analysis</div>
            <StatRow label="Triangles" value={analysis.triangle_count} />
            <StatRow label="Components" value={analysis.component_count} />
            <StatRow label="Self-intersections" value={analysis.self_intersections} />
            <StatRow label="Non-manifold edges" value={analysis.non_manifold_edges} />
            <StatRow label="Boundary loops" value={analysis.boundary_loops} />
          </div>

          {/* Explanation */}
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            <strong style={{ color: 'var(--text-strong)' }}>Repair</strong> will attempt to weld components, resolve
            self-intersections, and produce a watertight solid. This may take a while for complex geometry.
            <span className="mt-1 block">
              <strong style={{ color: 'var(--text-strong)' }}>Load As-Is</strong> skips repair and imports the
              mesh exactly as stored in the file.
            </span>
          </p>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              className="ui-button ui-button-secondary !h-9 px-3 text-xs"
              onClick={onLoadAsIs}
            >
              Load As-Is
            </button>
            <button
              type="button"
              className="ui-button ui-button-accent !h-9 px-3 text-xs flex items-center gap-1.5"
              onClick={onRepair}
            >
              <Wrench className="h-3.5 w-3.5" />
              Repair
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
