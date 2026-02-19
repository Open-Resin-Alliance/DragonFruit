import React from 'react';
import { cn } from './cn';

type ButtonVariant = 'primary' | 'secondary' | 'accent' | 'danger';
type ButtonSize = 'sm' | 'md';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const variantClassMap: Record<ButtonVariant, string> = {
  primary: 'ui-button-primary',
  secondary: 'ui-button-secondary',
  accent: 'ui-button-accent',
  danger: 'border-red-500/30 bg-red-600/85 text-red-50 hover:bg-red-600',
};

const sizeClassMap: Record<ButtonSize, string> = {
  sm: 'px-3 py-2 text-sm',
  md: 'px-3.5 py-2.5 text-sm',
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
