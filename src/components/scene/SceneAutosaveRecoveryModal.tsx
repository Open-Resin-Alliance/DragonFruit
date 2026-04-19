'use client';

import React from 'react';
import { AlertTriangle, ArchiveRestore, Trash2, X } from 'lucide-react';

type Props = {
  savedAt: string;
  onRestore: () => Promise<void> | void;
  onDiscard: () => Promise<void> | void;
};

export function SceneAutosaveRecoveryModal({ savedAt, onRestore, onDiscard }: Props) {
  const [busy, setBusy] = React.useState<'none' | 'restore' | 'discard'>('none');

  const formattedDate = React.useMemo(() => {
    const ts = Date.parse(savedAt);
    if (!Number.isFinite(ts)) return savedAt;
    const d = new Date(ts);
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    return sameDay ? d.toLocaleTimeString() : d.toLocaleString();
  }, [savedAt]);

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
        aria-label="Recover unsaved scene"
      >
        {/* Header */}
        <div
          className="flex items-center justify-between gap-4 border-b px-5 py-4"
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
                Unsaved Scene Found
              </h2>
              <p className="mt-0.5 text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                DragonFruit autosaved a scene at {formattedDate}
              </p>
            </div>
          </div>

          <button
            type="button"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border transition-colors"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'var(--surface-1)',
              color: 'var(--text-muted)',
            }}
            aria-label="Dismiss"
            disabled={busy !== 'none'}
            onClick={() => { void handleDiscard(); }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="space-y-4 p-5">
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            It looks like DragonFruit quit before you saved your last session. You can restore the autosaved scene or discard it and start fresh.
          </p>

          <div
            className="rounded-lg border px-3 py-2.5"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'color-mix(in srgb, var(--surface-1), black 8%)',
            }}
          >
            <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              Last autosave
            </div>
            <div className="mt-1 text-sm font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>
              {formattedDate}
            </div>
          </div>

          <div className="flex shrink-0 items-center justify-end gap-2 pt-1">
            <button
              type="button"
              className="ui-button ui-button-secondary !h-9 px-3 text-xs inline-flex items-center gap-1.5"
              disabled={busy !== 'none'}
              onClick={() => { void handleDiscard(); }}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Discard
            </button>
            <button
              type="button"
              className="ui-button !h-9 px-3 text-xs inline-flex items-center gap-1.5"
              style={{
                borderColor: 'color-mix(in srgb, #22c55e, var(--border-subtle) 45%)',
                background: 'color-mix(in srgb, #22c55e, var(--surface-1) 86%)',
                color: 'color-mix(in srgb, #22c55e, var(--text-strong) 18%)',
              }}
              disabled={busy !== 'none'}
              onClick={() => { void handleRestore(); }}
            >
              <ArchiveRestore className="h-3.5 w-3.5" />
              Restore Scene
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
