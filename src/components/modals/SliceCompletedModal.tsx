'use client';

import React from 'react';
import { CheckCircle2, ExternalLink, FolderOpen } from 'lucide-react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Button } from '@/components/atoms';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';
import { useLocaleFormat } from '@/hooks/useLocaleFormat';

type SliceCompletedModalProps = {
  isOpen: boolean;
  onClose: () => void;
  filePath: string | null;
  slicingTimeMs: number | null;
  /** When set, replaces the Close button with Open UVTools + Open Directory. */
  onOpenInUvTools?: (filePath: string) => void;
};

export function SliceCompletedModal({
  isOpen,
  onClose,
  filePath,
  slicingTimeMs,
  onOpenInUvTools,
}: SliceCompletedModalProps) {
  const { _ } = useLingui();
  const fmt = useLocaleFormat();
  const [openDirectoryError, setOpenDirectoryError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!isOpen) {
      setOpenDirectoryError(null);
    }
  }, [isOpen]);

  const handleOpenDirectory = async () => {
    if (!filePath) return;
    try {
      setOpenDirectoryError(null);
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('reveal_in_file_manager', { path: filePath });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? _(msg`Failed to open directory.`));
      setOpenDirectoryError(message || _(msg`Failed to open directory.`));
      console.error('Failed to open directory:', error);
    }
  };

  const formatTime = (ms: number | null): string => {
    if (ms === null || ms === undefined) return '—';
    if (ms < 1000) return fmt.quantity(ms, 0, 'ms');
    return fmt.quantity(ms / 1000, 2, 's');
  };

  return (
    <StructuredDialogModal
      open={isOpen}
      ariaLabel={_(msg`Slicing completed`)}
      title={_(msg`Slicing Finished`)}
      icon={<CheckCircle2 className="h-4 w-4" />}
      iconTone="accent"
      zIndexClassName="z-[130]"
      maxWidthClassName="max-w-md"
      closeAriaLabel={_(msg`Close slicing finished modal`)}
      onClose={onClose}
      onBackdropClick={onClose}
      actions={onOpenInUvTools ? (
        <>
          <Button
            variant="tinted-accent"
            onClick={() => filePath && onOpenInUvTools(filePath)}
            disabled={!filePath}
            className="inline-flex items-center justify-center gap-1.5 disabled:opacity-45"
          >
            <ExternalLink className="w-4 h-4" />
            <Trans>Open in UVTools</Trans>
          </Button>
          <Button
            variant="tinted-accent"
            onClick={handleOpenDirectory}
            disabled={!filePath}
            className="inline-flex items-center justify-center gap-1.5 disabled:opacity-45"
          >
            <FolderOpen className="w-4 h-4" />
            <Trans>Open Directory</Trans>
          </Button>
        </>
      ) : (
        <>
          <Button variant="secondary" onClick={onClose}>
            <Trans>Close</Trans>
          </Button>
          <Button
            variant="tinted-accent"
            onClick={handleOpenDirectory}
            disabled={!filePath}
            className="inline-flex items-center justify-center gap-1.5 disabled:opacity-45"
          >
            <FolderOpen className="w-4 h-4" />
            <Trans>Open Directory</Trans>
          </Button>
        </>
      )}
    >
      <div
        className="rounded-lg border p-3 space-y-2"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
      >
        <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
          <Trans>File Location</Trans>
        </div>
        <div
          className="text-sm font-mono break-all"
          style={{ color: 'var(--text-strong)' }}
          title={filePath || undefined}
        >
          {filePath ?? '—'}
        </div>
      </div>

      {slicingTimeMs !== null && (
        <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
          <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
            <Trans>Slicing Time</Trans>
          </div>
          <div className="text-sm font-semibold mt-1" style={{ color: 'var(--text-strong)' }}>
            {formatTime(slicingTimeMs)}
          </div>
        </div>
      )}

      {openDirectoryError && (
        <div
          className="rounded-md border px-2.5 py-2 text-[11px] leading-snug"
          style={{
            borderColor: 'color-mix(in srgb, var(--danger), var(--border-subtle) 45%)',
            background: 'color-mix(in srgb, var(--danger), var(--surface-1) 92%)',
            color: 'var(--danger)',
          }}
        >
          {openDirectoryError}
        </div>
      )}
    </StructuredDialogModal>
  );
}
