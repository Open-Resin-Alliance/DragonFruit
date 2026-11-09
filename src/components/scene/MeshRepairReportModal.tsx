'use client';

import React from 'react';
import { CheckCircle2, XCircle, X, Wrench, ClipboardCopy, ChevronDown, ChevronRight } from 'lucide-react';
import { useEscapeToClose } from '@/hotkeys/useEscapeToClose';
import { Button, IconButton } from '@/components/atoms';
import type { MeshRepairReportEntry } from '@/features/scene/useSceneCollectionManager';
import type {
  MeshAnalysisJson,
  MeshHealthReport,
  MeshRepairPartSummary,
} from '@/utils/meshRepair';
import type { MessageDescriptor } from '@lingui/core';
import { msg, plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';

/**
 * A status glyph in a tinted square, drawn as one SVG.
 *
 * With a fractional UI scale, CEF snaps a CSS border to device pixels but paints an icon
 * inside it at its fractional position, so the two drift up to a pixel apart. Drawing
 * the frame and the glyph in one coordinate system makes them scale together.
 */
function ToneBadge({
  glyph,
  accent,
  color,
  size,
  glyphSize,
  radius,
}: {
  glyph: 'ok' | 'warning' | 'failed';
  accent: string;
  color: string;
  size: number;
  glyphSize: number;
  radius: number;
}) {
  // The lucide glyphs are drawn on a 24-unit grid.
  const inset = (size - glyphSize) / 2;
  return (
    <svg
      className="shrink-0"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      fill="none"
      aria-hidden="true"
      style={{ color }}
    >
      <rect
        x="0.5"
        y="0.5"
        width={size - 1}
        height={size - 1}
        rx={radius - 0.5}
        fill={`color-mix(in srgb, ${accent}, var(--surface-1) 85%)`}
        stroke={`color-mix(in srgb, ${accent}, var(--border-subtle) 50%)`}
      />
      <g
        transform={`translate(${inset} ${inset}) scale(${glyphSize / 24})`}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {glyph === 'warning' ? (
          <>
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
          </>
        ) : (
          <>
            <circle cx="12" cy="12" r="10" />
            {glyph === 'ok' ? <path d="m9 12 2 2 4-4" /> : <path d="m15 9-6 6M9 9l6 6" />}
          </>
        )}
      </g>
    </svg>
  );
}

type Props = {
  reports: MeshRepairReportEntry[];
  presentation?: 'default' | 'optimistic';
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

type Translate = (descriptor: MessageDescriptor) => string;

// Module level on purpose: React Compiler renames locals inside components
// before the Lingui macro derives the message id.
function formatBatchSubtitle(
  translate: Translate,
  count: number,
  duration: string,
  repaired: number,
  residual: number,
): string {
  return translate(msg`${plural(count, { one: '# mesh', other: '# meshes' })} · ${duration} · ${repaired} clean · ${residual} with issues`);
}

function formatDeltaParts(pre: MeshAnalysisJson, post: MeshAnalysisJson, translate: Translate): string[] {
  const trianglesBefore = pre.triangle_count.toLocaleString();
  const trianglesAfter = post.triangle_count.toLocaleString();
  const parts = [translate(msg({ message: `${trianglesBefore} → ${trianglesAfter} tris`, context: 'Mesh repair summary, triangle count' }))];
  if (pre.non_manifold_edges !== post.non_manifold_edges) {
    const edgesBefore = pre.non_manifold_edges;
    const edgesAfter = post.non_manifold_edges;
    parts.push(translate(msg({ message: `NME ${edgesBefore} → ${edgesAfter}`, context: 'Mesh repair summary; NME = non-manifold edges' })));
  }
  if (pre.boundary_loops !== post.boundary_loops) {
    const holesBefore = pre.boundary_loops;
    const holesAfter = post.boundary_loops;
    parts.push(translate(msg({ message: `holes ${holesBefore} → ${holesAfter}`, context: 'Mesh repair summary' })));
  }
  if (pre.inconsistent_edges !== post.inconsistent_edges) {
    const windingBefore = pre.inconsistent_edges;
    const windingAfter = post.inconsistent_edges;
    parts.push(translate(msg({ message: `winding ${windingBefore} → ${windingAfter}`, context: 'Mesh repair summary' })));
  }
  if (pre.self_intersections !== post.self_intersections) {
    const intersectionsBefore = pre.self_intersections;
    const intersectionsAfter = post.self_intersections;
    parts.push(translate(msg({ message: `self-int ${intersectionsBefore} → ${intersectionsAfter}`, context: 'Mesh repair summary; self-intersections' })));
  }
  parts.push(post.is_watertight
    ? translate(msg({ message: 'watertight', context: 'Mesh repair summary' }))
    : translate(msg({ message: 'not watertight', context: 'Mesh repair summary' })));
  return parts;
}

/**
 * The rebuild route's line in the summary. A rebuilt mesh is a different object rather than the same
 * one repaired, so this leads the list: everything below it compares two meshes, this says which two.
 *
 * Interpolated and therefore module scope, for the reason given above [`partsSummaryLabel`].
 */
function rebuildSummaryLabel(report: MeshRepairReportEntry['report'], translate: Translate): string {
  const from = report.pre.triangle_count.toLocaleString();
  const to = report.post.triangle_count.toLocaleString();
  const base = Math.abs(report.pre.signed_volume);
  const moved = base > 0 ? ((report.post.signed_volume - report.pre.signed_volume) / base) * 100 : 0;
  const percent = Math.abs(moved).toFixed(1);
  return moved >= 0
    ? translate(msg`Rebuilt the surface into a solid: ${to} triangles from ${from}, with ${percent}% more volume.`)
    : translate(msg`Rebuilt the surface into a solid: ${to} triangles from ${from}, with ${percent}% less volume.`);
}

function summarizeRepairWins(report: MeshRepairReportEntry['report'], translate: Translate): string[] {
  const wins: string[] = [];
  if (report.rebuilt) {
    wins.push(rebuildSummaryLabel(report, translate));
  }
  const closedHoles = Math.max(0, report.pre.boundary_loops - report.post.boundary_loops);
  const resolvedSelfIntersections = Math.max(0, report.pre.self_intersections - report.post.self_intersections);
  const cleanedNonManifoldEdges = Math.max(0, report.pre.non_manifold_edges - report.post.non_manifold_edges);
  const correctedWindingIssues = Math.max(0, report.pre.inconsistent_edges - report.post.inconsistent_edges);
  const reducedComponents = Math.max(0, report.pre.component_count - report.post.component_count);

  if (report.post.is_watertight && !report.pre.is_watertight) {
    wins.push(translate(msg`Made the mesh watertight.`));
  }
  if (closedHoles > 0) {
    wins.push(translate(msg`Closed ${plural(closedHoles, { one: '# open hole', other: '# open holes' })}.`));
  }
  if (resolvedSelfIntersections > 0) {
    wins.push(translate(msg`Resolved ${plural(resolvedSelfIntersections, { one: '# self-intersection', other: '# self-intersections' })}.`));
  }
  if (cleanedNonManifoldEdges > 0) {
    wins.push(translate(msg`Cleaned up ${plural(cleanedNonManifoldEdges, { one: '# non-manifold edge', other: '# non-manifold edges' })}.`));
  }
  if (correctedWindingIssues > 0) {
    wins.push(translate(msg`Corrected ${plural(correctedWindingIssues, { one: '# winding issue', other: '# winding issues' })}.`));
  }
  if (reducedComponents > 0) {
    const before = report.pre.component_count.toLocaleString();
    const after = report.post.component_count.toLocaleString();
    wins.push(translate(msg`Reduced disconnected mesh sections from ${before} to ${after}.`));
  }
  if (wins.length === 0 && report.steps.length > 0) {
    wins.push(translate(msg`Applied ${plural(report.steps.length, { one: '# automated repair step', other: '# automated repair steps' })} and re-validated the mesh.`));
  }

  return wins.slice(0, 4);
}

export function MeshRepairReportModal({ reports, presentation = 'default', onDismiss }: Props) {
  const { _ } = useLingui();
  useEscapeToClose(reports.length > 0, onDismiss);

  const [expandedId, setExpandedId] = React.useState<string | null>(
    reports.length === 1 ? reports[0].id : null,
  );

  const totals = React.useMemo(() => {
    let repaired = 0;
    let residual = 0;
    let totalMs = 0;
    for (const entry of reports) {
      const { report } = entry;
      if (report.fully_repaired) repaired += 1;
      else residual += 1;
      totalMs += report.total_ms ?? report.post.timings_ms?.total_ms ?? 0;
    }
    return { repaired, residual, totalMs };
  }, [reports]);

  const copyAll = React.useCallback(() => {
    try {
      const json = JSON.stringify(reports.map((r) => ({ modelName: r.modelName, report: r.report })), null, 2);
      void navigator.clipboard?.writeText(json);
    } catch {
      // ignore clipboard failures
    }
  }, [reports]);

  if (reports.length === 0) return null;

  const isSingle = reports.length === 1;
  const effectivePresentation = presentation === 'optimistic' && isSingle ? 'optimistic' : 'default';
  const hasResidual = totals.residual > 0;
  const toneColor = hasResidual ? '#d97706' : '#22c55e';

  const headerSubtitle = effectivePresentation === 'optimistic'
    ? reports[0].modelName
    : isSingle
      ? reports[0].modelName
      : formatBatchSubtitle(_, reports.length, formatMs(totals.totalMs), totals.repaired, totals.residual);

  // On the optimistic "Repair Complete" page, an unsuccessful repair (mesh still
  // not valid) is flagged with a red cross instead of the green check.
  const optimisticFailed = effectivePresentation === 'optimistic' && hasResidual;
  const rebuiltSingle = isSingle && reports[0].report.rebuilt === true;
  const headerTitle = effectivePresentation === 'optimistic'
    ? (optimisticFailed
      ? _(msg`Repair Incomplete`)
      : rebuiltSingle ? _(msg`Repair Complete: Rebuild`) : _(msg`Repair Complete`))
    : _(msg`Mesh Repair Report`);
  const headerToneColor = optimisticFailed
    ? '#ef4444'
    : effectivePresentation === 'optimistic' ? '#22c55e' : toneColor;
  const headerHasWarningTone = effectivePresentation !== 'optimistic' && hasResidual;
  const headerAccentColor = optimisticFailed ? '#ef4444' : headerHasWarningTone ? '#d97706' : '#22c55e';
  const panelMaxWidthClassName = effectivePresentation === 'optimistic' ? 'max-w-2xl' : 'max-w-3xl';
  const headerClassName = effectivePresentation === 'optimistic'
    ? 'flex items-center justify-between gap-4 border-b px-4 py-3'
    : 'flex items-center justify-between gap-4 border-b px-5 py-4';
  const bodyClassName = effectivePresentation === 'optimistic'
    ? 'flex-1 overflow-y-auto p-4 space-y-2.5'
    : 'flex-1 overflow-y-auto p-5 space-y-3';
  const footerClassName = effectivePresentation === 'optimistic'
    ? 'flex items-center justify-between gap-2 border-t px-2.5 py-2.5'
    : 'flex items-center justify-between gap-2 border-t px-3 py-3';

  return (
    <div className="fixed inset-0 z-[230] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3">
      <div
        className={`w-full ${panelMaxWidthClassName} max-h-[85vh] flex flex-col overflow-hidden rounded-xl border shadow-2xl`}
        style={{
          background: 'var(--surface-0)',
          borderColor: 'var(--border-subtle)',
          boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
        }}
        role="dialog"
        aria-modal="true"
        aria-label={_(msg`Mesh Repair Report`)}
      >
        <div className={headerClassName} style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="flex min-w-0 items-center gap-3">
            <ToneBadge
              glyph={optimisticFailed ? 'failed' : headerHasWarningTone ? 'warning' : 'ok'}
              accent={headerAccentColor}
              color={headerToneColor}
              size={36}
              glyphSize={16}
              radius={10}
            />
            <div className="min-w-0 pr-2">
              <h2 className="text-base font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>
                {headerTitle}
              </h2>
              <p className="mt-0.5 truncate text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                {headerSubtitle}
              </p>
            </div>
          </div>

          <IconButton
            variant="surface"
            size="md"
            aria-label={_(msg`Close`)}
            onClick={onDismiss}
          >
            <X className="w-4 h-4" />
          </IconButton>
        </div>

        <div className={bodyClassName}>
          {effectivePresentation === 'optimistic' ? (
            <OptimisticReportBody entry={reports[0]} />
          ) : isSingle ? (
            <ReportBody report={reports[0].report} />
          ) : (
            reports.map((entry) => {
              const isExpanded = expandedId === entry.id;
              return (
                <ReportCard
                  key={entry.id}
                  entry={entry}
                  expanded={isExpanded}
                  onToggle={() => setExpandedId(isExpanded ? null : entry.id)}
                />
              );
            })
          )}
        </div>

        <div className={footerClassName} style={{ borderColor: 'var(--border-subtle)' }}>
          {effectivePresentation === 'default' ? (
            <Button
              variant="secondary"
              className="gap-1.5"
              onClick={copyAll}
              title={_(msg`Copy full JSON to clipboard`)}
            >
              <ClipboardCopy className="h-3.5 w-3.5" />
              <Trans>Copy JSON</Trans>
            </Button>
          ) : <div />}
          <Button
            variant="secondary"
            onClick={onDismiss}
          >
            <Trans>Dismiss</Trans>
          </Button>
        </div>
      </div>
    </div>
  );
}

function partsRepairedCount(report: MeshHealthReport): number {
  return (report.parts ?? []).filter((part) => part.fully_repaired).length;
}

/**
 * Interpolated translations live in module-scope helpers, not inline in the component: React
 * Compiler renames the interpolated locals in production builds, which desyncs the message id from
 * the compiled catalog and renders the placeholders raw. See `docs/dev/backlog.md`.
 */
function partsSummaryLabel(repaired: number, total: number, translate: Translate): string {
  return translate(msg`${repaired} of ${total} parts repaired`);
}

function partLabel(part: MeshRepairPartSummary, translate: Translate): string {
  return translate(msg`Part ${part.index + 1}: ${part.triangles_after} triangles`);
}

function OptimisticReportBody({ entry }: { entry: MeshRepairReportEntry }) {
  const { _ } = useLingui();
  const { modelName, report } = entry;
  const wins = React.useMemo(() => summarizeRepairWins(report, _), [report, _]);
  const [showResidualIssues, setShowResidualIssues] = React.useState(false);
  const [showParts, setShowParts] = React.useState(false);
  const [showTechnicalDetails, setShowTechnicalDetails] = React.useState(false);

  const summaryText = report.rebuilt
    ? _(msg`DragonFruit rebuilt this mesh into a solid and replaced the model in your current scene.`)
    : report.fully_repaired
      ? _(msg`DragonFruit repaired this mesh and replaced the model in your current scene.`)
      : _(msg`DragonFruit could not fully repair this mesh — it is still not a valid manifold and may cause problems later in your workflow.`);

  const summaryAccent = report.fully_repaired ? '#22c55e' : '#ef4444';

  return (
    <div className="space-y-2.5">
      <div
        className="rounded-lg border px-3 py-2.5"
        style={{
          borderColor: `color-mix(in srgb, ${summaryAccent}, var(--border-subtle) 50%)`,
          background: `color-mix(in srgb, ${summaryAccent}, var(--surface-1) 90%)`,
        }}
      >
        <div className="flex items-start gap-2.5">
          {report.fully_repaired
            ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: summaryAccent }} />
            : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: summaryAccent }} />}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                {report.rebuilt
                  ? <Trans>Repair Complete: Rebuild</Trans>
                  : report.fully_repaired ? <Trans>Repair Complete</Trans> : <Trans>Repair Incomplete</Trans>}
              </div>
              <span
                className="inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold tabular-nums"
                style={{
                  color: 'var(--text-strong)',
                  borderColor: `color-mix(in srgb, ${summaryAccent}, var(--border-subtle) 45%)`,
                  background: `color-mix(in srgb, ${summaryAccent}, transparent 86%)`,
                }}
              >
                {formatMs(report.total_ms)}
              </span>
            </div>
            <p className="mt-0.5 text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              {summaryText}
              {!report.fully_repaired ? (
                <>
                  <br />
                  <Trans>If you want them, a few follow-up notes are tucked below.</Trans>
                </>
              ) : null}
            </p>
          </div>
        </div>
      </div>

      <div
        className="rounded-lg border px-3 py-2.5"
        style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), black 4%)' }}
      >
        <div className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--text-muted)' }}>
          <Trans>What DragonFruit repaired</Trans>
        </div>
        <ul className="space-y-1.5">
          {wins.map((win) => (
            <li key={win} className="flex items-start gap-2 text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: '#22c55e' }} />
              <span>{win}</span>
            </li>
          ))}
        </ul>
      </div>

      {report.parts && report.parts.length > 0 ? (
        <DrawerSection
          title={_(msg`Parts`)}
          subtitle={_(msg`Each object was repaired on its own.`)}
          open={showParts}
          onToggle={() => setShowParts((value) => !value)}
          tone={partsRepairedCount(report) === report.parts.length ? 'neutral' : 'warning'}
          compact
        >
          <p className="mb-1.5 text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {partsSummaryLabel(partsRepairedCount(report), report.parts.length, _)}
          </p>
          <ul className="space-y-1 text-[11px] leading-relaxed" style={{ color: 'var(--text-strong)' }}>
            {report.parts.map((part) => (
              <li key={part.index}>
                {part.fully_repaired ? '✓' : '•'} {partLabel(part, _)}
                {part.fully_repaired
                  ? null
                  : part.residual_issues.length > 0
                    ? ` — ${part.residual_issues[0]}`
                    : ''}
              </li>
            ))}
          </ul>
        </DrawerSection>
      ) : null}

      {report.residual_issues.length > 0 && (
        <DrawerSection
          title={_(msg`Follow-up notes`)}
          subtitle={_(msg`Optional details if you want them.`)}
          open={showResidualIssues}
          onToggle={() => setShowResidualIssues((value) => !value)}
          tone="warning"
          compact
        >
          <ul className="space-y-1 text-[11px] leading-relaxed" style={{ color: 'var(--text-strong)' }}>
            {report.residual_issues.map((issue, idx) => (
              <li key={idx}>• {issue}</li>
            ))}
          </ul>
        </DrawerSection>
      )}

      <DrawerSection
        title={_(msg`Technical details`)}
        subtitle={_(msg`Before/after analysis and repair steps.`)}
        open={showTechnicalDetails}
        onToggle={() => setShowTechnicalDetails((value) => !value)}
        compact
      >
        <div className="space-y-2.5">
          <div className="grid grid-cols-2 gap-2.5">
            <AnalysisBlock title={_(msg`Before`)} analysis={report.pre} />
            <AnalysisBlock title={_(msg`After`)} analysis={report.post} />
          </div>

          {report.steps.length > 0 && (
            <div
              className="rounded-lg border px-3 py-2.5"
              style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), black 4%)' }}
            >
              <div className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--text-muted)' }}>
                <Trans>Repair steps</Trans>
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
                    <span className="shrink-0" style={{ color: 'var(--text-muted)' }}>{formatMs(step.duration_ms, 2)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </DrawerSection>
    </div>
  );
}

