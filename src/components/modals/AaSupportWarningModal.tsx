'use client';

import React from 'react';
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
  return (
    <StructuredDialogModal
      open={isOpen}
      ariaLabel="Anti-aliasing with possible support geometry"
      title="Anti-Aliasing Warning"
      subtitle="Possible unclassified support geometry"
      icon={<AlertTriangle className="h-4 w-4" />}
      iconTone="warning"
      zIndexClassName="z-[130]"
      closeAriaLabel="Close modal"
      onClose={onCancel}
      onBackdropClick={onCancel}
      actions={(
        <>
          <button
            type="button"
            className="ui-button ui-button-secondary !h-9 w-full px-3 text-xs"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="ui-button ui-button-accent !h-9 w-full px-3 text-xs"
            onClick={onProceed}
          >
            Use Anyway
          </button>
        </>
      )}
    >
      <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        <strong className="text-sm font-medium" style={{ color: 'var(--text-strong)' }}>{modelName}</strong>{' '}
        was imported as an STL file. Our analysis could not determine whether this model contains
        support geometry baked into the mesh.
      </p>
      <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        When anti-aliasing is enabled, we disable it for identified support geometry to preserve
        fine support structure detail. Since we were unable to identify support geometry in this
        model, we cannot guarantee print quality.
      </p>
    </StructuredDialogModal>
  );
}
