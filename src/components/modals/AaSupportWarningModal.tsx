'use client';

import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { AlertTriangle } from 'lucide-react';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';

type AaSupportWarningModalProps = {
  isOpen: boolean;
  modelName: string;
  onCancel: () => void;
  onProceed: () => void;
};

export function AaSupportWarningModal({
  isOpen,
  modelName,
  onCancel,
  onProceed,
}: AaSupportWarningModalProps) {
  const { _ } = useLingui();
  return (
    <StructuredDialogModal
      open={isOpen}
      ariaLabel={_(msg`Anti-aliasing with possible support geometry`)}
      title={_(msg`Anti-Aliasing Warning`)}
      subtitle={_(msg`Possible unclassified support geometry`)}
      icon={<AlertTriangle className="h-4 w-4" />}
      iconTone="warning"
      zIndexClassName="z-[130]"
      closeAriaLabel={_(msg`Close modal`)}
      onClose={onCancel}
      onBackdropClick={onCancel}
      actions={(
        <>
          <button
            type="button"
            className="ui-button ui-button-secondary !h-9 px-3 text-xs"
            onClick={onCancel}
          >
            <Trans>Cancel</Trans>
          </button>
          <button
            type="button"
            className="ui-button !h-9 px-3 text-xs inline-flex items-center justify-center gap-1.5"
            style={{
              borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 45%)',
              background: 'color-mix(in srgb, var(--accent), var(--surface-1) 86%)',
              color: 'var(--accent)',
            }}
            onClick={onProceed}
          >
            <Trans>Use Anyway</Trans>
          </button>
        </>
      )}
    >
      <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        <Trans comment="{modelName} is the imported model's file name; it is shown in bold.">
          <strong className="text-sm font-medium" style={{ color: 'var(--text-strong)' }}>{modelName}</strong>{' '}
          was imported as an STL file. Our analysis could not determine whether this model contains
          support geometry baked into the mesh.
        </Trans>
      </p>
      <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        <Trans>
          When anti-aliasing is enabled, we disable it for identified support geometry to preserve
          fine support structure detail. Since we were unable to identify support geometry in this
          model, we cannot guarantee print quality.
        </Trans>
      </p>
    </StructuredDialogModal>
  );
}
