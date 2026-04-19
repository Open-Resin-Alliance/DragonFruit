'use client';

import React from 'react';
import { AlertTriangle, X } from 'lucide-react';

type DestructiveTransformModalProps = {
  isOpen: boolean;
  modelName: string | null;
  supportCount: number;
  operationLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
};

export function DestructiveTransformModal({
  isOpen,
  modelName,
  supportCount,
  operationLabel,
  onCancel,
  onConfirm,
}: DestructiveTransformModalProps) {
  React.useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCancel();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
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
        aria-label="Destructive transform warning"
      >
        <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="flex items-center gap-2.5">
            <span
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border"
              style={{
                borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 50%)',
                background: 'color-mix(in srgb, #d97706, var(--surface-1) 85%)',
                color: '#d97706',
              }}
            >
              <AlertTriangle className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-base font-semibold" style={{ color: 'var(--text-strong)' }}>
                Destructive Transform
              </h2>
              <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Supports will be deleted before continuing
              </p>
            </div>
          </div>

          <button
            type="button"
            className="h-8 w-8 inline-flex items-center justify-center rounded-md border transition-colors"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'var(--surface-1)',
              color: 'var(--text-muted)',
            }}
            aria-label="Close warning modal"
            onClick={onCancel}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Operation</div>
            <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{operationLabel}</div>
          </div>

          <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Model</div>
            <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{modelName ?? 'Unknown Model'}</div>
          </div>

          <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Supports Detected</div>
            <div className="text-sm font-semibold tabular-nums" style={{ color: 'var(--text-strong)' }}>
              {supportCount.toLocaleString()}
            </div>
          </div>

          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            This transform invalidates existing supports. If you continue, all supports for this model will be deleted.
          </p>

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              className="ui-button ui-button-secondary !h-9 px-3 text-xs"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              className="ui-button ui-button-accent !h-9 px-3 text-xs"
              onClick={onConfirm}
            >
              Delete Supports & Continue
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
