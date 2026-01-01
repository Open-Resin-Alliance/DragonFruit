"use client";

import React from 'react';

export function Sidebar({
  children,
  widthClass = "w-64",
  side = 'left',
  fixed = true,
  className = '',
  contentClassName = ''
}: {
  children: React.ReactNode;
  widthClass?: string;
  side?: 'left' | 'right';
  fixed?: boolean;
  className?: string;
  contentClassName?: string;
}) {
  const positionClass = fixed ? 'fixed' : 'relative';
  const heightClass = fixed ? '' : 'h-full';
  const sideClass = side === 'left' ? 'left-0 border-r' : 'right-0 border-l';
  const style = fixed ? ({ top: '56px', bottom: 0 } as React.CSSProperties) : undefined;

  return (
    <div className={`${positionClass} ${heightClass} ${sideClass} ${widthClass} border-neutral-800 bg-neutral-900 z-20 ${className}`} style={style}>
      <div className={`h-full overflow-y-auto px-0 py-0 space-y-2 ${contentClassName}`}>
        {children}
      </div>
    </div>
  );
}
