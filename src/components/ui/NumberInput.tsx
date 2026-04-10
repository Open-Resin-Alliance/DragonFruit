import React, { useState, useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

interface NumberInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  value: number;
  onChange: (value: number) => void;
  showStepper?: boolean;
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
  const safeValue = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  const formatValue = React.useCallback((n: number) => Number(n.toFixed(2)).toString(), []);
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

    // Allow optional leading minus, optional decimals, and up to 2 decimal places.
    // Also allows transitional editing states like '-', '.', and '-.'.
    const numericPattern = /^-?(?:\d+)?(?:\.\d{0,2})?$/;
    if (!numericPattern.test(newVal)) {
      return;
    }

    setDisplayValue(newVal);

    const parsed = Number.parseFloat(newVal);
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
    const parsedCurrent = Number.parseFloat(displayValue);
    const currentValue = Number.isFinite(parsedCurrent) ? parsedCurrent : safeValue;
    let next = currentValue + (stepSize * direction);

    if (minBound != null) next = Math.max(minBound, next);
    if (maxBound != null) next = Math.min(maxBound, next);

    const normalized = Number(next.toFixed(stepPrecision));
    setDisplayValue(formatValue(normalized));
    onChange(normalized);
  }, [displayValue, formatValue, maxBound, minBound, onChange, safeValue, stepPrecision, stepSize]);

  const handleWheel = (e: React.WheelEvent<HTMLInputElement>) => {
    if (props.onWheel) props.onWheel(e);
    if (e.defaultPrevented) return;
    if (props.disabled || props.readOnly) return;
    if (e.deltaY === 0) return;

    e.preventDefault();
    applyStepDelta(e.deltaY < 0 ? 1 : -1);
  };

  const parsedCurrent = Number.parseFloat(displayValue);
  const currentValue = Number.isFinite(parsedCurrent) ? parsedCurrent : safeValue;
  const disableIncrement = props.disabled || (maxBound != null && currentValue >= maxBound);
  const disableDecrement = props.disabled || (minBound != null && currentValue <= minBound);

  if (!showStepper) {
    return (
      <input
        {...props}
        type="text"
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
        type="text" // Use text to allow full control over input (like '0.', '', '-')
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
            aria-label="Increase value"
          >
            <ChevronUp className="h-2.5 w-2.5" />
          </button>
          <button
            type="button"
            className="inline-flex h-3 w-3 items-center justify-center rounded hover:bg-white/10 disabled:opacity-50"
            onClick={() => applyStepDelta(-1)}
            disabled={Boolean(disableDecrement)}
            tabIndex={-1}
            aria-label="Decrease value"
          >
            <ChevronDown className="h-2.5 w-2.5" />
          </button>
        </div>
      )}
    </div>
  );
}
