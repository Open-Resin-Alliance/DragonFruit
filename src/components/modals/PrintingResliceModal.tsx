'use client';

import React from 'react';
import { AlertTriangle, X } from 'lucide-react';

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
        className="w-full max-w-md overflow-hidden rounded-xl border shadow-2xl"
        style={{
          background: 'var(--surface-0)',
          borderColor: 'var(--border-subtle)',
          boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
        }}
        role="dialog"
        aria-modal="true"
        aria-label="Re-slice required"
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
                Scene Modified
              </h2>
              <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Please re-slice before printing
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
            aria-label="Close modal"
            onClick={onCancel}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            Your model has been modified (geometry, position, rotation, scale, or supports changed). The current slice is no longer valid.
          </p>

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              className="ui-button ui-button-secondary !h-9 px-3 text-xs"
              onClick={onCancel}
            >
              Back
            </button>
            <button
              type="button"
              className="ui-button ui-button-accent !h-9 px-3 text-xs"
              onClick={onResliceNow}
            >
              Re-Slice Now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