function ReportBody({ report }: { report: MeshRepairReportEntry['report'] }) {
  const { _ } = useLingui();
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <AnalysisBlock title={_(msg`Before`)} analysis={report.pre} />
        <AnalysisBlock title={_(msg`After`)} analysis={report.post} />
      </div>

      {report.steps.length > 0 && (
        <div
          className="rounded-lg border px-3.5 py-3"
          style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), black 4%)' }}
        >
          <div className="text-[10px] font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>
            <Trans>Repair steps</Trans>
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
                <span className="shrink-0" style={{ color: 'var(--text-muted)' }}>{formatMs(step.duration_ms, 2)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.residual_issues.length > 0 && (
        <div
          className="rounded-lg border px-3.5 py-3"
          style={{
            borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 55%)',
            background: 'color-mix(in srgb, #d97706, var(--surface-1) 92%)',
          }}
        >
          <div className="text-[10px] font-semibold uppercase tracking-wide mb-2" style={{ color: '#d97706' }}>
            <Trans>Residual issues</Trans>
          </div>
          <ul className="space-y-0.5 text-[11px]" style={{ color: 'var(--text-strong)' }}>
            {report.residual_issues.map((issue, idx) => (
              <li key={idx}>• {issue}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function DrawerSection({
  title,
  subtitle,
  open,
  onToggle,
  tone = 'neutral',
  compact = false,
  children,
}: {
  title: string;
  subtitle?: string;
  open: boolean;
  onToggle: () => void;
  tone?: 'neutral' | 'warning';
  compact?: boolean;
  children: React.ReactNode;
}) {
  const warningTone = tone === 'warning';
  const buttonClassName = compact
    ? 'flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left'
    : 'flex w-full items-center justify-between gap-3 px-3.5 py-3 text-left';
  const contentClassName = compact
    ? 'border-t px-2.5 py-2.5'
    : 'border-t px-3 py-3';

  return (
    <div
      className="rounded-lg border overflow-hidden"
      style={{
        borderColor: warningTone
          ? 'color-mix(in srgb, #d97706, var(--border-subtle) 50%)'
          : 'var(--border-subtle)',
        background: warningTone
          ? 'color-mix(in srgb, #d97706, var(--surface-1) 94%)'
          : 'color-mix(in srgb, var(--surface-1), black 4%)',
      }}
    >
      <button type="button" className={buttonClassName} onClick={onToggle}>
        <div className="min-w-0">
          <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
            {title}
          </div>
          {subtitle ? (
            <div className="mt-0.5 text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
              {subtitle}
            </div>
          ) : null}
        </div>
        <span className="shrink-0" style={{ color: warningTone ? '#d97706' : 'var(--text-muted)' }}>
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </span>
      </button>

      {open ? (
        <div className={contentClassName} style={{ borderColor: 'var(--border-subtle)' }}>
          {children}
        </div>
      ) : null}
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
  const { _ } = useLingui();
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
          <ToneBadge glyph={ok ? 'ok' : 'warning'} accent={toneColor} color={toneColor} size={24} glyphSize={14} radius={6} />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold leading-tight" style={{ color: 'var(--text-strong)' }} title={modelName}>
              {modelName}
            </div>
            <div className="mt-0.5 text-[10.5px] leading-snug" style={{ color: 'var(--text-muted)' }}>
              <DeltaLine pre={report.pre} post={report.post} />
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2" style={{ color: 'var(--text-muted)' }}>
          <span className="text-[10.5px] font-medium">{formatMs(report.total_ms)}</span>
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </div>
      </button>

      {expanded && (
        <div className="border-t px-3 py-3 space-y-3" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="grid grid-cols-2 gap-x-4">
            <FlatAnalysisColumn title={_(msg`Before`)} analysis={report.pre} />
            <FlatAnalysisColumn title={_(msg`After`)} analysis={report.post} />
          </div>

          {report.steps.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--text-muted)' }}>
                <Trans>Repair steps</Trans>
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
                    <span className="shrink-0" style={{ color: 'var(--text-muted)' }}>{formatMs(step.duration_ms, 2)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report.residual_issues.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: '#d97706' }}>
                <Trans>Residual issues</Trans>
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
  const { _ } = useLingui();
  return <>{formatDeltaParts(pre, post, _).join(' · ')}</>;
}

function AnalysisBlock({ title, analysis }: { title: string; analysis: MeshAnalysisJson }) {
  const { _ } = useLingui();
  const rows: [MessageDescriptor, string | number][] = [
    [msg({ message: 'Triangles', context: 'Mesh analysis row' }), analysis.triangle_count.toLocaleString()],
    [msg({ message: 'Vertices', context: 'Mesh analysis row' }), analysis.vertex_count.toLocaleString()],
    [msg({ message: 'Components', context: 'Mesh analysis row' }), analysis.component_count],
    [msg({ message: 'Non-manifold edges', context: 'Mesh analysis row' }), analysis.non_manifold_edges],
    [msg({ message: 'Non-manifold verts', context: 'Mesh analysis row' }), analysis.non_manifold_vertices],
    [msg({ message: 'Boundary edges', context: 'Mesh analysis row' }), analysis.boundary_edges],
    [msg({ message: 'Boundary loops', context: 'Mesh analysis row' }), analysis.boundary_loops],
    [msg({ message: 'Inconsistent edges', context: 'Mesh analysis row' }), analysis.inconsistent_edges],
    [msg({ message: 'Degenerate tris', context: 'Mesh analysis row' }), analysis.degenerate_triangles],
    [msg({ message: 'Duplicate tris', context: 'Mesh analysis row' }), analysis.duplicate_triangles],
    [msg({ message: 'Self-intersections', context: 'Mesh analysis row' }), analysis.self_intersections],
    [msg({ message: 'Signed volume', context: 'Mesh analysis row' }), formatSignedVolume(analysis.signed_volume)],
    [msg({ message: 'Watertight', context: 'Mesh analysis row' }), analysis.is_watertight ? _(msg`yes`) : _(msg`no`)],
  ];

  return (
    <div
      className="rounded-lg border px-3 py-2.5"
      style={{
        borderColor: 'var(--border-subtle)',
        background: 'color-mix(in srgb, var(--surface-1), black 4%)',
      }}
    >
      <div className="text-[10px] font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>
        {title}
      </div>
      <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-[10.5px] font-mono" style={{ color: 'var(--text-strong)' }}>
        {rows.map(([label, val]) => (
          <React.Fragment key={label.id}>
            <span style={{ color: 'var(--text-muted)' }}>{_(label)}</span>
            <span className="text-right tabular-nums">{val}</span>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

function FlatAnalysisColumn({ title, analysis }: { title: string; analysis: MeshAnalysisJson }) {
  const { _ } = useLingui();
  const rows: [MessageDescriptor, string | number][] = [
    [msg({ message: 'Triangles', context: 'Mesh analysis row' }), analysis.triangle_count.toLocaleString()],
    [msg({ message: 'Vertices', context: 'Mesh analysis row' }), analysis.vertex_count.toLocaleString()],
    [msg({ message: 'Components', context: 'Mesh analysis row' }), analysis.component_count],
    [msg({ message: 'Non-manifold edges', context: 'Mesh analysis row' }), analysis.non_manifold_edges],
    [msg({ message: 'Non-manifold verts', context: 'Mesh analysis row' }), analysis.non_manifold_vertices],
    [msg({ message: 'Boundary edges', context: 'Mesh analysis row' }), analysis.boundary_edges],
    [msg({ message: 'Boundary loops', context: 'Mesh analysis row' }), analysis.boundary_loops],
    [msg({ message: 'Inconsistent edges', context: 'Mesh analysis row' }), analysis.inconsistent_edges],
    [msg({ message: 'Degenerate tris', context: 'Mesh analysis row' }), analysis.degenerate_triangles],
    [msg({ message: 'Duplicate tris', context: 'Mesh analysis row' }), analysis.duplicate_triangles],
    [msg({ message: 'Self-intersections', context: 'Mesh analysis row' }), analysis.self_intersections],
    [msg({ message: 'Signed volume', context: 'Mesh analysis row' }), formatSignedVolume(analysis.signed_volume)],
    [msg({ message: 'Watertight', context: 'Mesh analysis row' }), analysis.is_watertight ? _(msg`yes`) : _(msg`no`)],
  ];

  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--text-muted)' }}>
        {title}
      </div>
      <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-[10.5px] font-mono" style={{ color: 'var(--text-strong)' }}>
        {rows.map(([label, val]) => (
          <React.Fragment key={label.id}>
            <span style={{ color: 'var(--text-muted)' }}>{_(label)}</span>
            <span className="text-right tabular-nums">{val}</span>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
