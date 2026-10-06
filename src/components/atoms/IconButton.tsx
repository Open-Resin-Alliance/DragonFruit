import React from 'react';
import { cn } from './cn';
import { ICON_TONE_STYLES, type IconTone } from './iconTone';

type IconButtonVariant = 'solid' | 'surface' | 'ghost';
type IconButtonSize = 'xs' | 'sm' | 'md' | 'lg';

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Filled accent state, for a toggle that is on. */
  active?: boolean;
  /**
   * `solid` is the `ui-button` tile; `surface` the bordered tile a panel or modal
   * uses for its close / header actions; `ghost` a bare hit target that only
   * shows a surface on hover.
   */
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  /** Only read by `surface` (and by `ghost` on hover). */
  tone?: IconTone;
}

const sizeClassMap: Record<IconButtonSize, string> = {
  xs: 'h-6 w-6',
  sm: 'h-8 w-8',
  md: 'h-9 w-9',
  lg: 'h-10 w-10',
};

const ghostSizeClassMap: Record<IconButtonSize, string> = {
  xs: '!p-0.5',
  sm: '!p-1',
  md: '!p-1.5',
  lg: '!p-2',
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
          sizeClassMap[size],
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
      className={cn('ui-button !p-2', size !== 'md' && sizeClassMap[size], active ? 'ui-button-primary' : 'ui-button-secondary', className)}
      style={style}
      {...props}
    />
  );
}
