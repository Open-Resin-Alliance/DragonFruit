'use client';

import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { AlertTriangle, ArchiveRestore, Trash2 } from 'lucide-react';
import { useEscapeToClose } from '@/hotkeys/useEscapeToClose';

type Props = {
  savedAt: string;
  /** The exact payload recovery resolved; shown so the restore is never a guess. */
  voxlPath?: string | null;
  /** `sidecar` (beside the project) or `recovery-dir` (the fallback location). */
  origin?: string | null;
  onRestore: () => Promise<void> | void;
  onDiscard: () => Promise<void> | void;
};

export function SceneAutosaveRecoveryModal({ savedAt, voxlPath, origin, onRestore, onDiscard }: Props) {
  // Restore or discard is a deliberate choice: swallow Escape, never guess one.
  useEscapeToClose(true, undefined);

  const { _, i18n } = useLingui();
  const [busy, setBusy] = React.useState<'none' | 'restore' | 'discard'>('none');

  // Formatted against the app locale, not the OS one: a Spanish UI showing an
  // English timestamp is the tell that the recovery dialog was never localized.
  const formattedDate = React.useMemo(() => {
    const ts = Date.parse(savedAt);
    if (!Number.isFinite(ts)) return savedAt;
    const d = new Date(ts);
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    return sameDay ? d.toLocaleTimeString(i18n.locale) : d.toLocaleString(i18n.locale);
  }, [savedAt, i18n.locale]);

  const handleRestore = async () => {
    setBusy('restore');
    try {
      await onRestore();
    } finally {
      setBusy('none');
    }
  };

  const handleDiscard = async () => {
    setBusy('discard');
    try {
      await onDiscard();
    } finally {
      setBusy('none');
    }
  };

  return (
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3"
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border shadow-2xl"
        style={{
          background: 'var(--surface-0)',
          borderColor: 'var(--border-subtle)',
          boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
        }}
        role="dialog"
        aria-modal="true"
        aria-label={_(msg`Recover unsaved scene`)}
      >
        {/* Header */}
        <div
          className="flex items-center gap-4 border-b px-5 py-4"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <div className="flex min-w-0 items-center gap-3">
            <span
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border"
              style={{
                borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 50%)',
                background: 'color-mix(in srgb, #d97706, var(--surface-1) 85%)',
                color: '#d97706',
              }}
            >
              <AlertTriangle className="h-4 w-4" />
            </span>
            <div className="min-w-0 pr-2">
              <h2 className="text-base font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>
                <Trans>Unsaved Scene Found</Trans>
              </h2>
              <p className="mt-0.5 text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                <Trans>DragonFruit autosaved a scene at {formattedDate}</Trans>
              </p>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="space-y-4 p-5">
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            <Trans>It looks like DragonFruit quit before you saved your last session. You can restore the autosaved scene or discard it and start fresh.</Trans>
          </p>

          <div className="grid grid-cols-2 gap-2">
            <div
              className="rounded-lg border px-3 py-2.5"
              style={{
                borderColor: 'var(--border-subtle)',
                background: 'color-mix(in srgb, var(--surface-1), black 8%)',
              }}
            >
              <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                <Trans>Last autosave</Trans>
              </div>
              <div className="mt-1 text-sm font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>
                {formattedDate}
              </div>
            </div>
            {voxlPath ? (
              <div
                className="rounded-lg border px-3 py-2.5"
                style={{
                  borderColor: 'var(--border-subtle)',
                  background: 'color-mix(in srgb, var(--surface-1), black 8%)',
                }}
              >
                <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                  <Trans>Name</Trans>
                </div>
                <div className="mt-1 truncate text-sm font-semibold leading-tight" style={{ color: 'var(--text-strong)' }} title={voxlPath}>
                  {voxlPath.split(/[\\/]/).pop() || voxlPath}
                </div>
              </div>
            ) : null}
          </div>

          <div className="grid grid-cols-2 gap-2 pt-1">
            <button
              type="button"
              className="ui-button !h-9 w-full px-3 text-xs inline-flex items-center justify-center gap-1.5"
              style={{
                borderColor: 'color-mix(in srgb, #ef4444, var(--border-subtle) 45%)',
                background: 'color-mix(in srgb, #ef4444, var(--surface-1) 86%)',
                color: 'var(--danger)',
              }}
              disabled={busy !== 'none'}
              onClick={() => { void handleDiscard(); }}
            >
              <Trash2 className="h-3.5 w-3.5" />
              <Trans>Discard</Trans>
            </button>
            <button
              type="button"
              className="ui-button !h-9 w-full px-3 text-xs inline-flex items-center justify-center gap-1.5"
              style={{
                borderColor: 'color-mix(in srgb, #22c55e, var(--border-subtle) 45%)',
                background: 'color-mix(in srgb, #22c55e, var(--surface-1) 86%)',
                color: 'color-mix(in srgb, #22c55e, var(--text-strong) 18%)',
              }}
              disabled={busy !== 'none'}
              onClick={() => { void handleRestore(); }}
            >
              <ArchiveRestore className="h-3.5 w-3.5" />
              <Trans>Restore</Trans>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
