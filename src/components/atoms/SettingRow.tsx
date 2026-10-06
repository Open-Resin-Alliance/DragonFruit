import React from 'react';
import { cn } from './cn';

interface SettingRowProps extends React.HTMLAttributes<HTMLElement> {
  label: React.ReactNode;
  /** Secondary line under the label. */
  description?: React.ReactNode;
  /** The control on the right. */
  children: React.ReactNode;
  /** Wraps the row in the inset card used by the settings tabs. */
  bordered?: boolean;
  /** Render as `<label>` when the control inside is a native input. */
  as?: 'div' | 'label';
  /** Dims the row and its description, for a row whose control is off. */
  disabled?: boolean;
}

/**
 * Label + description on the left, control on the right, optionally in the
 * inset card the settings tabs use. This layout was re-declared ~55 times.
 */
export function SettingRow({
  label,
  description,
  children,
  bordered = false,
  as: Element = 'div',
  disabled = false,
  className,
  style,
  ...props
}: SettingRowProps) {
  const row = (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
          {label}
        </div>
        {description ? (
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {description}
          </div>
        ) : null}
      </div>
      <div className="inline-flex items-center gap-2">{children}</div>
    </div>
  );

  if (!bordered) {
    return (
      <Element className={className} style={{ opacity: disabled ? 0.68 : undefined, ...style }} {...props}>
        {row}
      </Element>
    );
  }

  return (
    <Element
      className={cn('rounded-md border px-2.5 py-2', className)}
      style={{
        borderColor: 'var(--border-subtle)',
        background: 'var(--surface-0)',
        opacity: disabled ? 0.68 : undefined,
        ...style,
      }}
      {...props}
    >
      {row}
    </Element>
  );
}
