'use client';

import React from 'react';
import { Download, Loader2, Microscope } from 'lucide-react';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';
import type { SupportReconstructionResult } from './nativeSupportReconstruction';
import type { NativeSupportPreview } from './nativeSupportAdapter';

type SupportReconstructionDiagnosticsModalProps = {
  open: boolean;
  modelName: string;
  result: SupportReconstructionResult | null;
  nativePreview: NativeSupportPreview | null;
  error: string | null;
  onClose: () => void;
};

function metric(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '-';
}

export function SupportReconstructionDiagnosticsModal({
  open,
  modelName,
  result,
  nativePreview,
  error,
  onClose,
}: SupportReconstructionDiagnosticsModalProps) {
  const exportDiagnostics = React.useCallback(() => {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const baseName = modelName.replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '-');
    link.href = url;
    link.download = `${baseName || 'mesh'}-support-reconstruction.json`;
    link.click();
    URL.revokeObjectURL(url);
  }, [modelName, result]);

  const endpointCounts = React.useMemo(() => {
    const counts = { plate: 0, model: 0, support: 0, open: 0 };
    for (const endpoint of result?.graph.endpoints ?? []) counts[endpoint.kind] += 1;
    return counts;
  }, [result]);

  const topologyCounts = React.useMemo(() => {
    const counts = { trunk: 0, branch: 0, brace: 0, unresolved: 0 };
    for (const candidate of result?.graph.topologyCandidates ?? []) counts[candidate.kind] += 1;
    return counts;
  }, [result]);

  const acceptedAxials = result?.graph.axialCandidates.filter((candidate) => candidate.accepted) ?? [];
  const averageConfidence = acceptedAxials.length > 0
    ? acceptedAxials.reduce((sum, candidate) => sum + candidate.confidence.finalConfidence, 0) / acceptedAxials.length
    : 0;

  return (
    <StructuredDialogModal
      open={open}
      ariaLabel="Support reconstruction diagnostics"
      title="Support Reconstruction"
      subtitle={`${modelName} - experimental diagnostics only`}
      icon={<Microscope className="h-4 w-4" />}
      iconTone="accent"
      zIndexClassName="z-[130]"
      maxWidthClassName="max-w-3xl"
      bodyClassName="max-h-[75vh] space-y-4 overflow-y-auto p-5"
      closeDisabled={!result && !error}
      onClose={result || error ? onClose : undefined}
      onBackdropClick={result || error ? onClose : () => {}}
      actions={(
        <>
          <button
            type="button"
            className="ui-button ui-button-secondary !h-9 w-full px-3 text-xs"
            onClick={onClose}
            disabled={!result && !error}
          >
            Close
          </button>
          <button
            type="button"
            className="ui-button ui-button-accent !h-9 w-full px-3 text-xs"
            onClick={exportDiagnostics}
            disabled={!result}
          >
            <Download className="mr-2 inline h-3.5 w-3.5" />
            Export JSON
          </button>
        </>
      )}
    >
      {!result && !error ? (
        <div className="flex items-center gap-3 rounded-lg border p-4" style={{ borderColor: 'var(--border-subtle)' }}>
          <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--accent-secondary)' }} />
          <div>
            <div className="text-sm font-medium" style={{ color: 'var(--text-strong)' }}>Analyzing baked supports</div>
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>The scene and native support store will not be changed.</div>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="rounded-lg border p-4 text-sm" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}>
          {error}
        </div>
      ) : null}

      {result ? (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ['Components', result.components.length],
              ['Accepted shafts', acceptedAxials.length],
              ['Roots', result.graph.roots.length],
              ['Contacts', result.graph.contacts.length],
              ['Trunks', topologyCounts.trunk],
              ['Branches', topologyCounts.branch],
              ['Braces', topologyCounts.brace],
              ['Native entities', nativePreview
                ? nativePreview.payload.trunks.length + nativePreview.payload.branches.length + nativePreview.payload.braces.length
                : 0],
              ['Native rejected', nativePreview?.rejected.length ?? 0],
              ['Native errors', nativePreview?.validationErrors.length ?? 0],
              ['Support endpoints', endpointCounts.support],
              ['Open endpoints', endpointCounts.open],
              ['Confidence', metric(averageConfidence, 3)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{label}</div>
                <div className="mt-1 text-lg font-semibold" style={{ color: 'var(--text-strong)' }}>{value}</div>
              </div>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <section className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)' }}>
              <h3 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Analyzer</h3>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <dt style={{ color: 'var(--text-muted)' }}>Version</dt><dd style={{ color: 'var(--text-strong)' }}>{result.analyzerVersion}</dd>
                <dt style={{ color: 'var(--text-muted)' }}>Model triangles</dt><dd style={{ color: 'var(--text-strong)' }}>{result.modelTriangleCount.toLocaleString()}</dd>
                <dt style={{ color: 'var(--text-muted)' }}>Support triangles</dt><dd style={{ color: 'var(--text-strong)' }}>{result.supportTriangleCount.toLocaleString()}</dd>
                <dt style={{ color: 'var(--text-muted)' }}>Runtime</dt><dd style={{ color: 'var(--text-strong)' }}>{metric(result.timings.totalMs)} ms</dd>
              </dl>
            </section>
            <section className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)' }}>
              <h3 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Coverage</h3>
              <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                {metric(result.coverage.surfaceCoverage * 100, 1)}% matched;{' '}
                {result.coverage.unmatchedTriangleCount.toLocaleString()} triangles unmatched.
                Coverage remains zero until native topology generation is implemented.
              </p>
            </section>
          </div>

          <section className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)' }}>
            <h3 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Native topology preview</h3>
            <div className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
              {nativePreview ? (
                <>
                  {nativePreview.payload.roots.length} roots, {nativePreview.payload.trunks.length} trunks,{' '}
                  {nativePreview.payload.branches.length} branches, {nativePreview.payload.braces.length} braces, and{' '}
                  {nativePreview.payload.knots.length} knots are ready in a validated import payload.
                  {nativePreview.validationErrors.length > 0 ? (
                    <div className="mt-2 space-y-1">
                      {nativePreview.validationErrors.map((message) => (
                        <div key={message} style={{ color: 'var(--danger)' }}>
                          {message}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {nativePreview.rejected.length > 0 ? (
                    <div className="mt-2 space-y-1">
                      {nativePreview.rejected.map((entry) => (
                        <div key={entry.topologyId}>
                          <strong style={{ color: 'var(--text-strong)' }}>{entry.axialCandidateId} / {entry.code}:</strong>{' '}
                          {entry.message}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </>
              ) : 'Native payload generation did not run.'}
            </div>
          </section>

          <section className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)' }}>
            <h3 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Axial candidates</h3>
            <div className="mt-2 max-h-44 overflow-auto text-xs">
              {result.graph.axialCandidates.length === 0 ? (
                <div style={{ color: 'var(--text-muted)' }}>No axial candidates detected.</div>
              ) : result.graph.axialCandidates.map((candidate) => (
                <div key={candidate.id} className="grid grid-cols-[1fr_auto_auto_auto] gap-3 border-b py-1.5 last:border-b-0" style={{ borderColor: 'var(--border-subtle)' }}>
                  <span style={{ color: 'var(--text-strong)' }}>{candidate.id}</span>
                  <span style={{ color: 'var(--text-muted)' }}>{metric(candidate.shaftLengthMm)} mm shaft</span>
                  <span style={{ color: 'var(--text-muted)' }}>D {metric(candidate.meanRadiusMm * 2)}</span>
                  <span style={{ color: candidate.accepted ? '#22c55e' : 'var(--danger)' }}>{metric(candidate.confidence.finalConfidence, 3)}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)' }}>
            <h3 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Warnings</h3>
            <div className="mt-2 space-y-1.5 text-xs">
              {result.warnings.length === 0 ? (
                <div style={{ color: 'var(--text-muted)' }}>No warnings.</div>
              ) : result.warnings.map((warning, index) => (
                <div key={`${warning.code}-${index}`} style={{ color: 'var(--text-muted)' }}>
                  <strong style={{ color: 'var(--text-strong)' }}>{warning.code}:</strong> {warning.message}
                </div>
              ))}
            </div>
          </section>
        </>
      ) : null}
    </StructuredDialogModal>
  );
}
