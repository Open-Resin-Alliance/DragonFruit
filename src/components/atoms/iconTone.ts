import type React from 'react';

/**
 * The tones an icon slot can carry. One definition for every surface that shows
 * a toned icon: dialogs, chips, tiles and inline status rows.
 *
 * These were inline in `StructuredDialogModal` and re-typed by hand in ~35 files
 * (143 spans) before they moved here.
 */
export type IconTone = 'accent' | 'warning' | 'danger' | 'neutral';

export const ICON_TONE_STYLES: Record<IconTone, React.CSSProperties> = {
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
