'use client';

import React from 'react';
import { X } from 'lucide-react';

type DialogIconTone = 'warning' | 'danger' | 'accent' | 'neutral';

const ICON_TONE_STYLES: Record<DialogIconTone, React.CSSProperties> = {
  warning: {
    borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 50%)',
    background: 'color-mix(in srgb, #d97706, var(--surface-1) 85%)',
    color: '#d97706',
  },
  danger: {
    borderColor: 'color-mix(in srgb, #ef4444, var(--border-subtle) 55%)',
    background: 'color-mix(in srgb, #ef4444, var(--surface-1) 88%)',
    color: 'var(--danger)',
  },
  accent: {
    borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 45%)',
    background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 90%)',
    color: 'var(--accent-secondary)',
  },
  neutral: {
    borderColor: 'var(--border-subtle)',
    background: 'var(--surface-1)',
    color: 'var(--text-muted)',
  },
};

type StructuredDialogModalProps = {
  open: boolean;
  ariaLabel: string;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  iconTone?: DialogIconTone;
  zIndexClassName?: string;
  maxWidthClassName?: string;
  panelClassName?: string;
  bodyClassName?: string;
  actionsClassName?: string;
  closeAriaLabel?: string;
  closeDisabled?: boolean;
  onClose?: () => void;
  onBackdropClick?: () => void;
  children?: React.ReactNode;
  actions?: React.ReactNode;
};

export function StructuredDialogModal({
  open,
  ariaLabel,
  title,
  subtitle,
  icon,
  iconTone = 'warning',
  zIndexClassName = 'z-[100]',
  maxWidthClassName = 'max-w-lg',
  panelClassName = '',
  bodyClassName = 'space-y-4 p-5',
  actionsClassName = 'flex shrink-0 items-center justify-end gap-2 pt-1',
  closeAriaLabel = 'Close dialog',
  closeDisabled = false,
  onClose,
  onBackdropClick,
  children,
  actions,
}: StructuredDialogModalProps) {
  if (!open) return null;

  const handleBackdropMouseDown: React.MouseEventHandler<HTMLDivElement> = (event) => {
    if (event.target !== event.currentTarget) return;

    if (onBackdropClick) {
      onBackdropClick();
      return;
    }

    onClose?.();
  };

  return (
    <div
      className={`fixed inset-0 ${zIndexClassName} flex items-center justify-center bg-black/55 backdrop-blur-sm px-3`}
      onMouseDown={handleBackdropMouseDown}
    >
      <div
        className={`w-full ${maxWidthClassName} overflow-hidden rounded-xl border shadow-2xl ${panelClassName}`}
        style={{
          background: 'var(--surface-0)',
          borderColor: 'var(--border-subtle)',
          boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
        }}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
      >
        <div className="flex items-center justify-between gap-4 border-b px-5 py-4" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="flex min-w-0 items-center gap-3">
            {icon ? (
              <span
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border"
                style={ICON_TONE_STYLES[iconTone]}
              >
                {icon}
              </span>
            ) : null}

            <div className="min-w-0 pr-2">
              <h2 className="text-base font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>
                {title}
              </h2>
              {subtitle ? (
                <p className="mt-0.5 text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                  {subtitle}
                </p>
              ) : null}
            </div>
          </div>

          {onClose ? (
            <button
              type="button"
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border transition-colors"
              style={{
                borderColor: 'var(--border-subtle)',
                background: 'var(--surface-1)',
                color: 'var(--text-muted)',
              }}
              aria-label={closeAriaLabel}
              disabled={closeDisabled}
              onClick={onClose}
            >
              <X className="w-4 h-4" />
            </button>
          ) : null}
        </div>

        <div className={bodyClassName}>
          {children}
          {actions ? <div className={actionsClassName}>{actions}</div> : null}
        </div>
      </div>
    </div>
  );
}
