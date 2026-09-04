import { NumberInput } from '@/components/ui/NumberInput';

interface CompactNumberFieldProps {
  /** Label shown centered above the field. */
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  /** Small suffix shown inside the box on the right (e.g. "mm"). */
  unit?: string;
  disabled?: boolean;
  ariaLabel: string;
  /** Tooltip on the label. */
  title?: string;
  /** Extra classes on the field's wrapper (e.g. `col-span-2` in a grid). */
  className?: string;
}

/**
 * A compact labelled number field — the Arrange panel's Manual-mode input rather
 * than the full-width stepper field, so two fit per row. Wheel-scrolls to step.
 * The label sits centered above a bare NumberInput (no +/- buttons), with the
 * unit as a small suffix inside the box. Shared by the side panels that pack
 * numeric settings into tight rows (Cut settings, Arrange, Support Studio).
 */
export function CompactNumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  unit,
  disabled = false,
  ariaLabel,
  title,
  className,
}: CompactNumberFieldProps) {
  const safe = Number.isFinite(value) ? value : min;
  return (
    <div className={className ? `min-w-0 ${className}` : 'min-w-0'}>
      <label className="ui-meta block text-center" style={{ color: 'var(--text-muted)' }} title={title}>
        {label}
      </label>
      <div className="relative mt-1">
        <NumberInput
          value={safe}
          onChange={onChange}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          showStepper={false}
          aria-label={ariaLabel}
          className={`ui-input h-8 w-full min-w-0 pl-1.5 ${unit ? 'pr-6' : 'pr-1.5'} text-xs text-center no-spinners !bg-[var(--surface-0)]`}
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
    </div>
  );
}
