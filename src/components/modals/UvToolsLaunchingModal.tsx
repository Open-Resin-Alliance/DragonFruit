'use client';

import React from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, Loader2 } from 'lucide-react';

type UvToolsLaunchingModalProps = {
  isOpen: boolean;
  filePath: string | null;
  /** Called after UVTools launch completes (success or failure). */
  onLaunchComplete: () => void;
};

/**
 * A non-dismissible modal shown while UVTools is being launched with the
 * sliced file. Displays an indeterminate progress bar and the target file path.
 * Cannot be closed via Escape, backdrop click, or any other interaction —
 * it auto-dismisses once UVTools reports completion via `onLaunchComplete`.
 */
export function UvToolsLaunchingModal({
  isOpen,
  filePath,
  onLaunchComplete,
}: UvToolsLaunchingModalProps) {
  // Trap focus inside the modal while open (prevent accidental Escape)
  React.useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    // Use capture phase to intercept Escape before anything else
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [isOpen]);

  if (!isOpen || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[150] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3"
      role="dialog"
      aria-modal="true"
      aria-label="Opening in UVTools"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-xl border shadow-2xl"
        style={{
          background: 'var(--surface-0)',
          borderColor: 'var(--border-subtle)',
          boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
        }}
      >
        <div className="flex items-center gap-2.5 border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
          <span
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'color-mix(in srgb, var(--accent), var(--surface-1) 90%)',
              color: 'var(--accent)',
            }}
          >
            <ExternalLink className="h-4 w-4" />
          </span>
          <div>
            <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              External Tool
            </div>
            <h2 className="text-base font-semibold" style={{ color: 'var(--text-strong)' }}>
              Opening in UVTools
            </h2>
          </div>
        </div>

        <div className="p-4 space-y-3">
          {/* Smooth indeterminate progress bar (same as upload dialog) */}
          <div
            className="ui-loading-track h-2 w-full rounded-full"
            style={{ background: 'color-mix(in srgb, var(--surface-2), black 20%)' }}
          >
            <div
              className="ui-loading-indicator"
              style={{ background: 'var(--accent)' }}
            />
          </div>

          <p className="text-xs text-center" style={{ color: 'var(--text-muted)' }}>
            Launching UVTools to inspect the sliced file&hellip;
          </p>

          {filePath && (
            <div
              className="rounded-md border p-2.5"
              style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
            >
              <div className="text-[11px] uppercase tracking-wide mb-1" style={{ color: 'var(--text-muted)' }}>
                File
              </div>
              <div
                className="text-xs font-mono break-all"
                style={{ color: 'var(--text-strong)' }}
                title={filePath}
              >
                {filePath}
              </div>
            </div>
          )}

          <div className="flex items-center justify-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span>Please wait&hellip;</span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
