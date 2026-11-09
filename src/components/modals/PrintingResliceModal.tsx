'use client';

import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
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
  const { _ } = useLingui();
  return (
    <StructuredDialogModal
      open={isOpen}
      ariaLabel={_(msg`Scene Modified`)}
      title={_(msg`Scene Modified`)}
      subtitle={_(msg`Please re-slice before printing`)}
      icon={<AlertTriangle className="h-4 w-4" />}
      iconTone="warning"
      zIndexClassName="z-[130]"
      closeAriaLabel={_(msg`Close modal`)}
      onClose={onCancel}
      onBackdropClick={onCancel}
      actions={(
        <>
          <Button variant="secondary" onClick={onCancel}>
            <Trans>Back</Trans>
          </Button>
          <Button
            variant="tinted-accent"
            className="inline-flex items-center justify-center gap-1.5"
            onClick={onResliceNow}
          >
            <Trans>Re-Slice Now</Trans>
          </Button>
        </>
      )}
    >
      <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        <Trans>Your model has been modified (geometry, position, rotation, scale, or supports changed). The current slice is no longer valid.</Trans>
      </p>
    </StructuredDialogModal>
  );
}
