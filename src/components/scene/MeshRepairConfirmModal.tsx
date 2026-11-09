'use client';

import React from 'react';
import { Wrench, AlertTriangle, Layers } from 'lucide-react';
import { Button } from '@/components/atoms';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';
import type { Translate } from '@/utils/unitFormatting';
import type { MeshRepairConfirmPrompt } from '@/features/scene/useSceneCollectionManager';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';

type Props = {
  prompt: MeshRepairConfirmPrompt;
  onRepair: () => void;
  onRepairParts: () => void;
  onLoadAsIs: () => void;
  onCancelImport: () => void;
};

/**
 * Interpolated translations live in module-scope helpers rather than inline in the component: React
 * Compiler renames the interpolated locals in production builds, which desyncs the message id from
 * the compiled catalog and renders the placeholders raw. See `docs/dev/backlog.md`.
 */
function separateShellsNote(shells: number, translate: Translate): string {
  return translate(
    msg`This file holds ${shells} separate shells, which usually means several objects on one plate. Repaired whole it gets a single verdict for all of them; repaired part by part each object is reported on its own, and the ones that are fine stay fine.`,
  );
}

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

export function MeshRepairConfirmModal({
  prompt,
  onRepair,
  onRepairParts,
  onLoadAsIs,
  onCancelImport,
}: Props) {
  const { _ } = useLingui();
  const { fileName, analysis, canRepairParts } = prompt;

  return (
    <StructuredDialogModal
      open
      zIndexClassName="z-[220]"
      ariaLabel={_(msg`Mesh repair confirmation`)}
      title={_(msg`Repair recommended before slicing`)}
      subtitle={_(msg`This model has severe mesh issues and is likely to need heavy repair.`)}
      icon={<AlertTriangle className="h-4 w-4" />}
      iconTone="warning"
      closeAriaLabel={_(msg`Cancel importing this model`)}
      onClose={onCancelImport}
      onBackdropClick={onCancelImport}
      actions={(
        <>
          <Button
            variant="secondary"
            className="w-full"
            onClick={onLoadAsIs}
          >
            <Trans>Load As-Is</Trans>
          </Button>
          <Button
            variant="tinted-accent"
            className="w-full gap-1.5"
            onClick={onRepair}
          >
            <Wrench className="h-3.5 w-3.5" />
            <Trans>Repair</Trans>
          </Button>
          {canRepairParts && analysis.component_count >= 2 ? (
            <Button
              variant="secondary"
              className="w-full gap-1.5"
              onClick={onRepairParts}
            >
              <Layers className="h-3.5 w-3.5" />
              <Trans>Repair parts separately</Trans>
            </Button>
          ) : null}
        </>
      )}
    >
      {/* File info */}
      <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
        <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}><Trans>File</Trans></div>
        <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-strong)' }} title={fileName}>
          {fileName}
        </div>
      </div>

      {/* Analysis stats */}
      <div className="rounded-md border px-3 pt-2 pb-1" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
        <div className="text-[11px] uppercase tracking-wide mb-1" style={{ color: 'var(--text-muted)' }}><Trans>Analysis</Trans></div>
        <StatRow label={_(msg({ message: 'Triangles', context: 'Mesh analysis row' }))} value={analysis.triangle_count} />
        <StatRow label={_(msg({ message: 'Components', context: 'Mesh analysis row' }))} value={analysis.component_count} />
        <StatRow label={_(msg({ message: 'Non-manifold edges', context: 'Mesh analysis row' }))} value={analysis.non_manifold_edges} />
        <StatRow label={_(msg({ message: 'Boundary loops', context: 'Mesh analysis row' }))} value={analysis.boundary_loops} />
      </div>

      {canRepairParts && analysis.component_count >= 2 ? (
        <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {separateShellsNote(analysis.component_count, _)}
          </p>
        </div>
      ) : null}

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
            <Trans>
              <strong style={{ color: 'var(--text-strong)' }}>Disclaimer:</strong> Repair is recommended.
              Loading this mesh as-is may cause slicing errors or print failures, and successful output cannot be guaranteed.
            </Trans>
          </p>
        </div>
      </div>
    </StructuredDialogModal>
  );
}
