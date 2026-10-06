'use client';

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/atoms';
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
          <Button variant="secondary" onClick={onCancel}>
            Back
          </Button>
          <Button
            variant="tinted-accent"
            className="inline-flex items-center justify-center gap-1.5"
            onClick={onResliceNow}
          >
            Re-Slice Now
          </Button>
        </>
      )}
    >
      <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        Your model has been modified (geometry, position, rotation, scale, or supports changed). The current slice is no longer valid.
      </p>
    </StructuredDialogModal>
  );
}
