import React from 'react';
import { cn } from './cn';

type ToggleSize = 'sm' | 'md';

interface ToggleProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'children'> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  size?: ToggleSize;
  /** Accessible name. Required when the toggle has no visible label beside it. */
  label?: string;
}

const trackClassMap: Record<ToggleSize, string> = {
  sm: 'h-5 w-9 px-0.5',
  md: 'h-6 w-10 px-0.5',
};

const knobClassMap: Record<ToggleSize, string> = {
  sm: 'h-4 w-4',
  md: 'h-5 w-5',
};

const knobOffsetClassMap: Record<ToggleSize, string> = {
  sm: 'translate-x-4',
  md: 'translate-x-4',
};

/**
 * The pill switch. Two geometries were hand-rolled before this (`w-9 h-5` and
 * `w-10 h-6`) and only one of the copies was reachable as a switch, so the
 * `role` and `aria-checked` live here rather than at each call site.
 */
export function Toggle({
  checked,
  onChange,
  size = 'md',
  label,
  className,
  type = 'button',
  ...props
}: ToggleProps) {
  return (
    <button
      type={type}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        'flex shrink-0 items-center rounded-full transition-colors',
        trackClassMap[size],
        className
      )}
      style={{ background: checked ? 'var(--accent)' : 'var(--surface-2)' }}
      {...props}
    >
      <span
        className={cn(
          'rounded-full bg-white shadow transition-transform',
          knobClassMap[size],
          checked ? knobOffsetClassMap[size] : 'translate-x-0'
        )}
      />
    </button>
  );
}
