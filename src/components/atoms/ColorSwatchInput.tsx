import React from 'react';
import { cn } from './cn';

type ColorSwatchInputProps = {
  value: string;
  onChange: (value: string) => void;
  /** Called when the picker loses focus, for callers that only commit on close. */
  onBlur?: () => void;
  className?: string;
  title?: string;
  ariaLabel?: string;
};

/**
 * A colour picker's swatch, filling its box.
 *
 * The native `input[type=color]` draws its own swatch inside a padded, bordered
 * wrapper, which reads as a box inside our rounded border. Every appearance
 * override here exists to flatten that: no UA appearance, no padding, no inner
 * swatch border. Size comes from the caller, since the settings rows and the
 * overlay panels use different ones.
 */
export function ColorSwatchInput({ value, onChange, onBlur, className, title, ariaLabel }: ColorSwatchInputProps) {
  return (
    <input
      type="color"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onBlur={onBlur}
      title={title}
      aria-label={ariaLabel}
      className={cn(
        'shrink-0 cursor-pointer appearance-none overflow-hidden rounded border p-0',
        '[&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0 [&::-moz-color-swatch]:border-0',
        className,
      )}
      style={{ borderColor: 'var(--border-subtle)' }}
    />
  );
}
