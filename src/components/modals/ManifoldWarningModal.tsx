'use client';

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';

type ManifoldWarningModalProps = {
  isOpen: boolean;
  onAcknowledge: () => void;
};

export function ManifoldWarningModal({
  isOpen,
  onAcknowledge,
}: ManifoldWarningModalProps) {
  return (
    <StructuredDialogModal
      open={isOpen}
      ariaLabel="Possible mesh manifold issues"
      title="Warning: Non-manifold mesh"
      subtitle="This mesh may not be a valid solid"
      icon={<AlertTriangle className="h-4 w-4" />}
      iconTone="warning"
      zIndexClassName="z-[130]"
      // No close-X and backdrop clicks are ignored: the user must press OK to
      // acknowledge the manifold warning.
      onBackdropClick={() => {}}
      actions={(
        <button
          type="button"
          className="ui-button ui-button-accent !h-9 w-full px-3 text-xs"
          onClick={onAcknowledge}
        >
          OK
        </button>
      )}
    >
      <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        Failed manifold validation. Recommend mesh repair before continuing.
      </p>
      <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        This may cause issues with printability including support placement and slicing. Some may not
        be immediately visible (e.g. slicing defects, etc.).
      </p>
      <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        Red overlay indicates individual components failing validation.
      </p>
    </StructuredDialogModal>
  );
}
