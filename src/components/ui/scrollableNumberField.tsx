import React, { useCallback, useEffect, useRef, useState } from 'react';
import { IconButton, cn } from '@/components/ui/primitives';
import { Minus, Plus } from 'lucide-react';

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

  const disableDecrement = disabled || currentValue <= min;
  const disableIncrement = disabled || currentValue >= max;

  return (
    <div className={cn('flex min-w-0 items-center gap-1', className)}>
      <IconButton
        className="!h-8 !w-8 shrink-0 !p-0 !bg-[var(--surface-0)] hover:!bg-[color-mix(in_srgb,var(--surface-0),white_4%)] disabled:!bg-[color-mix(in_srgb,var(--surface-1),black_8%)]"
        onClick={() => stepBy(-1)}
        disabled={disableDecrement}
        title={decreaseTitle}
      >
        <Minus className="h-3.5 w-3.5" />
      </IconButton>

      <div className="relative w-0 min-w-0 flex-1">
        <input
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
          onWheel={(event) => {
            if (disabled) return;
            event.preventDefault();
            stepBy(event.deltaY < 0 ? 1 : -1);
          }}
          className={cn(
            'ui-input h-8 w-full px-1.5 text-xs sm:text-sm text-center tabular-nums font-semibold no-spinners !bg-[var(--surface-0)]',
            unit ? 'pr-8' : undefined,
            inputClassName,
          )}
          aria-label={ariaLabel}
        />
        {unit && (
          <span
            className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-medium"
            style={{ color: 'var(--text-muted)' }}
          >
            {unit}
          </span>
        )}
      </div>

      <IconButton
        className="!h-8 !w-8 shrink-0 !p-0 !bg-[var(--surface-0)] hover:!bg-[color-mix(in_srgb,var(--surface-0),white_4%)] disabled:!bg-[color-mix(in_srgb,var(--surface-1),black_8%)]"
        onClick={() => stepBy(1)}
        disabled={disableIncrement}
        title={increaseTitle}
      >
        <Plus className="h-3.5 w-3.5" />
      </IconButton>
    </div>
  );
}
