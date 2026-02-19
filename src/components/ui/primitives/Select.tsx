import React from 'react';
import { cn } from './cn';

export function Select({ className, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn('ui-select', className)} {...props}>
      {children}
    </select>
  );
}
