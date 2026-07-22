'use client';

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';

type ManifoldWarningModalProps = {
  isOpen: boolean;
  modelName: string;
  onAcknowledge: () => void;
};

export function ManifoldWarningModal({
  isOpen,
  modelName,
  onAcknowledge,
}: ManifoldWarningModalProps) {
  return (
    <StructuredDialogModal
      open={isOpen}
      ariaLabel="Possible mesh manifold issues"
      title="Mesh Manifold Warning"
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
        <strong className="text-sm font-medium" style={{ color: 'var(--text-strong)' }}>{modelName}</strong>{' '}
        may have manifold issues &mdash; it did not pass our closed-solid validity check. Meshes that
        are not watertight, valid solids can lead to problems further in the workflow, such as during
        support generation, slicing, or export.
      </p>
      <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        This is why the mesh is shown with a red striped overlay in the viewport. You can continue
        working with it, but results may be unreliable until the mesh is repaired.
      </p>
    </StructuredDialogModal>
  );
}
