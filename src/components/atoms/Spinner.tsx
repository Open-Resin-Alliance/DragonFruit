import React from 'react';
import { Loader2, type LucideIcon } from 'lucide-react';
import { cn } from './cn';

type SpinnerSize = 'xs' | 'sm' | 'md' | 'lg';

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
};

/** The app's busy glyph. One definition for size, animation and naming. */
export function Spinner({ size = 'sm', label, icon: Icon = Loader2, className, ...props }: SpinnerProps) {
  return (
    <Icon
      className={cn('animate-spin', sizeClassMap[size], className)}
      aria-label={label}
      role={label ? 'status' : undefined}
      aria-hidden={label ? undefined : true}
      {...props}
    />
  );
}
