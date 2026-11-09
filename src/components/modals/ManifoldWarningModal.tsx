'use client';

import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { AlertTriangle, Wrench } from 'lucide-react';
import { Button } from '@/components/atoms';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';

type ManifoldWarningModalProps = {
  isOpen: boolean;
  onDismiss: () => void;
  onRepairNow: () => void;
};

export function ManifoldWarningModal({
  isOpen,
  onDismiss,
  onRepairNow,
}: ManifoldWarningModalProps) {
  const { _ } = useLingui();
  return (
    <StructuredDialogModal
      open={isOpen}
      ariaLabel={_(msg`Mesh Issue detected`)}
      title={_(msg`Mesh Issue detected`)}
      subtitle={_(msg`This mesh isn't a valid solid`)}
      icon={<AlertTriangle className="h-4 w-4" />}
      iconTone="warning"
      zIndexClassName="z-[130]"
      // No close-X and backdrop clicks are ignored: the user leaves through
      // Dismiss or Repair Now.
      onBackdropClick={() => {}}
      actions={(
        <>
          <Button variant="secondary" onClick={onDismiss}>
            <Trans>Dismiss</Trans>
          </Button>
          <Button
            variant="tinted-accent"
            className="inline-flex items-center justify-center gap-1.5"
            onClick={onRepairNow}
          >
            <Wrench className="h-3.5 w-3.5" />
            <Trans>Repair Now</Trans>
          </Button>
        </>
      )}
    >
      <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        <Trans>
          Parts of this mesh are not closed — edges are left open, faces cross through each other,
          or surfaces do not quite meet. Slicing and support placement expect a sealed solid, so
          defects can reach the print without showing up here first.
        </Trans>
      </p>
      <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        <Trans>
          The red-striped areas in the viewport mark the parts that failed validation.
        </Trans>
      </p>
      <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        <Trans>
          You can dismiss this and keep working, or repair the mesh now.
        </Trans>
      </p>
    </StructuredDialogModal>
  );
}
