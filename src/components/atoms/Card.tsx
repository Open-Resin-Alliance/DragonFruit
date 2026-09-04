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
}

export function CardHeader({ className, left, right }: CardHeaderProps) {
  return (
    <div
      data-panel-drag-handle="true"
      className={cn(
        'relative px-2.5 py-2.5 flex items-center',
        className,
      )}
    >
      <div className="flex items-center gap-2.5 pr-8">{left}</div>
      {right ? (
        <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center">
          {right}
        </div>
      ) : null}
    </div>
  );
}
