import React, { useState, useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { wheelStepDirection } from '@/components/ui/wheelStepDirection';
import { useLocaleFormat } from '@/hooks/useLocaleFormat';
import { clamp } from '@/utils/math';

interface NumberInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  value: number;
  onChange: (value: number) => void;
  showStepper?: boolean;
}

/**
 * What typing may leave in the field: a minus unless `minBound` rules one out, up to two
 * decimals after the locale's separator or a ".", and the steps on the way there ('-', ',', '-,').
 */
function inputPattern(decimalSeparator: string, minBound: number | null): RegExp {
  const separators = decimalSeparator === '.' ? '\\.' : `\\.${decimalSeparator}`;
  // A field whose minimum is 0 or more has no legal negative state, so the minus key never
  // starts one there (the store clamps too, for non-typed writes).
  const sign = minBound != null && minBound >= 0 ? '' : '-?';
  return new RegExp(`^${sign}(?:\\d+)?(?:[${separators}]\\d{0,2})?$`);
}

function parseNumericBound(bound: string | number | undefined): number | null {
  if (typeof bound === 'number' && Number.isFinite(bound)) return bound;
  if (typeof bound === 'string') {
    const parsed = Number(bound);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function countStepDecimals(step: number): number {
  if (!Number.isFinite(step)) return 0;
  const asString = step.toString();
  if (asString.includes('e-')) {
    const exponent = Number(asString.split('e-')[1] ?? '0');
    return Number.isFinite(exponent) ? exponent : 0;
  }
  const decimal = asString.split('.')[1];
  return decimal ? decimal.length : 0;
}

export function NumberInput({ value, onChange, className, onBlur, showStepper = true, ...props }: NumberInputProps) {
  const { _ } = useLingui();
  const fmt = useLocaleFormat();
  const safeValue = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  const formatValue = React.useCallback((n: number) => fmt.field(n, 2), [fmt]);
  const minBound = parseNumericBound(props.min);
  const maxBound = parseNumericBound(props.max);
  const stepSize = (() => {
    const raw = typeof props.step === 'number' ? props.step : Number(props.step);
    return Number.isFinite(raw) && raw > 0 ? raw : 1;
  })();
  const stepPrecision = Math.min(6, countStepDecimals(stepSize));

  // Current string in the input
  const [displayValue, setDisplayValue] = useState(formatValue(safeValue));
  const isEditing = useRef(false);

  // Sync with external value changes when not editing
  useEffect(() => {
    if (!isEditing.current) {
      const next = formatValue(safeValue);
      setDisplayValue((prev) => (prev === next ? prev : next));
    }
  }, [formatValue, safeValue]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVal = e.target.value;

    if (!inputPattern(fmt.decimalSeparator, minBound).test(newVal)) {
      return;
    }

    setDisplayValue(newVal);

    const parsed = fmt.parse(newVal);
    if (Number.isFinite(parsed)) {
      onChange(parsed);
    }
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    isEditing.current = false;

    // Always snap back to the latest committed prop value on blur.
    // This avoids stale UI when an attempted edit is rejected upstream
    // (e.g. destructive-transform modal canceled).
    setDisplayValue(formatValue(safeValue));

    if (onBlur) onBlur(e);
  };

  const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    isEditing.current = true;
    if (props.onFocus) props.onFocus(e);
  };

  const applyStepDelta = React.useCallback((direction: 1 | -1) => {
    const parsedCurrent = fmt.parse(displayValue);
    const currentValue = Number.isFinite(parsedCurrent) ? parsedCurrent : safeValue;
    let next = currentValue + (stepSize * direction);

    next = clamp(
      next,
      minBound ?? Number.NEGATIVE_INFINITY,
      maxBound ?? Number.POSITIVE_INFINITY,
    );

    const normalized = Number(next.toFixed(stepPrecision));
    setDisplayValue(formatValue(normalized));
    onChange(normalized);
  }, [displayValue, fmt, formatValue, maxBound, minBound, onChange, safeValue, stepPrecision, stepSize]);

  const handleWheel = (e: React.WheelEvent<HTMLInputElement>) => {
    if (props.onWheel) props.onWheel(e);
    if (e.defaultPrevented) return;
    if (props.disabled || props.readOnly) return;

    // Dominant axis, not deltaY: Shift+wheel arrives as horizontal scroll, and
    // Shift is what ScrollLockedInputs requires to step an unfocused field.
    const direction = wheelStepDirection(e);
    if (direction === 0) return;

    e.preventDefault();
    applyStepDelta(direction);
  };

  const parsedCurrent = fmt.parse(displayValue);
  const currentValue = Number.isFinite(parsedCurrent) ? parsedCurrent : safeValue;
  const disableIncrement = props.disabled || (maxBound != null && currentValue >= maxBound);
  const disableDecrement = props.disabled || (minBound != null && currentValue <= minBound);

  if (!showStepper) {
    return (
      <input
        {...props}
        type="text"
        inputMode="decimal"
        value={displayValue}
        onChange={handleChange}
        onBlur={handleBlur}
        onFocus={handleFocus}
        onWheel={handleWheel}
        className={className}
      />
    );
  }

  return (
    <div className="relative min-w-0">
      <input
        {...props}
        type="text" // Use text to allow full control over input (like '0,', '', '-')
        inputMode="decimal"
        value={displayValue}
        onChange={handleChange}
        onBlur={handleBlur}
        onFocus={handleFocus}
        onWheel={handleWheel}
        className={className}
      />

      {showStepper && (
        <div className="absolute inset-y-0 right-0.5 flex w-4 flex-col items-center justify-center gap-0.5">
          <button
            type="button"
            className="inline-flex h-3 w-3 items-center justify-center rounded hover:bg-white/10 disabled:opacity-50"
            onClick={() => applyStepDelta(1)}
            disabled={Boolean(disableIncrement)}
            tabIndex={-1}
            aria-label={_(msg`Increase value`)}
          >
            <ChevronUp className="h-2.5 w-2.5" />
          </button>
          <button
            type="button"
            className="inline-flex h-3 w-3 items-center justify-center rounded hover:bg-white/10 disabled:opacity-50"
            onClick={() => applyStepDelta(-1)}
            disabled={Boolean(disableDecrement)}
            tabIndex={-1}
            aria-label={_(msg`Decrease value`)}
          >
            <ChevronDown className="h-2.5 w-2.5" />
          </button>
        </div>
      )}
    </div>
  );
}
