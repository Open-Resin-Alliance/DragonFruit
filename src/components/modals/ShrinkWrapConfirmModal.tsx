'use client';

import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/atoms';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';

type ShrinkWrapConfirmModalProps = {
  isOpen: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

/**
 * Confirms a shrink-wrap before it runs. The pass reworks the whole surface into one solid rather
 * than editing it, so the user accepts a new mesh here instead of discovering one in a print.
 */
export function ShrinkWrapConfirmModal({
  isOpen,
  onCancel,
  onConfirm,
}: ShrinkWrapConfirmModalProps) {
  const { _ } = useLingui();
  return (
    <StructuredDialogModal
      open={isOpen}
      ariaLabel={_(msg`Shrink-Wrap confirmation`)}
      title={_(msg`Shrink-Wrap this model?`)}
      subtitle={_(msg`Reworks the surface into one solid`)}
      icon={<RefreshCw className="h-4 w-4" />}
      iconTone="accent"
      zIndexClassName="z-[130]"
      // No close-X and backdrop clicks are ignored: the user leaves through Cancel or Shrink-Wrap.
      onBackdropClick={() => {}}
      actions={(
        <>
          <Button variant="secondary" onClick={onCancel}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            variant="tinted-accent"
            className="inline-flex items-center justify-center gap-1.5"
            onClick={onConfirm}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <Trans>Shrink-Wrap</Trans>
          </Button>
        </>
      )}
    >
      <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        <Trans>This merges overlapping shells, closes gaps and drops loose pieces, leaving one solid.</Trans>
      </p>
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
            <Trans>The rebuilt surface will replace this model in your current scene. A model that cannot be resolved is left untouched, and you can undo this afterwards.</Trans>
          </p>
        </div>
      </div>
    </StructuredDialogModal>
  );
}
