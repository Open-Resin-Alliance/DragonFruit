import React from 'react';
import { cn } from './cn';

type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'accent'
  | 'danger'
  | 'tinted-accent'
  | 'tinted-danger'
  | 'tinted-warning'
  | 'tinted-success';

/**
 * `md` is the app's default action shape (the one hand-written as `!h-9 px-3 text-xs`).
 * `auto` emits no geometry at all, for a call site that still carries its own
 * height/padding classes; the variant is the part that gets unified today.
 */
type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'auto';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const variantClassMap: Record<ButtonVariant, string> = {
  primary: 'ui-button-primary',
  secondary: 'ui-button-secondary',
  accent: 'ui-button-accent',
  danger: 'ui-button-danger',
  'tinted-accent': 'ui-button-tint ui-button-tint-accent',
  'tinted-danger': 'ui-button-tint ui-button-tint-danger',
  'tinted-warning': 'ui-button-tint ui-button-tint-warning',
  'tinted-success': 'ui-button-tint ui-button-tint-success',
};

const sizeClassMap: Record<ButtonSize, string> = {
  xs: '!h-7 px-2 text-[11px]',
  sm: '!h-8 px-2.5 text-[11px]',
  md: '!h-9 px-3 text-xs',
  lg: 'h-10 px-4 text-sm',
  auto: '',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn('ui-button', variantClassMap[variant], sizeClassMap[size], className)}
      {...props}
    />
  );
}
