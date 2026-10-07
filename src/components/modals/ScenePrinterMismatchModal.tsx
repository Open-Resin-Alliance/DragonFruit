'use client';

import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/atoms';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';

type BuildVolumeMm = { width: number; depth: number; height: number };

type ScenePrinterMismatchModalProps = {
  isOpen: boolean;
  /** The printer the scene was written for, as its embedded bundle names it. */
  recordedPrinterName?: string;
  recordedBuildVolumeMm: BuildVolumeMm;
  /** The profile selected in this session. */
  currentPrinterName: string;
  currentBuildVolumeMm: BuildVolumeMm;
  /** True when switching has to add the printer from the scene first. */
  willAddPrinter: boolean;
  onSwitch: () => void;
  onKeep: () => void;
};

/**
 * Shown when an imported scene was written for a printer with a larger build
 * volume than the one selected. The scene carries that printer whole, so the
 * comparison does not depend on the profile being installed here, and switching
 * can add it when it is not.
 */
export function ScenePrinterMismatchModal({
  isOpen,
  recordedPrinterName,
  recordedBuildVolumeMm,
  currentPrinterName,
  currentBuildVolumeMm,
  willAddPrinter,
  onSwitch,
  onKeep,
}: ScenePrinterMismatchModalProps) {
  const { _ } = useLingui();
  const recordedLabel = recordedPrinterName?.trim() || _(msg`the printer this scene was built for`);

  return (
    <StructuredDialogModal
      open={isOpen}
      ariaLabel={_(msg`Scene built for a bigger printer`)}
      title={_(msg`Built for a bigger printer`)}
      subtitle={_(msg`This scene may not fit the one selected`)}
      icon={<AlertTriangle className="h-4 w-4" />}
      iconTone="warning"
      zIndexClassName="z-[130]"
      closeAriaLabel={_(msg`Close modal`)}
      onClose={onKeep}
      onBackdropClick={onKeep}
      actions={
        <>
          <Button variant="secondary" onClick={onKeep}>
            <Trans>Keep {currentPrinterName}</Trans>
          </Button>
          <Button
            variant="tinted-accent"
            className="inline-flex items-center justify-center gap-1.5"
            onClick={onSwitch}
          >
            <Trans>Switch to {recordedLabel}</Trans>
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        <Trans comment="A printer name, shown in bold.">
          <strong className="text-sm font-medium" style={{ color: 'var(--text-strong)' }}>{recordedLabel}</strong>{' '}
          builds {recordedBuildVolumeMm.width} × {recordedBuildVolumeMm.depth} ×{' '}
          {recordedBuildVolumeMm.height} mm.
        </Trans>
      </p>
      <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        <Trans comment="A printer name, shown in bold.">
          The printer selected now,{' '}
          <strong className="text-sm font-medium" style={{ color: 'var(--text-strong)' }}>{currentPrinterName}</strong>
          , builds {currentBuildVolumeMm.width} × {currentBuildVolumeMm.depth} ×{' '}
          {currentBuildVolumeMm.height} mm. A plate packed for the larger machine will not fit.
        </Trans>
      </p>
      <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        {willAddPrinter ? (
          <Trans comment="A printer name, shown in bold.">
            It is not in your printer library, so switching adds{' '}
            <strong className="text-sm font-medium" style={{ color: 'var(--text-strong)' }}>{recordedLabel}</strong>{' '}
            from this scene.
          </Trans>
        ) : (
          <Trans comment="A printer name, shown in bold.">
            Switch to{' '}
            <strong className="text-sm font-medium" style={{ color: 'var(--text-strong)' }}>{recordedLabel}</strong>{' '}
            before importing?
          </Trans>
        )}
      </p>
    </StructuredDialogModal>
  );
}
