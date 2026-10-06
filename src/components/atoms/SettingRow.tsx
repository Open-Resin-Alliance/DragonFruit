import React from 'react';
import { cn } from './cn';

interface SettingRowProps extends Omit<React.HTMLAttributes<HTMLElement>, 'children'> {
  label: React.ReactNode;
  /** Secondary line under the label. Always visible. */
  description?: React.ReactNode;
  /**
   * `compact` (the default) tightens the line-heights and the padding for the
   * settings tabs; `comfortable` is the `py-2` plus roomier text the rows shipped
   * with before, for the few places whose row height was measured against it.
   */
  density?: 'compact' | 'comfortable';
  /** The control on the right. */
  children: React.ReactNode;
  /** Wraps the row in the inset card used by the settings tabs. */
  bordered?: boolean;
  /**
   * The inset card's fill. `sunken` (`--surface-0`) belongs on a panel that
   * already sits on `--surface-1`; `raised` (`--surface-1`) is for a row inside a
   * surface-0 panel, where a sunken card would be invisible.
   */
  surface?: 'sunken' | 'raised';
  /** Render as `<label>` when the control inside is a native input. */
  as?: 'div' | 'label';
  /** Dims the row and its description, for a row whose control is off. */
  disabled?: boolean;
}

/**
 * Label and description on the left, control on the right, optionally in the
 * inset card the settings tabs use. This layout was re-declared ~55 times.
 *
 * Both lines stay visible: the description carries the behaviour, so hiding it
 * behind a hover was worse than the space it saved. The compact density gets the
 * height back from the padding and the line-heights instead (50px to 40px for a
 * bordered row), and the row layout lives on the root element because rendered
 * as a `<label>` a wrapper inside it would leave the root inline, laying out
 * roughly twice as tall as the hand-written rows it replaces.
 */
export function SettingRow({
  label,
  description,
  density = 'compact',
  children,
  bordered = false,
  surface = 'sunken',
  as: Element = 'div',
  disabled = false,
  className,
  style,
  ...props
}: SettingRowProps) {
  const compact = density === 'compact';

  return (
    <Element
      className={cn(
        'flex items-center justify-between gap-3',
        bordered && cn('rounded-md border px-2.5', compact ? 'py-1.5' : 'py-2'),
        className
      )}
      style={{
        ...(bordered
          ? {
              borderColor: 'var(--border-subtle)',
              background: surface === 'raised' ? 'var(--surface-1)' : 'var(--surface-0)',
            }
          : null),
        opacity: disabled ? 0.68 : undefined,
        ...style,
      }}
      {...props}
    >
      <div className="min-w-0">
        <div
          className={cn('text-xs font-semibold', compact && 'leading-tight')}
          style={{ color: 'var(--text-strong)' }}
        >
          {label}
        </div>
        {description ? (
          <div
            className={compact ? 'text-[11px] leading-tight' : 'text-xs'}
            style={{ color: 'var(--text-muted)' }}
          >
            {description}
          </div>
        ) : null}
      </div>
      <div className="inline-flex items-center gap-2">{children}</div>
    </Element>
  );
}
