import React from 'react';
import { NumberInput } from '@/components/ui/NumberInput';
import { wheelStepDirection } from '@/components/ui/wheelStepDirection';

interface MiniStepperFieldProps {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  disabled?: boolean;
  ariaLabel?: string;
}

/**
 * A compact integer field with small chevron steppers — the Arrange panel's
 * Manual-mode input for Count/Gap-style rows. Integer-clamped and wheel-scrolls
 * to step — off the dominant axis, since Shift+wheel comes in horizontally —
 * with the same dark `--surface-0` background as the other number fields.
 * Shared by the Arrange and Duplicate panels' array grids.
 */
export function MiniStepperField({
  value,
  onChange,
  min,
  max,
  disabled = false,
  ariaLabel,
}: MiniStepperFieldProps) {
  const safe = Number.isFinite(value) ? value : min;
  const clamped = Math.min(max, Math.max(min, Math.round(safe)));

  const apply = React.useCallback((next: number) => {
    const normalized = Math.min(max, Math.max(min, Math.round(Number.isFinite(next) ? next : min)));
    onChange(normalized);
  }, [max, min, onChange]);

  return (
    <div className="min-w-0" onWheel={(e) => {
      if (disabled) return;
      const direction = wheelStepDirection(e);
      if (direction === 0) return;
      e.preventDefault();
      apply(clamped + direction);
    }}>
      <NumberInput
        value={clamped}
        onChange={apply}
        min={min}
        max={max}
        step={1}
        disabled={disabled}
        aria-label={ariaLabel}
        className="ui-input h-8 w-full min-w-0 pl-1.5 pr-5 text-xs text-center no-spinners !bg-[var(--surface-0)]"
      />
    </div>
  );
}
