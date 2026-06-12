'use client';

import React from 'react';
import { Wrench, X, AlertTriangle } from 'lucide-react';
import type { MeshRepairConfirmPrompt } from '@/features/scene/useSceneCollectionManager';

type Props = {
  prompt: MeshRepairConfirmPrompt;
  onRepair: () => void;
  onLoadAsIs: () => void;
  onCancelImport: () => void;
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

export function MeshRepairConfirmModal({ prompt, onRepair, onLoadAsIs, onCancelImport }: Props) {
  const { fileName, analysis } = prompt;

  return (
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onCancelImport();
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
                Repair recommended before slicing
              </h2>
              <p className="mt-0.5 text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                This model has severe mesh issues and is likely to need heavy repair.
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
            aria-label="Cancel importing this model"
            onClick={onCancelImport}
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

          {/* Disclaimer */}
          <div
            className="rounded-md border px-3 py-2"
            style={{
              borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 40%)',
              background: 'color-mix(in srgb, #d97706, var(--surface-1) 92%)',
            }}
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: '#d97706' }} />
              <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                <strong style={{ color: 'var(--text-strong)' }}>Disclaimer:</strong> Repair is recommended.
                Loading this mesh as-is may cause slicing errors or print failures, and successful output cannot be guaranteed.
              </p>
            </div>
          </div>

          {/* Actions */}
          <div className="grid grid-cols-2 gap-2 pt-1">
            <button
              type="button"
              className="ui-button ui-button-secondary !h-9 w-full px-3 text-xs"
              onClick={onLoadAsIs}
            >
              Load As-Is
            </button>
            <button
              type="button"
              className="ui-button ui-button-accent !h-9 w-full px-3 text-xs flex items-center justify-center gap-1.5"
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
