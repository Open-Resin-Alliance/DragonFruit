import React from 'react';
import { cn } from './cn';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export function Card({ className, children, style }: CardProps) {
  return (
    <div className={cn('ui-panel rounded-lg shadow-lg border', className)} style={{ borderColor: 'var(--border-subtle)', ...style }}>
      {children}
    </div>
  );
}

interface CardHeaderProps {
  className?: string;
  left: React.ReactNode;
  right?: React.ReactNode;
  hideDivider?: boolean;
}

export function CardHeader({ className, left, right, hideDivider = false }: CardHeaderProps) {
  return (
    <div
      className={cn(
        'px-2.5 py-2.5 flex items-center justify-between',
        className,
      )}
    >
      <div className="flex items-center gap-2.5">{left}</div>
      {right ? <div>{right}</div> : null}
    </div>
  );
}
