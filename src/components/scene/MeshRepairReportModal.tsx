'use client';

import React from 'react';
import { CheckCircle2, AlertTriangle, X, Wrench, ClipboardCopy } from 'lucide-react';
import type { MeshRepairReportEntry } from '@/features/scene/useSceneCollectionManager';
import type { MeshAnalysisJson, MeshHealthReport } from '@/utils/meshRepair';

type Props = {
  reports: MeshRepairReportEntry[];
  onDismiss: () => void;
};

function formatMs(value: unknown, digits = 1): string {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return `${n.toFixed(digits)} ms`;
}

function formatSignedVolume(value: unknown): string {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return n.toFixed(3);
}

export function MeshRepairReportModal({ reports, onDismiss }: Props) {
  const [expandedId, setExpandedId] = React.useState<string | null>(
    reports.length === 1 ? reports[0].id : null,
  );

  const totals = React.useMemo(() => {
    let repaired = 0;
    let residual = 0;
    let totalMs = 0;
    let totalTrisPre = 0;
    let totalTrisPost = 0;
    for (const entry of reports) {
      const { report } = entry;
      if (report.fully_repaired) repaired += 1;
      else residual += 1;
      totalMs += report.total_ms ?? report.post.timings_ms?.total_ms ?? 0;
      totalTrisPre += report.pre.triangle_count;
      totalTrisPost += report.post.triangle_count;
    }
    return { repaired, residual, totalMs, totalTrisPre, totalTrisPost };
  }, [reports]);

  const copyAll = React.useCallback(() => {
    try {
      const json = JSON.stringify(reports.map((r) => ({ modelName: r.modelName, report: r.report })), null, 2);
      void navigator.clipboard?.writeText(json);
    } catch {
      // ignore
    }
  }, [reports]);

  if (reports.length === 0) return null;

  return (
    <div className="fixed inset-0 z-[230] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3">
      <div
        className="w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden rounded-xl border shadow-2xl"
        style={{
          background: 'var(--surface-0)',
          borderColor: 'var(--border-subtle)',
          boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
        }}
        role="dialog"
        aria-modal="true"
        aria-label="Mesh repair report"
      >
        {/* Header */}
        <div
          className="flex items-center justify-between gap-4 border-b px-5 py-4"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <div className="flex min-w-0 items-center gap-3">
            <span
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border"
              style={{
                borderColor: totals.residual > 0
                  ? 'color-mix(in srgb, #d97706, var(--border-subtle) 50%)'
                  : 'color-mix(in srgb, #22c55e, var(--border-subtle) 50%)',
                background: totals.residual > 0
                  ? 'color-mix(in srgb, #d97706, var(--surface-1) 85%)'
                  : 'color-mix(in srgb, #22c55e, var(--surface-1) 85%)',
                color: totals.residual > 0 ? '#d97706' : '#22c55e',
              }}
            >
              {totals.residual > 0 ? <AlertTriangle className="h-4 w-4" /> : <Wrench className="h-4 w-4" />}
            </span>
            <div className="min-w-0 pr-2">
              <h2 className="text-base font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>
                Mesh Repair Report
              </h2>
              <p className="mt-0.5 text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                {reports.length} mesh{reports.length === 1 ? '' : 'es'} analyzed in{' '}
                {formatMs(totals.totalMs)} · {totals.repaired} clean · {totals.residual} with residual issues
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              className="inline-flex h-9 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-medium transition-colors"
              style={{
                borderColor: 'var(--border-subtle)',
                background: 'var(--surface-1)',
                color: 'var(--text-muted)',
              }}
              onClick={copyAll}
              title="Copy full JSON to clipboard"
            >
              <ClipboardCopy className="h-3.5 w-3.5" />
              Copy JSON
            </button>
            <button
              type="button"
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border transition-colors"
              style={{
                borderColor: 'var(--border-subtle)',
                background: 'var(--surface-1)',
                color: 'var(--text-muted)',
              }}
              aria-label="Close"
              onClick={onDismiss}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {reports.map((entry) => {
            const isExpanded = expandedId === entry.id;
            return (
              <ReportCard
                key={entry.id}
                entry={entry}
                expanded={isExpanded}
                onToggle={() => setExpandedId(isExpanded ? null : entry.id)}
              />
            );
          })}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-end gap-2 border-t px-5 py-3"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <button
            type="button"
            className="inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-[11px] font-semibold transition-colors"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'var(--surface-1)',
              color: 'var(--text-strong)',
            }}
            onClick={onDismiss}
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

