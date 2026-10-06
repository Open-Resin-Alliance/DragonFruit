import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from './cn';
import { ICON_TONE_STYLES, type IconTone } from './iconTone';

type IconChipSize = 'xs' | 'sm' | 'md' | 'lg';

interface IconChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Shown only when no children are passed. */
  icon?: LucideIcon;
  iconClassName?: string;
  size?: IconChipSize;
  tone?: IconTone;
}

const sizeClassMap: Record<IconChipSize, string> = {
  /** The 16px badge inside a menu or list row. */
  xs: 'h-4 w-4 rounded-[3px] text-[10px] font-bold leading-none',
  /** The 20px icon slot of a menu or list row. */
  sm: 'h-5 w-5 rounded',
  /** A toolbar or section tile. */
  md: 'h-8 w-8 rounded-md',
  /** A modal header tile. */
  lg: 'h-9 w-9 rounded-md',
};

const iconSizeClassMap: Record<IconChipSize, string> = {
  xs: '',
  sm: 'h-3.5 w-3.5',
  md: 'h-4 w-4',
  lg: 'h-4 w-4',
};

/**
 * The bordered square an icon lives in: menu-row slots, modal header tiles and
 * status badges. `children` replaces the icon (a tick, a number, a glyph).
 */
export function IconChip({
  icon: Icon,
  iconClassName,
  size = 'sm',
  tone = 'neutral',
  className,
  children,
  style,
  ...props
}: IconChipProps) {
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center border', sizeClassMap[size], className)}
      style={{ ...ICON_TONE_STYLES[tone], ...style }}
      {...props}
    >
      {children ?? (Icon ? <Icon className={cn(iconSizeClassMap[size], iconClassName)} /> : null)}
    </span>
  );
}
