import React from 'react';
import { ChevronDown } from 'lucide-react';

export type SelectDropdownProps<T extends string | number = string> = {
  label?: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
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
}: SelectDropdownProps<T>) {
  return (
    <label className={`space-y-1 block ${className}`}>
      {label && <span className="ui-label font-medium inline-flex items-center">{label}</span>}
      <div className="relative">
        <select
          value={value}
          onChange={(event) => onChange(event.target.value as T)}
          disabled={disabled}
          className="ui-input w-full h-[36px] px-2.5 pr-10 leading-tight text-sm appearance-none disabled:opacity-55 disabled:cursor-not-allowed"
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown
          className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 transition-colors"
          style={{ color: disabled ? 'var(--text-muted)' : 'var(--text-muted)' }}
        />
      </div>
    </label>
  );
}
