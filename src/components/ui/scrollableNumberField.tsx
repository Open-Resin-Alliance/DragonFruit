import { useCallback, useEffect, useRef, useState } from 'react';
import { IconButton, cn } from '@/components/atoms';
import { Minus, Plus } from 'lucide-react';
import { wheelStepDirection } from '@/components/ui/wheelStepDirection';

interface ScrollableNumberFieldProps {
  value: number;
  onChange: (nextValue: number) => void;
  min: number;
  max: number;
  step: number;
  ariaLabel: string;
  unit?: string;
  disabled?: boolean;
  decreaseTitle?: string;
  increaseTitle?: string;
  commitOnBlur?: boolean;
  className?: string;
  inputClassName?: string;
  /**
   * Shrink everything — 24px steppers, a shorter input, smaller type — for the
   * side panels that put two of these on one row. At full size the pair doesn't
   * fit: the steppers eat the width and the value ends up printed on top of the
   * unit.
   */
  compact?: boolean;
}

export function ScrollableNumberField({
  value,
  onChange,
  min,
  max,
  step,
  ariaLabel,
  unit,
  disabled = false,
  decreaseTitle = 'Decrease value',
  increaseTitle = 'Increase value',
  commitOnBlur = false,
  className,
  inputClassName,
  compact = false,
}: ScrollableNumberFieldProps) {
  const clampValue = useCallback((candidate: number): number => {
    const boundedMin = Number.isFinite(min) ? min : Number.NEGATIVE_INFINITY;
    const boundedMax = Number.isFinite(max) ? max : Number.POSITIVE_INFINITY;
    return Math.max(boundedMin, Math.min(boundedMax, candidate));
  }, [max, min]);

  const normalizeStep = Number.isFinite(step) && step > 0 ? step : 1;

  const formatValue = useCallback((candidate: number): string => {
    if (!Number.isFinite(candidate)) return '';
    const normalized = Number(candidate.toFixed(6));
    return String(normalized);
  }, []);

  const [draftValue, setDraftValue] = useState<string>(() => formatValue(clampValue(value)));
  const isEditingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (isEditingRef.current) return;
    setDraftValue(formatValue(clampValue(value)));
  }, [clampValue, formatValue, value]);

  const commitFromRaw = useCallback((raw: string): boolean => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      return false;
    }

    const next = clampValue(parsed);
    onChange(next);
    setDraftValue(formatValue(next));
    return true;
  }, [clampValue, formatValue, onChange]);

  const stepBy = useCallback((direction: 1 | -1) => {
    if (disabled) return;

    const parsed = Number(draftValue);
    const base = Number.isFinite(parsed) ? parsed : clampValue(value);
    const next = clampValue(base + (normalizeStep * direction));
    onChange(next);
    setDraftValue(formatValue(next));
  }, [clampValue, disabled, draftValue, formatValue, normalizeStep, onChange, value]);

  // React attaches its `wheel` listener at the root as PASSIVE, so
  // preventDefault() inside an onWheel handler is silently ignored and the wheel
  // both steps the value AND scrolls whatever container the field sits in. A
  // native non-passive listener is the only way to consume the event.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (disabled) return;
      // Only step on wheel when the field is focused or Shift is held —
      // prevents accidental value changes while scrolling the page. Shift also
      // makes a mouse wheel arrive as horizontal scroll, hence the axis-agnostic
      // direction.
      if (document.activeElement !== el && !event.shiftKey) return;
      const direction = wheelStepDirection(event);
      if (direction === 0) return;
      event.preventDefault();
      event.stopPropagation();
      stepBy(direction);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [disabled, stepBy]);

  const handleBlur = () => {
    isEditingRef.current = false;

    if (commitOnBlur) {
      const committed = commitFromRaw(draftValue);
      if (!committed) {
        setDraftValue(formatValue(clampValue(value)));
      }
      return;
    }

    const parsed = Number(draftValue);
    if (!Number.isFinite(parsed)) {
      setDraftValue(formatValue(clampValue(value)));
      return;
    }

    const next = clampValue(parsed);
    onChange(next);
    setDraftValue(formatValue(next));
  };

  const parsedCurrent = Number(draftValue);
  const currentValue = Number.isFinite(parsedCurrent)
    ? clampValue(parsedCurrent)
    : clampValue(value);

  const stepperClass = cn(
    compact ? '!h-6 !w-6' : '!h-8 !w-8',
    'shrink-0 !p-0 !bg-[var(--surface-0)] hover:!bg-[color-mix(in_srgb,var(--surface-0),white_4%)] disabled:!bg-[color-mix(in_srgb,var(--surface-1),black_8%)]',
  );
  const stepperIconClass = compact ? 'h-3 w-3' : 'h-3.5 w-3.5';

  const disableDecrement = disabled || currentValue <= min;
  const disableIncrement = disabled || currentValue >= max;

  return (
    <div className={cn('flex min-w-0 items-center', compact ? 'gap-0.5' : 'gap-1', className)}>
      <IconButton
        className={stepperClass}
        onClick={() => stepBy(-1)}
        disabled={disableDecrement}
        title={decreaseTitle}
      >
        <Minus className={stepperIconClass} />
      </IconButton>

      <div className="relative w-0 min-w-0 flex-1">
        <input
          ref={inputRef}
          type="number"
          min={min}
          max={max}
          step={normalizeStep}
          value={draftValue}
          disabled={disabled}
          onFocus={() => {
            isEditingRef.current = true;
          }}
          onChange={(event) => {
            const nextRaw = event.target.value;
            setDraftValue(nextRaw);
            if (commitOnBlur) return;
            const parsed = Number(nextRaw);
            if (!Number.isFinite(parsed)) return;
            onChange(clampValue(parsed));
          }}
          onBlur={handleBlur}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              if (commitOnBlur) {
                commitFromRaw(draftValue);
              }
              event.currentTarget.blur();
              return;
            }

            if (event.key === 'Escape') {
              event.preventDefault();
              setDraftValue(formatValue(clampValue(value)));
              event.currentTarget.blur();
            }
          }}
          className={cn(
            'ui-input w-full text-center tabular-nums font-semibold no-spinners !bg-[var(--surface-0)]',
            compact ? 'h-7 px-1 text-[11px]' : 'h-8 px-1.5 text-xs sm:text-sm',
            unit ? (compact ? 'pr-4' : 'pr-8') : undefined,
            inputClassName,
          )}
          aria-label={ariaLabel}
        />
        {unit && (
          <span
            className={cn(
              'pointer-events-none absolute top-1/2 -translate-y-1/2 font-medium',
              compact ? 'right-1 text-[8px]' : 'right-2 text-[10px]',
            )}
            style={{ color: 'var(--text-muted)' }}
          >
            {unit}
          </span>
        )}
      </div>

      <IconButton
        className={stepperClass}
        onClick={() => stepBy(1)}
        disabled={disableIncrement}
        title={increaseTitle}
      >
        <Plus className={stepperIconClass} />
      </IconButton>
    </div>
  );
}
