import React from 'react';
import { ProgressBar } from './ProgressBar';

interface BlockingOverlayProps {
  title: React.ReactNode;
  /** Body lines under the title. */
  details?: React.ReactNode[];
  /** Highlighted second line, e.g. an elapsed time. */
  elapsed?: React.ReactNode;
  /** Dimmed footnote, e.g. "Processing 1 model". */
  footnote?: React.ReactNode;
  /** 0 to 100, or `null` for an indeterminate sweep. Omit to hide the built-in bar. */
  progress?: number | null;
  progressLabel?: string;
  /**
   * Rendered under the built-in bar. Use it for a caller's own progress display
   * (a phase label with done/total, for example) instead of forcing a percent.
   */
  children?: React.ReactNode;
  /** Stacking class. The copies this replaces ranged from `z-[120]` to `z-[123]`. */
  zIndexClassName?: string;
  /** Panel width. Defaults to the 520px sheet most copies used. */
  widthClassName?: string;
  /** Backdrop tint. Defaults to `bg-black/45 backdrop-blur-[1px]`. */
  backdropClassName?: string;
  position?: 'absolute' | 'fixed';
  className?: string;
}

/**
 * The non-dismissible busy sheet: dim backdrop, one panel, no close affordance.
 *
 * `StructuredDialogModal` is the wrong shell for this (it is dismissible and it
 * makes the caller supply a title, icon and close button). Seven copies of this
 * shape existed, each with its own width, backdrop opacity and z-index.
 *
 * The copies announced themselves with `role="dialog"` and `aria-modal="true"`
 * while refusing every interaction; this is a status surface, so it uses
 * `role="status"` with `aria-busy`.
 */
export function BlockingOverlay({
  title,
  details,
  elapsed,
  footnote,
  progress,
  progressLabel,
  children,
  zIndexClassName = 'z-[120]',
  widthClassName = 'w-[min(520px,92vw)]',
  backdropClassName = 'bg-black/45 backdrop-blur-[1px]',
  position = 'absolute',
  className,
}: BlockingOverlayProps) {
  return (
    <div className={`${position} inset-0 ${zIndexClassName} flex items-center justify-center ${backdropClassName}`}>
      <div
        className={`${widthClassName} rounded-xl border px-5 py-4 shadow-xl ${className ?? ''}`}
        style={{ background: 'color-mix(in srgb, var(--surface-0), black 10%)', borderColor: 'var(--border-subtle)' }}
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
          {title}
        </div>
        {details && details.length > 0 ? (
          <div className="mt-1 space-y-0.5 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {details.map((line, index) => (
              <p key={index}>{line}</p>
            ))}
          </div>
        ) : null}
        {elapsed ? (
          <div className="mt-2 text-[11px] font-medium tracking-wide" style={{ color: 'var(--accent)' }}>
            {elapsed}
          </div>
        ) : null}
        {footnote ? (
          <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {footnote}
          </div>
        ) : null}
        {progress !== undefined ? (
          <div className="mt-3">
            <ProgressBar value={progress ?? 0} indeterminate={progress === null} ariaLabel={progressLabel} />
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}
