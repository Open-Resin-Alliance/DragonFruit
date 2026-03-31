import React from 'react';
import { cn } from './cn';
import { SelectDropdown } from '@/components/ui/SelectDropdown';

function extractOptionLabel(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractOptionLabel).join('').trim();
  if (React.isValidElement(node)) return extractOptionLabel(node.props.children);
  return '';
}

function collectOptions(
  children: React.ReactNode,
  target: Array<{ value: string; label: string; disabled?: boolean }>,
) {
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;

    if (child.type === React.Fragment) {
      collectOptions(child.props.children, target);
      return;
    }

    if (typeof child.type === 'string' && child.type.toLowerCase() === 'optgroup') {
      collectOptions(child.props.children, target);
      return;
    }

    if (typeof child.type === 'string' && child.type.toLowerCase() === 'option') {
      const optionProps = child.props as React.OptionHTMLAttributes<HTMLOptionElement>;
      const fallbackLabel = extractOptionLabel(optionProps.children);
      const nextValue = optionProps.value != null ? String(optionProps.value) : fallbackLabel;

      target.push({
        value: nextValue,
        label: fallbackLabel || nextValue,
        disabled: optionProps.disabled,
      });
    }
  });
}

type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

export function Select({ className, children, value, defaultValue, onChange, onFocus, onBlur, style, id, title, disabled, ...rest }: SelectProps) {
  const options = React.useMemo(() => {
    const parsed: Array<{ value: string; label: string; disabled?: boolean }> = [];
    collectOptions(children, parsed);
    return parsed;
  }, [children]);

  const isControlled = value !== undefined;

  const [internalValue, setInternalValue] = React.useState<string>(() => {
    if (value != null) return String(value);
    if (defaultValue != null) return String(defaultValue);
    return options.find((option) => !option.disabled)?.value ?? '';
  });

  React.useEffect(() => {
    if (isControlled) return;
    if (defaultValue != null) {
      setInternalValue(String(defaultValue));
      return;
    }
    if (!options.some((option) => option.value === internalValue)) {
      setInternalValue(options.find((option) => !option.disabled)?.value ?? '');
    }
  }, [defaultValue, internalValue, isControlled, options]);

  const resolvedValue = isControlled
    ? String(value ?? '')
    : internalValue;

  const ariaLabel = (rest as { 'aria-label'?: string })['aria-label'];

  return (
    <SelectDropdown
      id={id}
      title={title}
      ariaLabel={ariaLabel}
      value={resolvedValue}
      options={options}
      disabled={disabled}
      onChange={(nextValue) => {
        if (!isControlled) {
          setInternalValue(String(nextValue));
        }

        if (!onChange) return;

        const syntheticEvent = {
          target: { value: String(nextValue) },
          currentTarget: { value: String(nextValue) },
        } as React.ChangeEvent<HTMLSelectElement>;

        onChange(syntheticEvent);
      }}
      selectClassName={cn('ui-select', className)}
      selectStyle={style}
      onFocus={(event) => onFocus?.(event as React.FocusEvent<HTMLSelectElement>)}
      onBlur={(event) => onBlur?.(event as React.FocusEvent<HTMLSelectElement>)}
    />
  );
}
