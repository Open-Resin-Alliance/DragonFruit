'use client';

import React from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { IconButton } from '@/components/atoms/IconButton';
import { useEscapeToClose } from '@/hotkeys/useEscapeToClose';
import { ICON_TONE_STYLES, type IconTone } from '@/components/atoms/iconTone';

type StructuredDialogModalProps = {
  open: boolean;
  ariaLabel: string;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  iconTone?: IconTone;
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
  actionsClassName = 'grid grid-flow-col auto-cols-fr gap-2 pt-1',
  closeAriaLabel = 'Close dialog',
  closeDisabled = false,
  onClose,
  onBackdropClick,
  children,
  actions,
}: StructuredDialogModalProps) {
  // Escape closes the dialog by default; a dialog whose close button is
  // disabled (or that has no close affordance) swallows the key instead.
  const escapeClose = closeDisabled ? undefined : (onClose ?? onBackdropClick);
  useEscapeToClose(open, escapeClose);

  if (!open) return null;

  const handleBackdropMouseDown: React.MouseEventHandler<HTMLDivElement> = (event) => {
    if (event.target !== event.currentTarget) return;

    if (onBackdropClick) {
      onBackdropClick();
      return;
    }

    onClose?.();
  };

  return createPortal(
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
            <IconButton
              variant="surface"
              size="md"
              aria-label={closeAriaLabel}
              disabled={closeDisabled}
              onClick={onClose}
            >
              <X className="w-4 h-4" />
            </IconButton>
          ) : null}
        </div>

        <div className={bodyClassName}>
          {children}
          {actions ? <div className={actionsClassName}>{actions}</div> : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
