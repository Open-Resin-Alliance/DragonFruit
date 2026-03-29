import React from 'react';
import { ChevronDown } from 'lucide-react';

export type SelectDropdownProps<T extends string | number = string> = {
  label?: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
  selectClassName?: string;
  selectStyle?: React.CSSProperties;
  labelClassName?: string;
  labelStyle?: React.CSSProperties;
  endAdornment?: React.ReactNode;
  selectedDisplay?: React.ReactNode;
  hideSelectedText?: boolean;
  onFocus?: React.FocusEventHandler<HTMLSelectElement>;
  onBlur?: React.FocusEventHandler<HTMLSelectElement>;
};

/**
 * Generic reusable dropdown component with consistent styling.
 * Features a custom chevron icon and clean design.
 */
export function SelectDropdown<T extends string | number = string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  className = '',
  selectClassName = '',
  selectStyle,
  labelClassName = '',
  labelStyle,
  endAdornment,
  selectedDisplay,
  hideSelectedText = false,
  onFocus,
  onBlur,
}: SelectDropdownProps<T>) {
  const [isFocused, setIsFocused] = React.useState(false);

  return (
    <label className={`space-y-1 block ${className}`}>
      {label && (
        <span className={`ui-label font-medium inline-flex items-center ${labelClassName}`} style={labelStyle}>
          {label}
        </span>
      )}
      <div className="relative">
        <select
          value={value}
          onChange={(event) => onChange(event.target.value as T)}
          onFocus={(event) => {
            setIsFocused(true);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setIsFocused(false);
            onBlur?.(event);
          }}
          disabled={disabled}
          className={`ui-input w-full h-[36px] px-2.5 pr-10 leading-tight text-sm appearance-none disabled:opacity-55 disabled:cursor-not-allowed ${selectClassName}`}
          style={{
            ...selectStyle,
            ...((hideSelectedText && !isFocused)
              ? {
                  color: 'transparent',
                  caretColor: 'transparent',
                  WebkitTextFillColor: 'transparent',
                  textShadow: 'none',
                }
              : null),
          }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {selectedDisplay && hideSelectedText && !isFocused && (
          <span className="pointer-events-none absolute left-2.5 top-1/2 inline-flex -translate-y-1/2 items-center">
            {selectedDisplay}
          </span>
        )}
        {endAdornment && (
          <span className="pointer-events-none absolute right-8 top-1/2 inline-flex -translate-y-1/2 items-center justify-center">
            {endAdornment}
          </span>
        )}
        <ChevronDown
          className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 transition-colors"
          style={{ color: disabled ? 'var(--text-muted)' : 'var(--text-muted)' }}
        />
      </div>
    </label>
  );
}
