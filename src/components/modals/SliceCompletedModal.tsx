'use client';

import React from 'react';
import { CheckCircle2, ExternalLink, FolderOpen } from 'lucide-react';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';

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
  const [openDirectoryError, setOpenDirectoryError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

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
      const message = error instanceof Error ? error.message : String(error ?? 'Failed to open directory.');
      setOpenDirectoryError(message || 'Failed to open directory.');
      console.error('Failed to open directory:', error);
    }
  };

  const formatTime = (ms: number | null): string => {
    if (ms === null || ms === undefined) return '—';
    if (ms < 1000) return `${ms.toFixed(0)} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
  };

  return (
    <StructuredDialogModal
      open={isOpen}
      ariaLabel="Slicing completed"
      title="Slicing Finished"
      icon={<CheckCircle2 className="h-4 w-4" />}
      iconTone="accent"
      zIndexClassName="z-[130]"
      maxWidthClassName="max-w-md"
      closeAriaLabel="Close slicing finished modal"
      onClose={onClose}
      onBackdropClick={onClose}
      actions={onOpenInUvTools ? (
        <>
          <button
            type="button"
            onClick={() => filePath && onOpenInUvTools(filePath)}
            disabled={!filePath}
            className="ui-button ui-button-accent !h-9 px-3 text-sm inline-flex items-center gap-1.5 disabled:opacity-45"
          >
            <ExternalLink className="w-4 h-4" />
            Open in UVTools
          </button>
          <button
            type="button"
            onClick={handleOpenDirectory}
            disabled={!filePath}
            className="ui-button ui-button-secondary !h-9 px-3 text-sm inline-flex items-center gap-1.5 disabled:opacity-45"
          >
            <FolderOpen className="w-4 h-4" />
            Open Directory
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={onClose}
            className="ui-button ui-button-secondary !h-9 px-3 text-sm"
          >
            Close
          </button>
          <button
            type="button"
            onClick={handleOpenDirectory}
            disabled={!filePath}
            className="ui-button ui-button-accent !h-9 px-3 text-sm inline-flex items-center gap-1.5 disabled:opacity-45"
          >
            <FolderOpen className="w-4 h-4" />
            Open Directory
          </button>
        </>
      )}
    >
      <div
        className="rounded-lg border p-3 space-y-2"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
      >
        <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
          File Location
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
            Slicing Time
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
