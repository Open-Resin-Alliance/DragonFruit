import React from 'react';
import { cn } from './cn';

type ProgressBarSize = 'xs' | 'sm' | 'md';

interface ProgressBarProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  /** 0 to 100. `null` means the value is not known yet (no announcement). Ignored while `indeterminate`. */
  value?: number | null;
  size?: ProgressBarSize;
  /** Sweeping loop instead of a measured fill. */
  indeterminate?: boolean;
  ariaLabel?: string;
}

const trackSizeClassMap: Record<ProgressBarSize, string> = {
  xs: 'h-1.5',
  sm: 'h-2',
  md: 'h-2.5',
};

/**
 * The determinate accent bar the app uses for long operations (scan, slice,
 * export, import). `theme` is a CSS background for the fill, so callers that
 * need a different gradient pass one instead of re-typing the track.
 */
export function ProgressBar({
  value = 0,
  size = 'md',
  indeterminate = false,
  ariaLabel,
  className,
  style,
  ...props
}: ProgressBarProps) {
  const percent = value === null ? 0 : Math.min(100, Math.max(0, value));
  return (
    <div
      className={cn(
        'w-full overflow-hidden rounded-full',
        trackSizeClassMap[size],
        indeterminate && 'ui-loading-track',
        className
      )}
      style={{ background: 'color-mix(in srgb, var(--surface-2), black 20%)', ...style }}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate || value === null ? undefined : Math.round(percent)}
      aria-label={ariaLabel}
      {...props}
    >
      {indeterminate ? (
        <div className="ui-loading-indicator" style={{ background: 'linear-gradient(90deg, var(--accent), #ff79c6)' }} />
      ) : (
        <div
          className="h-full rounded-full transition-[width] duration-200"
          style={{ width: `${percent}%`, background: 'linear-gradient(90deg, var(--accent), #ff79c6)' }}
        />
      )}
    </div>
  );
}
