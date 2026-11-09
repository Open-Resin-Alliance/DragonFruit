'use client';

import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/atoms';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';

type ObsoleteVoxlVersionModalProps = {
  isOpen: boolean;
  fileName: string;
  detected: 'v1-json' | 'v1-binary';
  onDismiss: () => void;
};

/**
 * Shown when a `.voxl` scene is recognised as a VOXL V1 file, which this build
 * no longer reads. V1 was only ever written by pre-release builds, so the file
 * is refused rather than half-parsed — this explains what happened and how to
 * recover the scene.
 */
export function ObsoleteVoxlVersionModal({
  isOpen,
  fileName,
  detected,
  onDismiss,
}: ObsoleteVoxlVersionModalProps) {
  const { _ } = useLingui();
  return (
    <StructuredDialogModal
      open={isOpen}
      ariaLabel={_(msg`Unsupported scene version`)}
      title={_(msg`Can't open this scene`)}
      subtitle={_(msg`Saved by an obsolete DragonFruit version`)}
      icon={<AlertTriangle className="h-4 w-4" />}
      iconTone="warning"
      zIndexClassName="z-[130]"
      closeAriaLabel={_(msg`Close modal`)}
      onClose={onDismiss}
      onBackdropClick={onDismiss}
      actions={(
        <Button
          variant="tinted-accent"
          className="inline-flex items-center justify-center gap-1.5"
          onClick={onDismiss}
        >
          <Trans>OK</Trans>
        </Button>
      )}
    >
      <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        <Trans comment="{fileName} is the scene file's name; it is shown in bold.">
          <strong className="text-sm font-medium" style={{ color: 'var(--text-strong)' }}>{fileName}</strong>{' '}
          was saved in the VOXL V1 format, which this version no longer reads.
        </Trans>
      </p>
      <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        {detected === 'v1-json' ? (
          <Trans>This file is a VOXL V1 JSON scene.</Trans>
        ) : (
          <Trans>This file is a VOXL V1 binary container.</Trans>
        )}
      </p>
      <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        <Trans>
          To recover it, open the scene in an older version of DragonFruit and save it again — the
          re-saved scene will open here.
        </Trans>
      </p>
    </StructuredDialogModal>
  );
}
