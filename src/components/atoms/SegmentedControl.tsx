import React from 'react';
import { cn } from './cn';

export type SegmentedOption<T extends string> = {
  value: T;
  label: React.ReactNode;
  title?: string;
  disabled?: boolean;
};

type SegmentedSize = 'sm' | 'md';

interface SegmentedControlProps<T extends string> {
  options: Array<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  /** Accessible name for the group. */
  label: string;
  size?: SegmentedSize;
  /** Active tint. `accent-secondary` is what the sidebar tab strips use. */
  tone?: 'accent' | 'accent-secondary';
  className?: string;
  fullWidth?: boolean;
}

const optionSizeClassMap: Record<SegmentedSize, string> = {
  sm: 'h-7 px-2.5 text-xs',
  md: 'h-10 min-w-[92px] px-3 text-[12px]',
};

/**
 * A row of mutually exclusive pills: ON/OFF switches, tab strips and 2 to 4 way
 * pickers. Around 50 call sites hand-wrote this before, most of them repeating
 * the same four-line active style block.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  size = 'md',
  tone = 'accent',
  className,
  fullWidth = false,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn('inline-flex items-center gap-1', fullWidth && 'w-full', className)}
      style={{ '--segmented-tone': tone === 'accent' ? 'var(--accent)' : 'var(--accent-secondary)' } as React.CSSProperties}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            disabled={option.disabled}
            title={option.title}
            onClick={() => onChange(option.value)}
            className={cn(
              'ui-segmented-option inline-flex items-center justify-center rounded-sm border font-semibold uppercase tracking-wide transition-colors',
              optionSizeClassMap[size],
              fullWidth && 'flex-1'
            )}
            data-active={active ? 'true' : undefined}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
