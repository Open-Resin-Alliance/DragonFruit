import React from 'react';
import { Loader2, type LucideIcon } from 'lucide-react';
import { cn } from './cn';

type SpinnerSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

interface SpinnerProps extends Omit<React.SVGAttributes<SVGSVGElement>, 'ref'> {
  size?: SpinnerSize;
  /** Accessible name. Omit inside a labelled busy surface. */
  label?: string;
  /**
   * The glyph to spin. Defaults to `Loader2`; pass `RefreshCw` where the call
   * site's own affordance was a refresh, so the icon keeps its identity.
   */
  icon?: LucideIcon;
}

const sizeClassMap: Record<SpinnerSize, string> = {
  xs: 'h-3 w-3',
  sm: 'h-3.5 w-3.5',
  md: 'h-4 w-4',
  lg: 'h-5 w-5',
  xl: 'h-6 w-6',
};

/**
 * The app's busy glyph. One definition for size, animation and naming.
 *
 * The glyph turns inside its own SVG (SMIL) rather than with `animate-spin`. Under the
 * fractional webview zoom of the UI scale, the compositor rotates a CSS-spun layer about
 * a point that is off the glyph's centre, and the spinner wobbles.
 */
export function Spinner({ size = 'sm', label, icon: Icon = Loader2, className, ...props }: SpinnerProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn('shrink-0', sizeClassMap[size], className)}
      aria-label={label}
      role={label ? 'status' : undefined}
      aria-hidden={label ? undefined : true}
      {...props}
    >
      <g>
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 12 12"
          to="360 12 12"
          dur="1s"
          repeatCount="indefinite"
        />
        <Icon width={24} height={24} aria-hidden />
      </g>
    </svg>
  );
}
