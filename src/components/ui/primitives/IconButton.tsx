import React from 'react';
import { cn } from './cn';

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
}

export function IconButton({ active = false, className, type = 'button', ...props }: IconButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'ui-button !p-2',
        active ? 'ui-button-primary' : 'ui-button-secondary',
        className
      )}
      {...props}
    />
  );
}
