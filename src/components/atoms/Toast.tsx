import React from 'react';
import { cn } from './cn';

export type ToastTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

const toastToneStyle: Record<ToastTone, React.CSSProperties> = {
  neutral: {
    borderColor: 'var(--border-subtle)',
    background: 'var(--surface-0)',
    color: 'var(--text-strong)',
  },
  info: {
    borderColor: 'color-mix(in srgb, #60a5fa, var(--border-subtle) 50%)',
    background: 'color-mix(in srgb, #60a5fa, var(--surface-0) 90%)',
    color: 'var(--text-strong)',
  },
  success: {
    borderColor: 'color-mix(in srgb, #22c55e, var(--border-subtle) 50%)',
    background: 'color-mix(in srgb, #22c55e, var(--surface-0) 90%)',
    color: 'var(--text-strong)',
  },
  warning: {
    borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 50%)',
    background: 'color-mix(in srgb, #f59e0b, var(--surface-0) 90%)',
    color: 'var(--text-strong)',
  },
  error: {
    borderColor: 'color-mix(in srgb, #ef4444, var(--border-subtle) 50%)',
    background: 'color-mix(in srgb, #ef4444, var(--surface-0) 90%)',
    color: 'var(--text-strong)',
  },
};

type ToastShape = 'pill' | 'rounded';

export interface ToastProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: ToastTone;
  shape?: ToastShape;
  animated?: boolean;
  visible?: boolean;
  enterOffsetPx?: number;
  pulse?: boolean;
}

export function Toast({
  tone = 'info',
  shape = 'pill',
  animated = false,
  visible = true,
  enterOffsetPx = 8,
  pulse = false,
  className,
  style,
  children,
  ...props
}: ToastProps) {
  /**
   * A transition needs a starting value to move away from, and a toast that is
   * mounted with `visible` already true has none: the browser paints it in its
   * final state, so `transition` has nothing to run. Running that toggle on the
   * next frame instead gives the element one paint in the off state first, which
   * is what makes the fade-and-rise happen on the way in.
   *
   * Before this it depended on the caller: the import toast's guard arrives a
   * commit before an effect flips its `visible` flag, so it alone animated in,
   * while every toast whose guard and flag were set in the same tick appeared at
   * full opacity.
   */
  const [entered, setEntered] = React.useState(false);
  React.useEffect(() => {
    if (!animated) return;
    const frame = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(frame);
  }, [animated]);
  const shown = animated ? entered && visible : visible;

  const animationStyle: React.CSSProperties | undefined = animated
    ? {
        opacity: shown ? 1 : 0,
        transform: `translateY(${shown ? '0px' : `${enterOffsetPx}px`})`,
        transition: 'opacity 220ms ease, transform 220ms ease',
      }
    : undefined;

  return (
    <div
      className={cn(
        'border px-4 py-2 text-sm font-semibold shadow-lg',
        shape === 'pill' ? 'rounded-full' : 'rounded-lg',
        pulse ? 'motion-safe:animate-pulse' : '',
        className,
      )}
      style={{
        ...toastToneStyle[tone],
        ...animationStyle,
        ...style,
      }}
      {...props}
    >
      {children}
    </div>
  );
}

type ToastViewportPosition = 'bottom-center' | 'top-center';

export interface ToastViewportProps extends React.HTMLAttributes<HTMLDivElement> {
  position?: ToastViewportPosition;
  offset?: number | string;
  zIndex?: number;
}

function resolveOffsetValue(offset: number | string | undefined, fallback: string): string {
  if (typeof offset === 'number' && Number.isFinite(offset)) {
    return `${offset}px`;
  }

  if (typeof offset === 'string' && offset.trim().length > 0) {
    return offset;
  }

  return fallback;
}

export function ToastViewport({
  position = 'bottom-center',
  offset,
  zIndex,
  className,
  style,
  children,
  ...props
}: ToastViewportProps) {
  const offsetValue = resolveOffsetValue(
    offset,
    position === 'top-center' ? '1rem' : '1.25rem',
  );

  const positionStyle: React.CSSProperties = position === 'top-center'
    ? { top: offsetValue }
    : { bottom: offsetValue };

  return (
    <div
      className={cn('pointer-events-none fixed inset-x-0 flex justify-center px-3', className)}
      style={{
        ...positionStyle,
        ...(zIndex != null ? { zIndex } : null),
        ...style,
      }}
      {...props}
    >
      {children}
    </div>
  );
}
