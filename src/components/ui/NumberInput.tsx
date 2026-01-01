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
      setDisplayValue(safeValue.toString());
    }
  }, [safeValue]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVal = e.target.value;
    setDisplayValue(newVal);

    // Only push to parent if it's a valid number
    // We allow empty string locally, but don't push it
    if (newVal === '' || newVal === '-') {
        return;
    }

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
        setDisplayValue(safeValue.toString());
    } else {
        // Ensure standard formatting (e.g. remove trailing decimal points)
        // But also respect the parent's update which triggers the Effect.
        // However, if parent value didn't change (e.g. parsed same as value), Effect won't run.
        // So force a sync.
        setDisplayValue(safeValue.toString());
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
