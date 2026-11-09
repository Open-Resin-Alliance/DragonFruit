import React from 'react';
import { cn } from './cn';
import { ICON_TONE_STYLES, type IconTone } from './iconTone';

type IconButtonVariant = 'solid' | 'surface' | 'ghost';
/**
 * `auto` emits no geometry for a call site that still carries its own box.
 */
type IconButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'auto';

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Filled accent state, for a toggle that is on. */
  active?: boolean;
  /**
   * `solid` is the `ui-button` tile (the default, and what the app's small
   * square buttons were); `surface` the bordered surface tile a modal or panel
   * uses; `ghost` a bare hit target that shows a surface on hover.
   */
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  /** Only read by `surface`. */
  tone?: IconTone;
}

/** Padding is owned by the size so a caller's `!p-*` never has to fight it. */
const solidSizeClassMap: Record<IconButtonSize, string> = {
  xs: '!p-1',
  sm: 'h-8 w-8 !p-0',
  md: '!p-2',
  lg: 'h-10 w-10 !p-0',
  auto: '',
};

const boxSizeClassMap: Record<IconButtonSize, string> = {
  xs: 'h-6 w-6',
  sm: 'h-8 w-8',
  md: 'h-9 w-9',
  lg: 'h-10 w-10',
  auto: '',
};

const ghostSizeClassMap: Record<IconButtonSize, string> = {
  xs: '!p-0.5',
  sm: '!p-1',
  md: '!p-1.5',
  lg: '!p-2',
  auto: '',
};

export function IconButton({
  active = false,
  variant = 'solid',
  size = 'md',
  tone = 'neutral',
  className,
  style,
  type = 'button',
  ...props
}: IconButtonProps) {
  if (variant === 'ghost') {
    return (
      <button
        type={type}
        className={cn(
          'inline-flex items-center justify-center rounded transition-colors hover:bg-white/10',
          ghostSizeClassMap[size],
          className
        )}
        style={{ color: 'var(--text-muted)', ...style }}
        {...props}
      />
    );
  }

  if (variant === 'surface') {
    return (
      <button
        type={type}
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-md border transition-colors',
          boxSizeClassMap[size],
          className
        )}
        style={{
          ...(active ? { ...ICON_TONE_STYLES.accent, color: 'var(--accent-secondary)' } : ICON_TONE_STYLES[tone]),
          ...style,
        }}
        {...props}
      />
    );
  }

  return (
    <button
      type={type}
      className={cn('ui-button', solidSizeClassMap[size], active ? 'ui-button-primary' : 'ui-button-secondary', className)}
      style={style}
      {...props}
    />
  );
}