function ReportCard({
  entry,
  expanded,
  onToggle,
}: {
  entry: MeshRepairReportEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { modelName, report } = entry;
  const ok = report.fully_repaired;
  const toneColor = ok ? '#22c55e' : '#d97706';

  return (
    <div
      className="rounded-lg border"
      style={{
        borderColor: 'var(--border-subtle)',
        background: 'color-mix(in srgb, var(--surface-1), black 4%)',
      }}
    >
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left"
        onClick={onToggle}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border"
            style={{
              borderColor: `color-mix(in srgb, ${toneColor}, var(--border-subtle) 50%)`,
              background: `color-mix(in srgb, ${toneColor}, var(--surface-1) 85%)`,
              color: toneColor,
            }}
          >
            {ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
          </span>
          <div className="min-w-0">
            <div
              className="truncate text-sm font-semibold leading-tight"
              style={{ color: 'var(--text-strong)' }}
              title={modelName}
            >
              {modelName}
            </div>
            <div className="mt-0.5 text-[10.5px] leading-snug" style={{ color: 'var(--text-muted)' }}>
              <DeltaLine pre={report.pre} post={report.post} />
            </div>
          </div>
        </div>
        <span className="text-[10.5px] font-medium" style={{ color: 'var(--text-muted)' }}>
          {formatMs(report.total_ms)}
        </span>
      </button>

      {expanded && (
        <div
          className="border-t px-3.5 py-3 space-y-3"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <div className="grid grid-cols-2 gap-3">
            <AnalysisBlock title="Before" analysis={report.pre} />
            <AnalysisBlock title="After" analysis={report.post} />
          </div>

          {report.steps.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide mb-1" style={{ color: 'var(--text-muted)' }}>
                Repair steps
              </div>
              <ul className="space-y-0.5 text-[11px]" style={{ color: 'var(--text-strong)' }}>
                {report.steps.map((step, idx) => (
                  <li key={idx} className="flex items-center justify-between gap-2 font-mono">
                    <span className="truncate">
                      {step.name}
                      {typeof step.changed === 'number' && step.changed > 0 ? (
                        <span style={{ color: 'var(--text-muted)' }}> · Δ {step.changed}</span>
                      ) : null}
                      {step.details ? <span style={{ color: 'var(--text-muted)' }}> — {step.details}</span> : null}
                    </span>
                    <span style={{ color: 'var(--text-muted)' }}>{formatMs(step.duration_ms, 2)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report.residual_issues.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide mb-1" style={{ color: '#d97706' }}>
                Residual issues
              </div>
              <ul className="space-y-0.5 text-[11px]" style={{ color: 'var(--text-strong)' }}>
                {report.residual_issues.map((issue, idx) => (
                  <li key={idx}>• {issue}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DeltaLine({ pre, post }: { pre: MeshAnalysisJson; post: MeshAnalysisJson }) {
  const parts: string[] = [];
  parts.push(`${pre.triangle_count.toLocaleString()} → ${post.triangle_count.toLocaleString()} tris`);
  if (pre.non_manifold_edges !== post.non_manifold_edges) {
    parts.push(`NME ${pre.non_manifold_edges} → ${post.non_manifold_edges}`);
  }
  if (pre.boundary_loops !== post.boundary_loops) {
    parts.push(`holes ${pre.boundary_loops} → ${post.boundary_loops}`);
  }
  if (pre.inconsistent_edges !== post.inconsistent_edges) {
    parts.push(`winding ${pre.inconsistent_edges} → ${post.inconsistent_edges}`);
  }
  if (pre.self_intersections !== post.self_intersections) {
    parts.push(`self-int ${pre.self_intersections} → ${post.self_intersections}`);
  }
  parts.push(post.is_watertight ? 'watertight' : 'not watertight');
  return <>{parts.join(' · ')}</>;
}

function AnalysisBlock({ title, analysis }: { title: string; analysis: MeshAnalysisJson }) {
  const rows: [string, string | number][] = [
    ['Triangles', analysis.triangle_count.toLocaleString()],
    ['Vertices', analysis.vertex_count.toLocaleString()],
    ['Components', analysis.component_count],
    ['Non-manifold edges', analysis.non_manifold_edges],
    ['Non-manifold verts', analysis.non_manifold_vertices],
    ['Boundary edges', analysis.boundary_edges],
    ['Boundary loops', analysis.boundary_loops],
    ['Inconsistent edges', analysis.inconsistent_edges],
    ['Degenerate tris', analysis.degenerate_triangles],
    ['Duplicate tris', analysis.duplicate_triangles],
    ['Self-intersections', analysis.self_intersections],
    ['Signed volume', formatSignedVolume(analysis.signed_volume)],
    ['Watertight', analysis.is_watertight ? 'yes' : 'no'],
  ];

  return (
    <div
      className="rounded-md border px-2.5 py-2"
      style={{
        borderColor: 'var(--border-subtle)',
        background: 'var(--surface-0)',
      }}
    >
      <div className="text-[10px] font-semibold uppercase tracking-wide mb-1" style={{ color: 'var(--text-muted)' }}>
        {title}
      </div>
      <div className="grid grid-cols-[1fr_auto] gap-x-2 gap-y-0.5 text-[10.5px] font-mono" style={{ color: 'var(--text-strong)' }}>
        {rows.map(([label, val]) => (
          <React.Fragment key={label}>
            <span style={{ color: 'var(--text-muted)' }}>{label}</span>
            <span className="text-right">{val}</span>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
