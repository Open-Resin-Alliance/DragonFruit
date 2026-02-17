import React, { useState, useEffect, useRef } from 'react';

interface NumberInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  value: number;
  onChange: (value: number) => void;
}

export function NumberInput({ value, onChange, className, onBlur, ...props }: NumberInputProps) {
  const safeValue = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  // Current string in the input
  const [displayValue, setDisplayValue] = useState(safeValue.toString());
  const isEditing = useRef(false);

  // Sync with external value changes when not editing
  useEffect(() => {
    if (!isEditing.current) {
      // Handle floating point precision display if needed, 
      // but generally toString() is fine for sync
      setDisplayValue(Number(safeValue.toFixed(2)).toString());
    }
  }, [safeValue]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVal = e.target.value;

    // Allow empty, minus, or valid float
    if (newVal === '' || newVal === '-') {
      setDisplayValue(newVal);
      return;
    }

    // Check decimal places
    const parts = newVal.split('.');
    if (parts[1] && parts[1].length > 2) {
      return; // Reject modification if more than 2 decimals
    }

    setDisplayValue(newVal);

    const parsed = parseFloat(newVal);
    if (!isNaN(parsed)) {
      onChange(parsed);
    }
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    isEditing.current = false;

    // Check if current display value is empty or invalid
    const parsed = parseFloat(displayValue);

    if (displayValue === '' || isNaN(parsed)) {
      // Restore previous valid value
      setDisplayValue(Number(safeValue.toFixed(2)).toString());
    } else {
      // Ensure standard formatting (e.g. remove trailing decimal points)
      // But also respect the parent's update which triggers the Effect.
      // However, if parent value didn't change (e.g. parsed same as value), Effect won't run.
      // So force a sync.
      setDisplayValue(Number(parsed.toFixed(2)).toString());
    }

    if (onBlur) onBlur(e);
  };

  const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    isEditing.current = true;
    if (props.onFocus) props.onFocus(e);
  };

  return (
    <input
      {...props}
      type="text" // Use text to allow full control over input (like '0.', '', '-')
      value={displayValue}
      onChange={handleChange}
      onBlur={handleBlur}
      onFocus={handleFocus}
      className={className}
    />
  );
}
