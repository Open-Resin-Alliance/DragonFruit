import React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from './cn';

type SpinnerSize = 'xs' | 'sm' | 'md' | 'lg';

interface SpinnerProps extends React.HTMLAttributes<SVGSVGElement> {
  size?: SpinnerSize;
  /** Accessible name. Omit inside a labelled busy surface. */
  label?: string;
}

const sizeClassMap: Record<SpinnerSize, string> = {
  xs: 'h-3 w-3',
  sm: 'h-3.5 w-3.5',
  md: 'h-4 w-4',
  lg: 'h-5 w-5',
};

/** The app's busy glyph. One definition for the `animate-spin` sites. */
export function Spinner({ size = 'sm', label, className, ...props }: SpinnerProps) {
  return (
    <Loader2
      className={cn('animate-spin', sizeClassMap[size], className)}
      aria-label={label}
      role={label ? 'status' : undefined}
      aria-hidden={label ? undefined : true}
      {...props}
    />
  );
}
