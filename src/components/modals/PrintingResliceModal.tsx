'use client';

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';

type PrintingResliceModalProps = {
  isOpen: boolean;
  onCancel: () => void;
  onResliceNow: () => void;
};

export function PrintingResliceModal({
  isOpen,
  onCancel,
  onResliceNow,
}: PrintingResliceModalProps) {
  return (
    <StructuredDialogModal
      open={isOpen}
      ariaLabel="Re-slice required"
      title="Scene Modified"
      subtitle="Please re-slice before printing"
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
            className="ui-button ui-button-secondary !h-9 px-3 text-xs"
            onClick={onCancel}
          >
            Back
          </button>
          <button
            type="button"
            className="ui-button !h-9 px-3 text-xs inline-flex items-center justify-center gap-1.5"
            style={{
              borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 45%)',
              background: 'color-mix(in srgb, var(--accent), var(--surface-1) 86%)',
              color: 'var(--accent)',
            }}
            onClick={onResliceNow}
          >
            Re-Slice Now
          </button>
        </>
      )}
    >
      <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        Your model has been modified (geometry, position, rotation, scale, or supports changed). The current slice is no longer valid.
      </p>
    </StructuredDialogModal>
  );
}
