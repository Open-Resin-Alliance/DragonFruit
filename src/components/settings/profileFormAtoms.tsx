'use client';

import React from 'react';
import { CarFront, ChevronDown, ChevronUp, CircleHelp, Snail } from 'lucide-react';
import { NumberInput } from '@/components/ui/NumberInput';
import { SelectDropdown } from '@/components/ui/SelectDropdown';
import { MouseTooltip } from '@/components/ui/MouseTooltip';
import {
  DEFAULT_CUSTOM_CURVE,
  DEFAULT_SAVED_CURVES,
  LutCurveEditorModal,
  LutCurveSelector,
  type SavedCurve,
} from '@/features/slicing/components/LutCurveEditor';
import {
  DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS,
  type MaterialAntiAliasingSettings,
  type MaterialProfile,
  type PrinterOutputFormat,
} from '@/features/profiles/profileStore';
import { getProfileLocalMaterialSettingsAdapter } from '@/features/plugins/pluginRegistry';

// ─── Shared Types ─────────────────────────────────────────────────────────────

export type MaterialDraft = Omit<MaterialProfile, 'id' | 'printerProfileId'>;
export type LocalSettingsByOutputDraft = NonNullable<MaterialProfile['localSettingsByOutput']>;

export type PluginNumericFieldSchema = {
  kind: 'number' | 'integer';
  min?: number;
  max?: number;
  defaultValue: number;
};

// ─── Constants ────────────────────────────────────────────────────────────────

export const RESIN_FAMILY_OPTIONS: Array<{ value: MaterialProfile['resinFamily']; label: string }> = [
  { value: 'standard', label: 'Standard' },
  { value: 'abs-like', label: 'ABS-like' },
  { value: 'tough', label: 'Tough' },
  { value: 'flexible', label: 'Flexible' },
  { value: 'engineering', label: 'Engineering' },
  { value: 'other', label: 'Other' },
];

export const RESIN_FAMILY_COLOR: Record<string, string> = {
  'standard': '#60a5fa',
  'abs-like': '#f59e0b',
  'tough': '#a78bfa',
  'flexible': '#34d399',
  'engineering': '#f97316',
  'other': '#94a3b8',
};

export const CURRENCY_OPTIONS = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CNY'];

const FIELD_TAG_TONES = {
  slow: { icon: Snail, fallbackColor: '#f59e0b' },
  fast: { icon: CarFront, fallbackColor: '#22c55e' },
} as const;

// ─── Utilities ────────────────────────────────────────────────────────────────

export function clampNonNegativeNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function sanitizePluginNumericValue(field: PluginNumericFieldSchema, value: number): number {
  let next = clampNonNegativeNumber(value);
  if (field.kind === 'integer') next = Math.round(next);

  const minimum = Math.max(0, field.min ?? 0);
  next = Math.max(minimum, next);

  if (field.max != null) next = Math.min(field.max, next);
  return next;
}

export function resolveFieldTagTone(tag?: string): { icon: typeof CarFront | typeof Snail; fallbackColor: string } | null {
  const normalized = typeof tag === 'string' ? tag.trim().toLowerCase() : '';
  if (!normalized) return null;
  return FIELD_TAG_TONES[normalized as keyof typeof FIELD_TAG_TONES] ?? null;
}

// ─── FieldTagChip ─────────────────────────────────────────────────────────────

type FieldTagChipProps = {
  tag?: string;
  color?: string;
  compact?: boolean;
};

export function FieldTagChip({ tag, color, compact = false }: FieldTagChipProps) {
  const trimmedTag = typeof tag === 'string' ? tag.trim() : '';
  const tone = resolveFieldTagTone(trimmedTag);
  if (!trimmedTag || !tone) return null;

  const accent = (typeof color === 'string' && color.trim().length > 0)
    ? color.trim()
    : tone.fallbackColor;
  const Icon = tone.icon;

  return (
    <span
      className={`pointer-events-none absolute top-1/2 z-10 inline-flex -translate-y-1/2 items-center gap-1 rounded-full px-2 font-semibold uppercase tracking-wide ${compact ? 'right-8 h-5 text-[9px]' : 'right-8 h-5 text-[9px]'}`}
      style={{
        background: `color-mix(in srgb, ${accent} 18%, var(--surface-1))`,
        color: accent,
      }}
      title={trimmedTag}
      aria-hidden="true"
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span>{trimmedTag}</span>
    </span>
  );
}

// ─── LabeledInput ─────────────────────────────────────────────────────────────

function FieldHelpTooltip({ label, help }: { label: string; help: string }) {
  const [hovered, setHovered] = React.useState(false);

  return (
    <span
      className="inline-flex h-3.5 w-3.5 items-center justify-center rounded border cursor-help relative"
      style={{
        borderColor: 'var(--border-subtle)',
        background: 'var(--surface-0)',
        color: 'var(--text-muted)',
      }}
      tabIndex={0}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      onClick={(event) => event.stopPropagation()}
      aria-label={`${label}. ${help}`}
    >
      <CircleHelp className="h-2.5 w-2.5" />
      <MouseTooltip visible={hovered} offset={{ x: 0, y: 28 }} className="left-1/2 -translate-x-1/2">
        <div
          className="rounded px-2 py-1.5 text-[11px] leading-tight font-medium shadow-lg"
          style={{
            background: 'rgba(24, 24, 24, 0.98)',
            color: 'var(--text-strong, #e0e0e0)',
            border: '1px solid var(--accent, #baf72e)',
            maxWidth: 260,
            whiteSpace: 'normal',
            textAlign: 'left',
            boxShadow: '0 6px 32px 0 rgba(0,0,0,0.44), 0 1.5px 8px 0 rgba(0,0,0,0.28)',
          }}
        >
          {help}
        </div>
      </MouseTooltip>
    </span>
  );
}

type LabeledInputProps = {
  label: string;
  helpText?: string;
  disabled?: boolean;
  value: string | number;
  onChange: (value: string) => void;
};

export function LabeledInput({ label, helpText, disabled = false, value, onChange }: LabeledInputProps) {
  const [localValue, setLocalValue] = React.useState<string>(() => String(value));
  const [isFocused, setIsFocused] = React.useState(false);

  React.useEffect(() => {
    if (isFocused) return;
    setLocalValue(String(value));
  }, [value, isFocused]);

  return (
    <label className="space-y-1 block">
      <span className="ui-label font-medium inline-flex items-center gap-1.5">
        {label}
        {helpText && <FieldHelpTooltip label={label} help={helpText} />}
      </span>
      <input
        type="text"
        disabled={disabled}
        value={localValue}
        onChange={(event) => {
          const next = event.target.value;
          setLocalValue(next);
          onChange(next);
        }}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        className={`ui-input w-full h-[36px] px-2.5 leading-tight text-sm ${disabled ? 'opacity-55 cursor-not-allowed' : ''}`}
      />
    </label>
  );
}

// ─── LabeledNumberInput ───────────────────────────────────────────────────────

type LabeledNumberInputProps = {
  label: string;
  helpText?: string;
  tag?: string;
  color?: string;
  disabled?: boolean;
  value: number;
  onChange: (value: number) => void;
};

export function LabeledNumberInput({ label, helpText, tag, color, disabled = false, value, onChange }: LabeledNumberInputProps) {
  const safeValue = clampNonNegativeNumber(value);
  const [localValue, setLocalValue] = React.useState<string>(() => String(safeValue));
  const [isFocused, setIsFocused] = React.useState(false);
  const tone = resolveFieldTagTone(tag);
  const accent = (typeof color === 'string' && color.trim().length > 0)
    ? color.trim()
    : tone?.fallbackColor ?? null;

  React.useEffect(() => {
    if (isFocused) return;
    setLocalValue(String(safeValue));
  }, [isFocused, safeValue]);

  const commit = React.useCallback(() => {
    const trimmed = localValue.trim();
    if (trimmed === '') {
      setLocalValue(String(value));
      return;
    }

    const next = Number(trimmed);
    if (!Number.isFinite(next)) {
      setLocalValue(String(safeValue));
      return;
    }

    const sanitized = clampNonNegativeNumber(next);
    onChange(sanitized);
    setLocalValue(String(sanitized));
  }, [localValue, onChange, safeValue, value]);

  const nudge = React.useCallback((direction: 1 | -1) => {
    const fallback = safeValue;
    const parsed = Number(localValue.trim());
    const current = Number.isFinite(parsed) ? parsed : fallback;
    const step = Math.abs(current) < 1 ? 0.01 : 1;
    const decimals = step < 1 ? 3 : 0;
    const next = clampNonNegativeNumber(Number((current + direction * step).toFixed(decimals)));
    onChange(next);
    setLocalValue(String(next));
  }, [localValue, onChange, safeValue]);

  return (
    <label className="space-y-1 block">
      <span className="ui-label font-medium inline-flex items-center gap-1.5">
        {label}
        {helpText && <FieldHelpTooltip label={label} help={helpText} />}
      </span>
      <div className="relative">
        <input
          type="text"
          disabled={disabled}
          value={localValue}
          onChange={(event) => {
            if (event.target.value.includes('-')) return;
            setLocalValue(event.target.value);
          }}
          onFocus={() => setIsFocused(true)}
          onBlur={() => {
            setIsFocused(false);
            commit();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur();
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              nudge(1);
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              nudge(-1);
            }
          }}
          className={`ui-input w-full h-[36px] pl-2.5 ${tag ? 'pr-20' : 'pr-6'} leading-tight text-sm no-spinners ${disabled ? 'opacity-55 cursor-not-allowed' : ''}`}
          style={accent ? {
            background: `color-mix(in srgb, ${accent} 7%, var(--surface-1))`,
            borderColor: `color-mix(in srgb, ${accent} 24%, var(--border-subtle))`,
          } : undefined}
        />

        <FieldTagChip tag={tag} color={color} />

        <div className="absolute inset-y-0 right-1 z-20 flex w-4 flex-col items-center justify-center gap-0.5">
          <button
            type="button"
            className="inline-flex h-3 w-3 items-center justify-center rounded hover:bg-white/10"
            onClick={() => nudge(1)}
            disabled={disabled}
            tabIndex={-1}
            aria-label={`Increase ${label}`}
          >
            <ChevronUp className="h-2.5 w-2.5" />
          </button>
          <button
            type="button"
            className="inline-flex h-3 w-3 items-center justify-center rounded hover:bg-white/10"
            onClick={() => nudge(-1)}
            disabled={disabled}
            tabIndex={-1}
            aria-label={`Decrease ${label}`}
          >
            <ChevronDown className="h-2.5 w-2.5" />
          </button>
        </div>
      </div>
    </label>
  );
}

// ─── LabeledTwoStageNumberInput ───────────────────────────────────────────────

type LabeledTwoStageNumberInputProps = {
  label: string;
  helpText?: string;
  firstValue: number;
  secondValue: number;
  firstMin?: number;
  firstMax?: number;
  firstStep?: number;
  firstTag?: string;
  firstColor?: string;
  secondMin?: number;
  secondMax?: number;
  secondStep?: number;
  secondTag?: string;
  secondColor?: string;
  onFirstChange: (value: number) => void;
  onSecondChange: (value: number) => void;
};

export function LabeledTwoStageNumberInput({
  label,
  helpText,
  firstValue,
  secondValue,
  firstMin,
  firstMax,
  firstStep,
  firstTag,
  firstColor,
  secondMin,
  secondMax,
  secondStep,
  secondTag,
  secondColor,
  onFirstChange,
  onSecondChange,
}: LabeledTwoStageNumberInputProps) {
  const firstTone = resolveFieldTagTone(firstTag);
  const secondTone = resolveFieldTagTone(secondTag);
  const firstAccent = (typeof firstColor === 'string' && firstColor.trim().length > 0)
    ? firstColor.trim()
    : firstTone?.fallbackColor ?? null;
  const secondAccent = (typeof secondColor === 'string' && secondColor.trim().length > 0)
    ? secondColor.trim()
    : secondTone?.fallbackColor ?? null;

  return (
    <label className="space-y-1 block md:col-span-2">
      <span className="ui-label font-medium inline-flex items-center gap-1.5">
        {label}
        {helpText && <FieldHelpTooltip label={label} help={helpText} />}
      </span>
      <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-center">
        <div className="relative">
          <NumberInput
            value={Number.isFinite(firstValue) ? firstValue : 0}
            onChange={(next) => onFirstChange(next)}
            min={firstMin}
            max={firstMax}
            step={firstStep}
            showStepper
            aria-label={`${label} stage 1`}
            className={`ui-input w-full h-[36px] px-2.5 ${firstTag ? 'pr-24' : 'pr-2.5'} text-sm leading-tight`}
            style={firstAccent ? {
              background: `color-mix(in srgb, ${firstAccent} 7%, var(--surface-1))`,
              borderColor: `color-mix(in srgb, ${firstAccent} 24%, var(--border-subtle))`,
            } : undefined}
          />
          <FieldTagChip tag={firstTag} color={firstColor} compact />
        </div>
        <div className="text-sm px-1 font-semibold" style={{ color: 'var(--text-muted)' }}>{'>'}</div>
        <div className="relative">
          <NumberInput
            value={Number.isFinite(secondValue) ? secondValue : 0}
            onChange={(next) => onSecondChange(next)}
            min={secondMin}
            max={secondMax}
            step={secondStep}
            showStepper
            aria-label={`${label} stage 2`}
            className={`ui-input w-full h-[36px] px-2.5 ${secondTag ? 'pr-24' : 'pr-2.5'} text-sm leading-tight`}
            style={secondAccent ? {
              background: `color-mix(in srgb, ${secondAccent} 7%, var(--surface-1))`,
              borderColor: `color-mix(in srgb, ${secondAccent} 24%, var(--border-subtle))`,
            } : undefined}
          />
          <FieldTagChip tag={secondTag} color={secondColor} compact />
        </div>
      </div>
    </label>
  );
}

// ─── LabeledSelectInput ───────────────────────────────────────────────────────

type LabeledSelectInputProps = {
  label: string;
  value: PrinterOutputFormat;
  options: Array<{ value: PrinterOutputFormat; label: string }>;
  onChange: (value: PrinterOutputFormat) => void;
  disabled?: boolean;
};

export function LabeledSelectInput({ label, value, options, onChange, disabled = false }: LabeledSelectInputProps) {
  return (
    <SelectDropdown
      label={label}
      value={value}
      onChange={(nextValue) => onChange(nextValue as PrinterOutputFormat)}
      disabled={disabled}
      options={options}
      className="space-y-1 block"
      labelClassName="font-medium"
      selectClassName={`w-full h-[36px] px-2.5 pr-10 leading-tight text-sm ${disabled ? 'opacity-55 cursor-not-allowed' : ''}`}
      selectStyle={disabled
        ? {
            borderColor: 'var(--border-subtle)',
            background: 'color-mix(in srgb, var(--surface-2), black 8%)',
            color: 'var(--text-muted)',
          }
        : undefined}
    />
  );
}

// ─── LabeledToggleInput ───────────────────────────────────────────────────────

type LabeledToggleInputProps = {
  label: string;
  helpText?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
};

export function LabeledToggleInput({ label, helpText, checked, onChange, disabled = false }: LabeledToggleInputProps) {
  return (
    <label className="space-y-1 block">
      <span className="ui-label font-medium inline-flex items-center gap-1.5">
        {label}
        {helpText && <FieldHelpTooltip label={label} help={helpText} />}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => {
          if (disabled) return;
          onChange(!checked);
        }}
        disabled={disabled}
        className={`ui-input w-full h-[36px] px-2.5 leading-tight text-sm inline-flex items-center justify-between ${disabled ? 'opacity-55 cursor-not-allowed' : ''}`}
        style={disabled
          ? {
              borderColor: 'var(--border-subtle)',
              background: 'color-mix(in srgb, var(--surface-2), black 8%)',
              color: 'var(--text-muted)',
            }
          : {
              borderColor: checked
                ? 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 36%)'
                : 'var(--border-subtle)',
              background: checked
                ? 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 90%)'
                : 'var(--surface-1)',
              color: checked ? 'var(--text-strong)' : 'var(--text-muted)',
            }}
      >
        <span>{checked ? 'Enabled' : 'Disabled'}</span>
        <span
          className="inline-flex h-5 w-9 rounded-full p-0.5 transition-colors"
          style={disabled
            ? { background: 'color-mix(in srgb, var(--surface-2), black 8%)' }
            : { background: checked ? 'var(--accent-secondary)' : 'var(--surface-2)' }}
        >
          <span
            className={`h-4 w-4 rounded-full bg-white transition-transform ${checked ? 'translate-x-4' : 'translate-x-0'}`}
          />
        </span>
      </button>
    </label>
  );
}

// ─── LabeledResinFamilySelect ─────────────────────────────────────────────────

type LabeledResinFamilySelectProps = {
  label: string;
  value: MaterialProfile['resinFamily'];
  options: Array<{ value: MaterialProfile['resinFamily']; label: string }>;
  onChange: (value: MaterialProfile['resinFamily']) => void;
};

export function LabeledResinFamilySelect({ label, value, options, onChange }: LabeledResinFamilySelectProps) {
  return (
    <SelectDropdown
      label={label}
      value={value}
      onChange={(nextValue) => onChange(nextValue as MaterialProfile['resinFamily'])}
      options={options}
      className="space-y-1 block"
      labelClassName="font-medium"
      selectClassName="w-full h-[36px] px-2.5 pr-10 leading-tight text-sm"
    />
  );
}

// ─── LabeledCurrencySelect ────────────────────────────────────────────────────

type LabeledCurrencySelectProps = {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
};

export function LabeledCurrencySelect({ label, value, options, onChange }: LabeledCurrencySelectProps) {
  return (
    <SelectDropdown
      label={label}
      value={value}
      onChange={(nextValue) => onChange(String(nextValue))}
      options={options.map((option) => ({ value: option, label: option }))}
      className="space-y-1 block"
      labelClassName="font-medium"
      selectClassName="w-full h-[36px] px-2.5 pr-10 leading-tight text-sm"
    />
  );
}

// ─── MaterialProfileIdentitySection ──────────────────────────────────────────

type MaterialProfileIdentitySectionProps = {
  draft: MaterialDraft;
  onChange: React.Dispatch<React.SetStateAction<MaterialDraft>>;
};

export function MaterialProfileIdentitySection({ draft, onChange }: MaterialProfileIdentitySectionProps) {
  return (
    <div className="rounded-xl border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
      <div className="ui-meta font-semibold uppercase tracking-wide mb-2">Material Profile</div>
      <div className="grid grid-cols-2 gap-2">
        <LabeledInput
          label="Manufacturer"
          value={draft.brand}
          onChange={(value) => onChange((prev) => ({ ...prev, brand: value }))}
        />
        <LabeledInput
          label="Name"
          value={draft.name}
          onChange={(value) => onChange((prev) => ({ ...prev, name: value }))}
        />
        <LabeledResinFamilySelect
          label="Resin Family"
          value={draft.resinFamily}
          options={RESIN_FAMILY_OPTIONS}
          onChange={(value) => onChange((prev) => ({ ...prev, resinFamily: value }))}
        />
        <LabeledCurrencySelect
          label="Currency"
          value={draft.currencyCode || 'USD'}
          options={CURRENCY_OPTIONS}
          onChange={(value) => onChange((prev) => ({ ...prev, currencyCode: value }))}
        />
        <LabeledNumberInput
          label="Bottle Price"
          value={draft.bottlePrice}
          onChange={(value) => onChange((prev) => ({ ...prev, bottlePrice: value }))}
        />
        <LabeledNumberInput
          label="Bottle Capacity (ml)"
          value={draft.bottleCapacityMl}
          onChange={(value) => onChange((prev) => ({ ...prev, bottleCapacityMl: value }))}
        />
      </div>
    </div>
  );
}

// ─── MaterialProfileFormSections ──────────────────────────────────────────────

type MaterialProfileFormSectionsProps = {
  draft: MaterialDraft;
  onChange: React.Dispatch<React.SetStateAction<MaterialDraft>>;
};

export function MaterialProfileFormSections({ draft, onChange }: MaterialProfileFormSectionsProps) {
  return (
    <>
      <MaterialProfileIdentitySection draft={draft} onChange={onChange} />

      <div className="rounded-xl border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
        <div className="ui-meta font-semibold uppercase tracking-wide mb-2">Print Settings</div>
        <div className="grid grid-cols-2 gap-2">
          <LabeledNumberInput
            label="Layer height (mm)"
            value={draft.layerHeightMm}
            onChange={(value) => onChange((prev) => ({ ...prev, layerHeightMm: value }))}
          />
          <LabeledNumberInput
            label="Normal exposure (s)"
            value={draft.normalExposureSec}
            onChange={(value) => onChange((prev) => ({ ...prev, normalExposureSec: value }))}
          />
          <LabeledNumberInput
            label="Bottom exposure (s)"
            value={draft.bottomExposureSec}
            onChange={(value) => onChange((prev) => ({ ...prev, bottomExposureSec: value }))}
          />
          <LabeledNumberInput
            label="Bottom layers"
            value={draft.bottomLayerCount}
            onChange={(value) => onChange((prev) => ({ ...prev, bottomLayerCount: value }))}
          />
          <LabeledNumberInput
            label="Lift distance (mm)"
            value={draft.liftDistanceMm}
            onChange={(value) => onChange((prev) => ({ ...prev, liftDistanceMm: value }))}
          />
          <LabeledNumberInput
            label="Lift speed (mm/min)"
            value={draft.liftSpeedMmMin}
            onChange={(value) => onChange((prev) => ({ ...prev, liftSpeedMmMin: value }))}
          />
          <LabeledNumberInput
            label="Retract speed (mm/min)"
            value={draft.retractSpeedMmMin}
            onChange={(value) => onChange((prev) => ({ ...prev, retractSpeedMmMin: value }))}
          />
        </div>
      </div>

      <div className="rounded-xl border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
        <div className="ui-meta font-semibold uppercase tracking-wide mb-2">
          Scale Compensation (% shrinkage)
        </div>
        <div className="grid grid-cols-3 gap-2">
          <LabeledNumberInput
            label="Scale X (%)"
            value={draft.scaleCompensationPct.x}
            onChange={(value) => onChange((prev) => ({
              ...prev,
              scaleCompensationPct: {
                ...prev.scaleCompensationPct,
                x: value,
              },
            }))}
          />
          <LabeledNumberInput
            label="Scale Y (%)"
            value={draft.scaleCompensationPct.y}
            onChange={(value) => onChange((prev) => ({
              ...prev,
              scaleCompensationPct: {
                ...prev.scaleCompensationPct,
                y: value,
              },
            }))}
          />
          <LabeledNumberInput
            label="Scale Z (%)"
            value={draft.scaleCompensationPct.z}
            onChange={(value) => onChange((prev) => ({
              ...prev,
              scaleCompensationPct: {
                ...prev.scaleCompensationPct,
                z: value,
              },
            }))}
          />
        </div>
      </div>
    </>
  );
}

type MaterialAntiAliasingSectionProps = {
  draft: MaterialDraft;
  onChange: React.Dispatch<React.SetStateAction<MaterialDraft>>;
  lockActivationToggles?: boolean;
};

const AA_STRENGTH_PRESETS = [4, 8, 16, 32] as const;
const BLUR_WIDTH_PRESETS = [1, 2, 4, 8] as const;
const Z_BLUR_RADIUS_PRESETS = [1, 2, 3] as const;
const LOOK_BACK_PRESETS = [2, 4, 6, 8] as const;

const LUT_CURVES_STORAGE_KEY = 'dragonfruit.slicing.3daaSavedCurves';
const NEW_CURVE_EDITING_TARGET = '__new__';

function resolveMaterialAaSavedCurves(): SavedCurve[] {
  if (typeof window === 'undefined') return DEFAULT_SAVED_CURVES;
  try {
    const raw = window.sessionStorage.getItem(LUT_CURVES_STORAGE_KEY)
      ?? window.localStorage.getItem(LUT_CURVES_STORAGE_KEY);
    if (!raw) return DEFAULT_SAVED_CURVES;
    const parsed = JSON.parse(raw) as SavedCurve[];
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {
    // Ignore malformed persisted LUT data and fall back to defaults.
  }
  return DEFAULT_SAVED_CURVES;
}

function parseAaLevelSteps(level: string | null | undefined): number {
  const trimmed = (level ?? '').trim().toLowerCase();
  const parsed = Number(trimmed.endsWith('x') ? trimmed.slice(0, -1) : trimmed);
  if (!Number.isFinite(parsed)) return 4;
  return Math.max(2, Math.min(64, Math.round(parsed)));
}

function formatAaLevel(steps: number): string {
  return `${Math.max(2, Math.min(64, Math.round(steps)))}x`;
}

function clampAaNumber(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function PresetButton({
  active,
  disabled = false,
  children,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={`rounded border px-1.5 py-1 text-xs font-medium transition-colors ${disabled ? 'cursor-not-allowed opacity-45' : ''}`}
      style={disabled
        ? {
            borderColor: 'var(--border-subtle)',
            background: 'color-mix(in srgb, var(--surface-2), black 6%)',
            color: 'var(--text-muted)',
          }
        : active
        ? {
            borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 42%)',
            background: 'color-mix(in srgb, var(--accent), var(--surface-1) 88%)',
            color: 'var(--text-strong)',
          }
        : {
            borderColor: 'var(--border-subtle)',
            background: 'var(--surface-0)',
            color: 'var(--text-muted)',
          }}
      onClick={() => {
        if (disabled) return;
        onClick();
      }}
    >
      {children}
    </button>
  );
}

function AaHelpIcon({ label, text }: { label: string; text: string }) {
  return (
    <span className="normal-case tracking-normal">
      <FieldHelpTooltip label={label} help={text} />
    </span>
  );
}

function AaSelectDropdown({
  label,
  helpText,
  value,
  disabled = false,
  options,
  onChange,
}: {
  label: string;
  helpText?: string;
  value: string;
  disabled?: boolean;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="space-y-1 block">
      {label && (
        <span className="ui-label font-medium inline-flex items-center gap-1.5">
          {label}
          {helpText && <AaHelpIcon label={label} text={helpText} />}
        </span>
      )}
      <SelectDropdown
        ariaLabel={label || 'Select option'}
        value={value}
        disabled={disabled}
        onChange={onChange}
        options={options}
        selectClassName="w-full h-[36px] px-2.5 pr-10 leading-tight text-sm"
      />
    </label>
  );
}

function AaCard({
  title,
  description,
  disabled = false,
  className = '',
  children,
}: {
  title: string;
  description: string;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-xl border p-3 transition-opacity ${disabled ? 'opacity-55' : ''} ${className}`}
      style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}
    >
      <div className="ui-meta font-semibold uppercase tracking-wide mb-2 flex items-center gap-1.5">
        {title}
        <AaHelpIcon label={title} text={description} />
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function AaInlineHelp({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>{children}</p>;
}

export function MaterialAntiAliasingSection({ draft, onChange, lockActivationToggles = false }: MaterialAntiAliasingSectionProps) {
  const settings = {
    ...DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS,
    ...(draft.antiAliasingSettings ?? {}),
  };
  const customSettingsEnabled = settings.enableCustomSettings === true || settings.enableOverride === true;
  const overrideEnabled = settings.enableOverride === true;
  const aaEnabled = customSettingsEnabled && settings.mode !== 'Off';
  const is3daa = customSettingsEnabled && settings.mode === '3DAA';
  const sampleSteps = parseAaLevelSteps(settings.level);
  const customStrengthEnabled = aaEnabled && settings.useCustomLevel;
  const customXyBlurEnabled = aaEnabled && settings.useCustomBlurBrushRadius;
  const gaussianXyEnabled = customXyBlurEnabled && settings.blurBrushKernel === 'gaussian' && settings.blurBrushRadiusPx > 0;
  const duplicateZEnabled = is3daa && sampleSteps >= 16;
  const customZBlurEnabled = is3daa && settings.useCustomZBlurRadius;
  const gaussianZEnabled = customZBlurEnabled && settings.zBlurKernel === 'gaussian' && settings.zBlurRadiusLayers > 0;
  const [savedCurves, setSavedCurves] = React.useState<SavedCurve[]>(() => resolveMaterialAaSavedCurves());
  const [editingTarget, setEditingTarget] = React.useState<string | null>(null);

  const updateAaSettings = React.useCallback((patch: Partial<MaterialAntiAliasingSettings>) => {
    onChange((prev) => ({
      ...prev,
      antiAliasingSettings: {
        ...DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS,
        ...(prev.antiAliasingSettings ?? {}),
        ...patch,
      },
    }));
  }, [onChange]);

  React.useEffect(() => {
    if (savedCurves.length === 0) {
      const fallback = { ...DEFAULT_SAVED_CURVES[0], id: crypto.randomUUID(), points: [...DEFAULT_CUSTOM_CURVE] };
      setSavedCurves([fallback]);
      updateAaSettings({ selectedLutCurveId: fallback.id });
      return;
    }

    if (!savedCurves.some((curve) => curve.id === settings.selectedLutCurveId)) {
      updateAaSettings({ selectedLutCurveId: savedCurves[0].id });
    }

    if (
      editingTarget
      && editingTarget !== NEW_CURVE_EDITING_TARGET
      && !savedCurves.some((curve) => curve.id === editingTarget)
    ) {
      setEditingTarget(null);
    }
  }, [editingTarget, savedCurves, settings.selectedLutCurveId, updateAaSettings]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const serialized = JSON.stringify(savedCurves);
    window.localStorage.setItem(LUT_CURVES_STORAGE_KEY, serialized);
    window.sessionStorage.setItem(LUT_CURVES_STORAGE_KEY, serialized);
  }, [savedCurves]);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
      <AaCard
        title="Anti-Aliasing Settings"
        description="Custom settings can be saved on the material without forcing the slicer to use them. Override AA Settings applies those saved settings instead of Auto AA."
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <button
            type="button"
            role="switch"
            aria-checked={customSettingsEnabled}
            disabled={lockActivationToggles}
            onClick={() => {
              if (lockActivationToggles) return;
              const next = !customSettingsEnabled;
              updateAaSettings({
                enableCustomSettings: next,
                enableOverride: next ? overrideEnabled : false,
              });
            }}
            className="ui-input w-full h-[36px] px-2.5 leading-tight text-sm inline-flex items-center justify-between disabled:cursor-not-allowed disabled:opacity-45"
            style={{
              borderColor: lockActivationToggles
                ? 'var(--border-subtle)'
                : customSettingsEnabled
                ? 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 36%)'
                : 'var(--border-subtle)',
              background: lockActivationToggles
                ? 'var(--surface-2)'
                : customSettingsEnabled
                ? 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 90%)'
                : 'var(--surface-1)',
              color: lockActivationToggles
                ? 'var(--text-muted)'
                : customSettingsEnabled ? 'var(--text-strong)' : 'var(--text-muted)',
              opacity: lockActivationToggles ? 0.72 : 1,
            }}
          >
            <span className="font-medium">Custom Settings</span>
            <span
              className="inline-flex h-5 w-9 rounded-full p-0.5 transition-colors"
              style={{ background: lockActivationToggles ? 'var(--surface-3)' : customSettingsEnabled ? 'var(--accent-secondary)' : 'var(--surface-2)' }}
            >
              <span
                className={`h-4 w-4 rounded-full bg-white transition-transform ${customSettingsEnabled ? 'translate-x-4' : 'translate-x-0'}`}
                style={{ background: lockActivationToggles ? 'var(--text-muted)' : 'white' }}
              />
            </span>
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={overrideEnabled}
            disabled={!customSettingsEnabled || lockActivationToggles}
            onClick={() => {
              if (lockActivationToggles) return;
              updateAaSettings({ enableOverride: !overrideEnabled });
            }}
            className="ui-input w-full h-[36px] px-2.5 leading-tight text-sm inline-flex items-center justify-between disabled:cursor-not-allowed disabled:opacity-45"
            style={{
              borderColor: lockActivationToggles
                ? 'var(--border-subtle)'
                : overrideEnabled
                ? 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 36%)'
                : 'var(--border-subtle)',
              background: lockActivationToggles
                ? 'var(--surface-2)'
                : overrideEnabled
                ? 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 90%)'
                : 'var(--surface-1)',
              color: lockActivationToggles
                ? 'var(--text-muted)'
                : overrideEnabled ? 'var(--text-strong)' : 'var(--text-muted)',
              opacity: lockActivationToggles ? 0.72 : 1,
            }}
          >
            <span className="font-medium">Override Auto</span>
            <span
              className="inline-flex h-5 w-9 rounded-full p-0.5 transition-colors"
              style={{ background: lockActivationToggles ? 'var(--surface-3)' : overrideEnabled ? 'var(--accent-secondary)' : 'var(--surface-2)' }}
            >
              <span
                className={`h-4 w-4 rounded-full bg-white transition-transform ${overrideEnabled ? 'translate-x-4' : 'translate-x-0'}`}
                style={{ background: lockActivationToggles ? 'var(--text-muted)' : 'white' }}
              />
            </span>
          </button>
        </div>
      </AaCard>

      <AaCard
        disabled={!customSettingsEnabled}
        title="Anti-Aliasing Type"
        description="Off disables grayscale AA. 2D Blur smooths XY edges. 3D AA adds Z perturbation sampling through the layer height for smoother vertical transitions."
      >
        <AaSelectDropdown
          label=""
          value={settings.mode}
          disabled={!customSettingsEnabled}
          helpText="Off keeps exported pixels binary. 2D Blur applies XY grayscale edge smoothing. 3D AA samples through Z for smoother vertical transitions."
          onChange={(value) => updateAaSettings({ mode: value as MaterialAntiAliasingSettings['mode'] })}
          options={[
            { value: 'Off', label: 'Off' },
            { value: 'Blur', label: '2D Blur' },
            { value: '3DAA', label: '3D AA' },
          ]}
        />
      </AaCard>

      {!customSettingsEnabled && (
        <div
          className="md:col-span-2 rounded-xl border px-3 py-2 text-xs"
          style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)' }}
        >
          Auto AA is active for this material. Enable Custom Settings to store material-specific AA tuning without applying it yet.
        </div>
      )}
      {customSettingsEnabled && !overrideEnabled && (
        <div
          className="md:col-span-2 rounded-xl border px-3 py-2 text-xs"
          style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)' }}
        >
          Custom AA settings are saved on this material, but Auto AA is still used until Override AA Settings is enabled.
        </div>
      )}
      {customSettingsEnabled && settings.mode === 'Off' && (
        <div
          className="md:col-span-2 rounded-xl border px-3 py-2 text-xs"
          style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)' }}
        >
          These custom settings turn anti-aliasing off. Choose 2D Blur or 3D AA to tune smoothing.
        </div>
      )}
      {customSettingsEnabled && settings.mode !== 'Off' && (
        <>
          <AaCard
            title={is3daa ? '3D AA Sample Count' : 'Sample Count'}
            description={is3daa
              ? 'Controls the total 3D AA perturbation samples. Higher values can smooth shallow slopes and thin layers, but increase raster time.'
              : 'Controls XY supersampling strength. Higher values create smoother edges and curves, but take longer to rasterize.'}
          >
            <AaSelectDropdown
              label="Preset"
              value={settings.useCustomLevel ? 'custom' : settings.level}
              helpText="Choose a common AA sample count. Higher values are smoother and slower."
              onChange={(value) => {
                if (value === 'custom') {
                  updateAaSettings({ useCustomLevel: true });
                  return;
                }
                updateAaSettings({ level: value, useCustomLevel: false });
              }}
              options={[
                ...AA_STRENGTH_PRESETS.map((steps) => ({ value: formatAaLevel(steps), label: formatAaLevel(steps) })),
                { value: 'custom', label: 'Custom' },
              ]}
            />
            {customStrengthEnabled && (
              <LabeledNumberInput
                label="Custom AA strength"
                helpText="Custom sample count, expressed as N x. Keep this near the preset range unless you are validating a specific material and printer combination."
                value={sampleSteps}
                onChange={(value) => updateAaSettings({ level: formatAaLevel(value), useCustomLevel: true })}
              />
            )}
          </AaCard>

          <AaCard
            title={is3daa ? 'XY Blur' : 'Edge Blur'}
            description={is3daa
              ? 'Applies a post-AA XY blur to soften pixel stair-stepping after 3D AA sampling. Set 0 px with Custom to disable blur.'
              : 'Applies a grayscale edge blur after rasterization. Wider blur softens edges more, but can reduce fine detail.'}
          >
            <AaSelectDropdown
              label="Width"
              value={settings.useCustomBlurBrushRadius ? 'custom' : String(settings.blurBrushRadiusPx)}
              helpText="Choose how many pixels the XY grayscale blur spreads from the source edge."
              onChange={(value) => {
                if (value === 'custom') {
                  updateAaSettings({ useCustomBlurBrushRadius: true });
                  return;
                }
                updateAaSettings({ blurBrushRadiusPx: Number(value), useCustomBlurBrushRadius: false });
              }}
              options={[
                ...BLUR_WIDTH_PRESETS.map((radius) => ({ value: String(radius), label: `${radius}px` })),
                { value: 'custom', label: 'Custom' },
              ]}
            />
            {customXyBlurEnabled && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <LabeledNumberInput
                  label="Radius (px)"
                  helpText="Blur radius in pixels. 0 disables the XY blur pass; larger values spread grayscale farther from the original edge."
                  value={settings.blurBrushRadiusPx}
                  onChange={(value) => updateAaSettings({ blurBrushRadiusPx: Math.round(clampAaNumber(value, 1, 0, 64)), useCustomBlurBrushRadius: true })}
                />
                <AaSelectDropdown
                  label="Kernel"
                  value={settings.blurBrushKernel}
                  helpText="Box is a hard average. Gaussian weights the center more heavily and usually gives a smoother resin-friendly falloff."
                  onChange={(value) => updateAaSettings({ blurBrushKernel: value === 'box' ? 'box' : 'gaussian' })}
                  options={[{ value: 'box', label: 'Box' }, { value: 'gaussian', label: 'Gaussian' }]}
                />
                {gaussianXyEnabled && (
                  <>
                    <LabeledNumberInput
                      label="Sigma X"
                      helpText="Horizontal Gaussian falloff. Larger values spread the grayscale gradient farther in X."
                      value={settings.blurBrushSigmaX}
                      onChange={(value) => updateAaSettings({ blurBrushSigmaX: clampAaNumber(value, 0.5, 0.05, 16) })}
                    />
                    <LabeledNumberInput
                      label="Sigma Y"
                      helpText="Vertical Gaussian falloff. Larger values spread the grayscale gradient farther in Y."
                      value={settings.blurBrushSigmaY}
                      onChange={(value) => updateAaSettings({ blurBrushSigmaY: clampAaNumber(value, 0.5, 0.05, 16) })}
                    />
                  </>
                )}
              </div>
            )}
          </AaCard>

          {is3daa && (
            <>
              <AaCard
                title="3D AA Sampling"
                description="Controls how 3D AA distributes Z samples inside each layer."
              >
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  <AaSelectDropdown
                    label="Pattern"
                    value={settings.zaaPattern}
                    helpText="Uniform uses centered spacing, Halton uses a low-discrepancy sequence, and Base2 uses a van der Corput sequence."
                    onChange={(value) => updateAaSettings({ zaaPattern: value as MaterialAntiAliasingSettings['zaaPattern'] })}
                    options={[
                      { value: 'uniform', label: 'Uniform' },
                      { value: 'halton', label: 'Halton' },
                      { value: 'base2', label: 'Base2' },
                    ]}
                  />
                  <LabeledToggleInput
                    label="Duplicate Terminal Z"
                    helpText="Available at 16x and above. Pairs half of the Y perturbations at the same Z height to reduce triangle lookups for high sample counts."
                    checked={settings.zaaDuplicateZ}
                    disabled={!duplicateZEnabled}
                    onChange={(value) => updateAaSettings({ zaaDuplicateZ: value })}
                  />
                </div>
              </AaCard>

              <AaCard
                title="3D AA Z Blur"
                description="Applies grayscale blur across neighboring layers after 3D AA sampling. The radius is symmetric: 2 layers means 2 look-behind layers, the current layer, and 2 look-ahead layers are included."
              >
                <AaSelectDropdown
                  label="Radius"
                  value={settings.useCustomZBlurRadius ? 'custom' : String(settings.zBlurRadiusLayers)}
                  helpText="Choose the symmetric Z blur radius. For example, 2 layers uses 2 previous layers, the current layer, and 2 future layers."
                  onChange={(value) => {
                    if (value === 'custom') {
                      updateAaSettings({ useCustomZBlurRadius: true });
                      return;
                    }
                    updateAaSettings({ zBlurRadiusLayers: Number(value), useCustomZBlurRadius: false });
                  }}
                  options={[
                    { value: '0', label: 'Off' },
                    ...Z_BLUR_RADIUS_PRESETS.map((layers) => ({ value: String(layers), label: `${layers} layers` })),
                    { value: 'custom', label: 'Custom' },
                  ]}
                />
                {customZBlurEnabled && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <LabeledNumberInput
                      label="Custom radius"
                      helpText="Number of look-behind and look-ahead layers used for Z blur. 0 disables the Z blur pass."
                      value={settings.zBlurRadiusLayers}
                      onChange={(value) => updateAaSettings({ zBlurRadiusLayers: Math.round(clampAaNumber(value, 0, 0, 8)), useCustomZBlurRadius: true })}
                    />
                    <AaSelectDropdown
                      label="Kernel"
                      value={settings.zBlurKernel}
                      helpText="Box averages layers evenly. Gaussian weights nearby layers more strongly."
                      onChange={(value) => updateAaSettings({ zBlurKernel: value === 'gaussian' ? 'gaussian' : 'box' })}
                      options={[{ value: 'box', label: 'Box' }, { value: 'gaussian', label: 'Gaussian' }]}
                    />
                    {gaussianZEnabled && (
                      <LabeledNumberInput
                        label="Sigma"
                        helpText="Gaussian falloff for Z blur. Larger values spread grayscale across more of the selected layer window."
                        value={settings.zBlurSigma}
                        onChange={(value) => updateAaSettings({ zBlurSigma: clampAaNumber(value, 0.5, 0.05, 16) })}
                      />
                    )}
                  </div>
                )}
              </AaCard>
            </>
          )}

          <AaCard
            title="Grayscale Mapping"
            description="LUT Curve is the recommended grayscale path. Minimum Grey remains available for threshold-style resin tuning."
          >
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <AaSelectDropdown
                label="Source"
                value={settings.blurGraySourceMode}
                helpText="LUT Curve is the recommended grayscale path. Minimum Grey uses a threshold-style lower bound."
                onChange={(value) => updateAaSettings({ blurGraySourceMode: value === 'minimum' ? 'minimum' : 'lut' })}
                options={[{ value: 'lut', label: 'LUT Curve' }, { value: 'minimum', label: 'Minimum Grey' }]}
              />
              {settings.blurGraySourceMode === 'lut' ? (
                <>
                  <AaSelectDropdown
                    label="Curve"
                    value={settings.zBlendResinType}
                    helpText="Opaque uses a stronger curve for standard resins. Clear uses a gentler curve for translucent materials. Custom lets you pick or edit a saved LUT curve."
                    onChange={(value) => updateAaSettings({
                      zBlendResinType: value === 'clear' || value === 'custom' ? value : 'opaque',
                    })}
                    options={[
                      { value: 'opaque', label: 'Opaque' },
                      { value: 'clear', label: 'Clear' },
                      { value: 'custom', label: 'Custom' },
                    ]}
                  />
                  {settings.zBlendResinType === 'custom' && (
                    <div className="md:col-span-2">
                      <LutCurveSelector
                        variant="settings"
                        savedCurves={savedCurves}
                        selectedCurveId={settings.selectedLutCurveId}
                        onSelectCurve={(id) => updateAaSettings({ selectedLutCurveId: id })}
                        onOpenEditor={(id) => setEditingTarget(id ?? NEW_CURVE_EDITING_TARGET)}
                      />
                    </div>
                  )}
                  <LutCurveEditorModal
                    isOpen={editingTarget !== null}
                    savedCurves={savedCurves}
                    selectedCurveId={settings.selectedLutCurveId}
                    onSelectCurve={(id) => updateAaSettings({ selectedLutCurveId: id })}
                    onImportCurve={(curve) => {
                      const importedId = curve.id.trim() || crypto.randomUUID();
                      const normalizedName = curve.name.trim() || 'Imported Curve';
                      setSavedCurves((prev) => {
                        const lowerNames = new Set(prev.map((entry) => entry.name.trim().toLowerCase()));
                        let finalName = normalizedName;
                        let suffix = 2;
                        while (lowerNames.has(finalName.trim().toLowerCase())) {
                          finalName = `${normalizedName} (${suffix})`;
                          suffix += 1;
                        }
                        return [...prev, { ...curve, id: importedId, name: finalName }];
                      });
                      updateAaSettings({ selectedLutCurveId: importedId });
                      setEditingTarget(importedId);
                    }}
                    editingCurve={
                      editingTarget === null || editingTarget === NEW_CURVE_EDITING_TARGET
                        ? null
                        : (savedCurves.find((curve) => curve.id === editingTarget) ?? null)
                    }
                    onSave={(curve) => {
                      setSavedCurves((prev) => (
                        prev.some((entry) => entry.id === curve.id)
                          ? prev.map((entry) => entry.id === curve.id ? curve : entry)
                          : [...prev, curve]
                      ));
                      updateAaSettings({ selectedLutCurveId: curve.id });
                      setEditingTarget(null);
                    }}
                    onDelete={(id) => {
                      const next = savedCurves.filter((curve) => curve.id !== id);
                      const fallback = next.length > 0
                        ? next
                        : [{ ...DEFAULT_SAVED_CURVES[0], id: crypto.randomUUID(), points: [...DEFAULT_CUSTOM_CURVE] }];
                      const nextSelectedId = settings.selectedLutCurveId === id
                        ? fallback[0].id
                        : (fallback.some((curve) => curve.id === settings.selectedLutCurveId)
                            ? settings.selectedLutCurveId
                            : fallback[0].id);
                      setSavedCurves(fallback);
                      updateAaSettings({ selectedLutCurveId: nextSelectedId });
                      setEditingTarget(nextSelectedId);
                    }}
                    onClose={() => setEditingTarget(null)}
                  />
                </>
              ) : (
                <LabeledNumberInput
                  label="Minimum Grey Level"
                  helpText="Minimum pixel intensity used by AA gradients. Higher values make faint grayscale pixels cure more strongly."
                  value={draft.minimumAaAlphaPercent}
                  onChange={(value) => onChange((prev) => ({ ...prev, minimumAaAlphaPercent: Math.max(0, Math.min(100, value)) }))}
                />
              )}
            </div>
          </AaCard>

          <AaCard
            title="AA on Supports"
            description="Controls whether native support and raft geometry receives grayscale AA in the selected mode."
          >
            <LabeledToggleInput
              label="Apply AA to Support Geometry"
              helpText="Disabled keeps supports crisp and binary. Enabled allows anti-aliased support edges too."
              checked={settings.aaOnSupports}
              onChange={(value) => updateAaSettings({ aaOnSupports: value })}
            />
          </AaCard>

          <AaCard
            title="Grayscale Dithering"
            description="Floyd-Steinberg energy-based dithering maps intermediate gray values to high-frequency spatial patterns, preventing color banding on gradient slopes."
          >
            <div className="grid grid-cols-1 gap-2">
              <LabeledToggleInput
                label="Enable Dithering"
                helpText="Enable energy-based dithering to eliminate banding on shallow slopes."
                checked={settings.ditherEnabled}
                onChange={(value) => updateAaSettings({ ditherEnabled: value })}
              />
              {settings.ditherEnabled && (
                <>
                  <div className="space-y-1 block">
                    <span className="ui-label font-medium inline-flex items-center gap-1.5">
                      Bit Depth Presets
                      <AaHelpIcon label="Bit Depth" text="Target bit depth for spatial dithering. 3-bit matches 8 gray levels, 4-bit matches 16 levels." />
                    </span>
                    <div className="flex gap-1.5 mt-1">
                      <PresetButton
                        active={settings.ditherBitDepth === 3}
                        onClick={() => updateAaSettings({ ditherBitDepth: 3 })}
                      >
                        3-bit (8 levels)
                      </PresetButton>
                      <PresetButton
                        active={settings.ditherBitDepth === 4}
                        onClick={() => updateAaSettings({ ditherBitDepth: 4 })}
                      >
                        4-bit (16 levels)
                      </PresetButton>
                      <PresetButton
                        active={settings.ditherBitDepth !== 3 && settings.ditherBitDepth !== 4}
                        onClick={() => updateAaSettings({ ditherBitDepth: 5 })}
                      >
                        Custom
                      </PresetButton>
                    </div>
                  </div>
                  {settings.ditherBitDepth !== 3 && settings.ditherBitDepth !== 4 && (
                    <LabeledNumberInput
                      label="Custom Bit Depth"
                      helpText="Bit depth for dithering, clamped between 2 and 7 bits."
                      value={settings.ditherBitDepth}
                      onChange={(value) => updateAaSettings({ ditherBitDepth: Math.max(2, Math.min(7, Math.round(value))) })}
                    />
                  )}
                  <LabeledNumberInput
                    label="Device Gamma"
                    helpText="Gamma value of the printer LCD panel. Corrects dithering intensity to match physical light projection."
                    value={settings.ditherDeviceGamma}
                    onChange={(value) => updateAaSettings({ ditherDeviceGamma: clampAaNumber(value, 3.0, 0.5, 4.0) })}
                  />
                </>
              )}
            </div>
          </AaCard>
        </>
      )}
    </div>
  );
}

function MaterialAntiAliasingSectionDense({ draft, onChange }: MaterialAntiAliasingSectionProps) {
  const settings = {
    ...DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS,
    ...(draft.antiAliasingSettings ?? {}),
  };
  const overrideEnabled = settings.enableOverride === true;
  const aaEnabled = overrideEnabled && settings.mode !== 'Off';
  const is3daa = overrideEnabled && settings.mode === '3DAA';
  const sampleSteps = parseAaLevelSteps(settings.level);
  const customStrengthEnabled = aaEnabled && settings.useCustomLevel;
  const customXyBlurEnabled = aaEnabled && settings.useCustomBlurBrushRadius;
  const gaussianXyEnabled = customXyBlurEnabled && settings.blurBrushKernel === 'gaussian' && settings.blurBrushRadiusPx > 0;
  const duplicateZEnabled = is3daa && sampleSteps >= 16;
  const customLookBackEnabled = is3daa && settings.useCustomZBlendLookBack;
  const manualFadeEnabled = is3daa && settings.zBlendFadeMode === 'manual';
  const customZBlurEnabled = is3daa && settings.useCustomZBlurRadius;
  const gaussianZEnabled = customZBlurEnabled && settings.zBlurKernel === 'gaussian' && settings.zBlurRadiusLayers > 0;

  const updateAaSettings = React.useCallback((patch: Partial<MaterialAntiAliasingSettings>) => {
    onChange((prev) => ({
      ...prev,
      antiAliasingSettings: {
        ...DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS,
        ...(prev.antiAliasingSettings ?? {}),
        ...patch,
      },
    }));
  }, [onChange]);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
      <AaCard
        title="Anti-Aliasing Settings"
        description="By default, material profiles defer to the slicer's Auto AA settings. Enable this only when a material needs its own tuned anti-aliasing behavior."
      >
        <LabeledToggleInput
          label="Enable Anti-Aliasing Override"
          helpText="When disabled, DragonFruit ignores this material profile's AA settings and uses the slicer's Auto AA configuration."
          checked={overrideEnabled}
          onChange={(value) => updateAaSettings({ enableOverride: value })}
        />
      </AaCard>

      <AaCard
        disabled={!overrideEnabled}
        title="Anti-Aliasing Type"
        description="Off disables grayscale AA. 2D Blur smooths XY edges. 3D AA adds Z perturbation sampling through the layer height for smoother vertical transitions."
      >
        <div className="grid grid-cols-1 gap-2">
          <AaSelectDropdown
            label="Type"
            value={settings.mode}
            disabled={!overrideEnabled}
            helpText="Off keeps exported pixels binary. 2D Blur applies XY grayscale edge smoothing. 3D AA samples through Z for smoother vertical transitions."
            onChange={(value) => updateAaSettings({ mode: value as MaterialAntiAliasingSettings['mode'] })}
            options={[
              { value: 'Off', label: 'Off' },
              { value: 'Blur', label: '2D Blur' },
              { value: '3DAA', label: '3D AA' },
            ]}
          />
        </div>
      </AaCard>

      <AaCard
        disabled={!aaEnabled}
        title={is3daa ? '3DAA Sample Count' : 'XY Sample Count'}
        description={is3daa
          ? 'Controls the total 3DAA perturbation samples. Higher values can smooth shallow slopes and thin layers, but increase raster time.'
          : 'Controls XY supersampling strength. Higher values create smoother edges and curves, but take longer to rasterize.'}
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <AaSelectDropdown
            label="Preset strength"
            value={settings.useCustomLevel ? 'custom' : settings.level}
            disabled={!aaEnabled}
            helpText="Choose a common AA sample count. Higher values are smoother and slower."
            onChange={(value) => {
              if (value === 'custom') {
                updateAaSettings({ useCustomLevel: true });
                return;
              }
              updateAaSettings({ level: value, useCustomLevel: false });
            }}
            options={[
              ...AA_STRENGTH_PRESETS.map((steps) => ({ value: formatAaLevel(steps), label: formatAaLevel(steps) })),
              { value: 'custom', label: 'Custom' },
            ]}
          />
        </div>
        <LabeledNumberInput
          label="Custom AA strength"
          helpText="Custom sample count, expressed as N x. Keep this near the preset range unless you are validating a specific material and printer combination."
          disabled={!customStrengthEnabled}
          value={sampleSteps}
          onChange={(value) => updateAaSettings({ level: formatAaLevel(value), useCustomLevel: true })}
        />
      </AaCard>

      <AaCard
        disabled={!aaEnabled}
        title={is3daa ? 'XY Blur Radius' : 'Edge Blur Width'}
        description={is3daa
          ? 'Applies a post-AA XY blur to soften pixel stair-stepping after 3DAA sampling. Set 0 px with Custom to disable blur.'
          : 'Applies a grayscale edge blur after rasterization. Wider blur softens edges more, but can reduce fine detail.'}
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <AaSelectDropdown
            label="Preset width"
            value={settings.useCustomBlurBrushRadius ? 'custom' : String(settings.blurBrushRadiusPx)}
            disabled={!aaEnabled}
            helpText="Choose how many pixels the XY grayscale blur spreads from the source edge."
            onChange={(value) => {
              if (value === 'custom') {
                updateAaSettings({ useCustomBlurBrushRadius: true });
                return;
              }
              updateAaSettings({ blurBrushRadiusPx: Number(value), useCustomBlurBrushRadius: false });
            }}
            options={[
              ...BLUR_WIDTH_PRESETS.map((radius) => ({ value: String(radius), label: `${radius}px` })),
              { value: 'custom', label: 'Custom' },
            ]}
          />
          <LabeledNumberInput
            label="Custom blur radius (px)"
            helpText="Blur radius in pixels. 0 disables the XY blur pass; larger values spread grayscale farther from the original edge."
            disabled={!customXyBlurEnabled}
            value={settings.blurBrushRadiusPx}
            onChange={(value) => updateAaSettings({ blurBrushRadiusPx: Math.round(clampAaNumber(value, 1, 0, 64)), useCustomBlurBrushRadius: true })}
          />
          <AaSelectDropdown
            label="Kernel"
            value={settings.blurBrushKernel}
            disabled={!customXyBlurEnabled}
            helpText="Box is a hard average. Gaussian weights the center more heavily and usually gives a smoother resin-friendly falloff."
            onChange={(value) => updateAaSettings({ blurBrushKernel: value === 'box' ? 'box' : 'gaussian' })}
            options={[{ value: 'box', label: 'Box' }, { value: 'gaussian', label: 'Gaussian' }]}
          />
          <LabeledNumberInput
            label="Sigma X"
            helpText="Horizontal Gaussian falloff. Larger values spread the grayscale gradient farther in X."
            disabled={!gaussianXyEnabled}
            value={settings.blurBrushSigmaX}
            onChange={(value) => updateAaSettings({ blurBrushSigmaX: clampAaNumber(value, 0.5, 0.05, 16) })}
          />
          <LabeledNumberInput
            label="Sigma Y"
            helpText="Vertical Gaussian falloff. Larger values spread the grayscale gradient farther in Y."
            disabled={!gaussianXyEnabled}
            value={settings.blurBrushSigmaY}
            onChange={(value) => updateAaSettings({ blurBrushSigmaY: clampAaNumber(value, 0.5, 0.05, 16) })}
          />
        </div>
      </AaCard>

      <AaCard
        disabled={!is3daa}
        title="3DAA Sampling"
        description="Controls how 3DAA distributes Z samples inside each layer."
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <AaSelectDropdown
            label="Pattern"
            value={settings.zaaPattern}
            disabled={!is3daa}
            helpText="Uniform uses centered spacing, Halton uses a low-discrepancy sequence, and Base2 uses a van der Corput sequence."
            onChange={(value) => updateAaSettings({ zaaPattern: value as MaterialAntiAliasingSettings['zaaPattern'] })}
            options={[
              { value: 'uniform', label: 'Uniform' },
              { value: 'halton', label: 'Halton' },
              { value: 'base2', label: 'Base2' },
            ]}
          />
          <LabeledToggleInput
            label="Duplicate Terminal Z"
            helpText="Available at 16x and above. Pairs half of the Y perturbations at the same Z height to reduce triangle lookups for high sample counts."
            checked={settings.zaaDuplicateZ}
            disabled={!duplicateZEnabled}
            onChange={(value) => updateAaSettings({ zaaDuplicateZ: value })}
          />
        </div>
      </AaCard>

      <AaCard
        disabled={!is3daa}
        title="3DAA Blend Window"
        description="Controls how far 3DAA looks across neighboring layers and how quickly grayscale fades at Z transitions."
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <AaSelectDropdown
            label="Look-back preset"
            value={settings.useCustomZBlendLookBack ? 'custom' : String(settings.zBlendLookBack)}
            disabled={!is3daa}
            helpText="Choose how many earlier layers are considered when blending 3DAA grayscale."
            onChange={(value) => {
              if (value === 'custom') {
                updateAaSettings({ useCustomZBlendLookBack: true });
                return;
              }
              updateAaSettings({ zBlendLookBack: Number(value), useCustomZBlendLookBack: false });
            }}
            options={[
              ...LOOK_BACK_PRESETS.map((layers) => ({ value: String(layers), label: `${layers} layers` })),
              { value: 'custom', label: 'Custom' },
            ]}
          />
          <LabeledNumberInput
            label="Look-back layers"
            helpText="Number of earlier layers considered when blending 3DAA grayscale. Larger windows can smooth slow Z transitions, but may over-soften details."
            disabled={!customLookBackEnabled}
            value={settings.zBlendLookBack}
            onChange={(value) => updateAaSettings({ zBlendLookBack: Math.round(clampAaNumber(value, 2, 1, 16)), useCustomZBlendLookBack: true })}
          />
          <AaSelectDropdown
            label="Fade mode"
            value={settings.zBlendFadeMode}
            disabled={!is3daa}
            helpText="Auto lets the engine derive fade distance. Manual uses the pixel distance below."
            onChange={(value) => updateAaSettings({
              zBlendFadeMode: value === 'manual' ? 'manual' : 'auto',
              useCustomZBlendFadePx: value === 'manual',
            })}
            options={[{ value: 'auto', label: 'Auto fade' }, { value: 'manual', label: 'Manual fade' }]}
          />
          <LabeledNumberInput
            label="Fade distance (px)"
            helpText="Manual pixel distance for the 3DAA grayscale fade. Higher values create a longer, softer transition."
            disabled={!manualFadeEnabled}
            value={settings.zBlendFadePx}
            onChange={(value) => updateAaSettings({ zBlendFadePx: Math.round(clampAaNumber(value, 20, 1, 256)), useCustomZBlendFadePx: true })}
          />
          <LabeledToggleInput
            label="3DAA Auto Mode"
            helpText="Lets the engine derive blend-window behavior from the current material layer height and printer pixel pitch."
            checked={settings.zBlendAutoMode}
            disabled={!is3daa}
            onChange={(value) => updateAaSettings({ zBlendAutoMode: value })}
          />
        </div>
      </AaCard>

      <AaCard
        disabled={!is3daa}
        title="3DAA Z Blur"
        description="Applies grayscale blur across neighboring layers after 3DAA sampling."
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <AaSelectDropdown
            label="Radius preset"
            value={settings.useCustomZBlurRadius ? 'custom' : String(settings.zBlurRadiusLayers)}
            disabled={!is3daa}
            helpText="Choose how many adjacent layers are used by the Z blur pass."
            onChange={(value) => {
              if (value === 'custom') {
                updateAaSettings({ useCustomZBlurRadius: true });
                return;
              }
              updateAaSettings({ zBlurRadiusLayers: Number(value), useCustomZBlurRadius: false });
            }}
            options={[
              ...Z_BLUR_RADIUS_PRESETS.map((layers) => ({ value: String(layers), label: `${layers} layers` })),
              { value: 'custom', label: 'Custom' },
            ]}
          />
          <LabeledNumberInput
            label="Custom Z blur radius"
            helpText="Number of adjacent layers used for Z blur. 0 disables the Z blur pass."
            disabled={!customZBlurEnabled}
            value={settings.zBlurRadiusLayers}
            onChange={(value) => updateAaSettings({ zBlurRadiusLayers: Math.round(clampAaNumber(value, 0, 0, 8)), useCustomZBlurRadius: true })}
          />
          <AaSelectDropdown
            label="Kernel"
            value={settings.zBlurKernel}
            disabled={!customZBlurEnabled}
            helpText="Box averages layers evenly. Gaussian weights nearby layers more strongly."
            onChange={(value) => updateAaSettings({ zBlurKernel: value === 'gaussian' ? 'gaussian' : 'box' })}
            options={[{ value: 'box', label: 'Box' }, { value: 'gaussian', label: 'Gaussian' }]}
          />
          <LabeledNumberInput
            label="Sigma"
            helpText="Gaussian falloff for Z blur. Larger values spread grayscale across more of the selected layer window."
            disabled={!gaussianZEnabled}
            value={settings.zBlurSigma}
            onChange={(value) => updateAaSettings({ zBlurSigma: clampAaNumber(value, 0.5, 0.05, 16) })}
          />
        </div>
      </AaCard>

      <AaCard
        disabled={!aaEnabled}
        title="Grayscale Mapping"
        description="LUT Curve is the recommended grayscale path. Minimum Grey remains available for threshold-style resin tuning."
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <AaSelectDropdown
            label="Source"
            value={settings.blurGraySourceMode}
            disabled={!aaEnabled}
            helpText="LUT Curve is the recommended grayscale path. Minimum Grey uses a threshold-style lower bound."
            onChange={(value) => updateAaSettings({ blurGraySourceMode: value === 'minimum' ? 'minimum' : 'lut' })}
            options={[{ value: 'lut', label: 'LUT Curve' }, { value: 'minimum', label: 'Minimum Grey' }]}
          />
          <AaSelectDropdown
            label="Resin curve"
            value={settings.zBlendResinType}
            disabled={!aaEnabled || settings.blurGraySourceMode !== 'lut'}
            helpText="Opaque uses a stronger cure-response curve for standard resins. Clear uses a gentler curve for translucent materials."
            onChange={(value) => updateAaSettings({ zBlendResinType: value === 'clear' ? 'clear' : 'opaque' })}
            options={[{ value: 'opaque', label: 'Opaque' }, { value: 'clear', label: 'Clear' }]}
          />
          <LabeledNumberInput
            label="Minimum Grey Level"
            helpText="Minimum pixel intensity used by AA gradients. Higher values make faint grayscale pixels cure more strongly."
            disabled={!aaEnabled || settings.blurGraySourceMode !== 'minimum'}
            value={draft.minimumAaAlphaPercent}
            onChange={(value) => onChange((prev) => ({ ...prev, minimumAaAlphaPercent: Math.max(0, Math.min(100, value)) }))}
          />
        </div>
      </AaCard>

      <AaCard
        disabled={!aaEnabled}
        title="AA on Supports"
        description="Controls whether native support and raft geometry receives grayscale AA in the selected mode."
      >
        <LabeledToggleInput
          label="AA on Supports"
          helpText="Disabled keeps supports crisp and binary. Enabled allows anti-aliased support edges too."
          checked={settings.aaOnSupports}
          disabled={!aaEnabled}
          onChange={(value) => updateAaSettings({ aaOnSupports: value })}
        />
      </AaCard>
    </div>
  );
}

function MaterialAntiAliasingSectionLegacy({ draft, onChange }: MaterialAntiAliasingSectionProps) {
  const settings = {
    ...DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS,
    ...(draft.antiAliasingSettings ?? {}),
  };

  const updateAaSettings = React.useCallback((patch: Partial<MaterialAntiAliasingSettings>) => {
    onChange((prev) => ({
      ...prev,
      antiAliasingSettings: {
        ...DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS,
        ...(prev.antiAliasingSettings ?? {}),
        ...patch,
      },
    }));
  }, [onChange]);

  return (
    <>
      <AaCard
        title="Anti-Aliasing Mode"
        description="Off disables grayscale AA. Blur smooths XY edges. 3DAA adds Z perturbation sampling through the layer height for smoother vertical transitions."
      >
        <div className="grid grid-cols-3 gap-1">
          {(['Off', 'Blur', '3DAA'] as const).map((mode) => (
            <PresetButton key={mode} active={settings.mode === mode} onClick={() => updateAaSettings({ mode })}>
              {mode}
            </PresetButton>
          ))}
        </div>
      </AaCard>

      {settings.mode !== 'Off' && (
        <AaCard
          title={settings.mode === '3DAA' ? '3DAA Sample Count' : 'XY Sample Count'}
          description={settings.mode === '3DAA'
            ? 'Controls the total 3DAA perturbation samples. Higher values can smooth shallow slopes and thin layers, but increase raster time.'
            : 'Controls XY supersampling strength. Higher values create smoother edges and curves, but take longer to rasterize.'}
        >
          <div className="grid grid-cols-5 gap-1">
            {AA_STRENGTH_PRESETS.map((steps) => {
              const level = formatAaLevel(steps);
              return (
                <PresetButton key={level} active={!settings.useCustomLevel && settings.level === level} onClick={() => updateAaSettings({ level, useCustomLevel: false })}>
                  {level}
                </PresetButton>
              );
            })}
            <PresetButton active={settings.useCustomLevel} onClick={() => updateAaSettings({ useCustomLevel: true })}>Custom</PresetButton>
          </div>
          {settings.useCustomLevel && (
            <LabeledNumberInput
              label="Custom AA strength"
              helpText="Custom sample count, expressed as N x. Keep this near the preset range unless you are validating a specific material and printer combination."
              value={parseAaLevelSteps(settings.level)}
              onChange={(value) => updateAaSettings({ level: formatAaLevel(value), useCustomLevel: true })}
            />
          )}
        </AaCard>
      )}

      {settings.mode === '3DAA' && (
        <AaCard
          title="3DAA Sampling"
          description="Controls how 3DAA distributes Z samples inside each layer."
        >
          <div className="grid grid-cols-3 gap-1">
            {([['uniform', 'Uniform'], ['halton', 'Halton'], ['base2', 'Base2']] as const).map(([pattern, label]) => (
              <PresetButton key={pattern} active={settings.zaaPattern === pattern} onClick={() => updateAaSettings({ zaaPattern: pattern })}>{label}</PresetButton>
            ))}
          </div>
          <AaInlineHelp>Uniform uses centered spacing, Halton uses a low-discrepancy sequence, and Base2 uses a van der Corput sequence.</AaInlineHelp>
          {parseAaLevelSteps(settings.level) >= 16 && (
            <LabeledToggleInput label="Duplicate Terminal Z" checked={settings.zaaDuplicateZ} onChange={(value) => updateAaSettings({ zaaDuplicateZ: value })} />
          )}
          {parseAaLevelSteps(settings.level) >= 16 && (
            <AaInlineHelp>Duplicate Terminal Z pairs half of the Y perturbations at the same Z height, reducing triangle lookups for high sample counts.</AaInlineHelp>
          )}
        </AaCard>
      )}

      {settings.mode !== 'Off' && (
        <AaCard
          title={settings.mode === '3DAA' ? 'XY Blur Radius' : 'Edge Blur Width'}
          description={settings.mode === '3DAA'
            ? 'Applies a post-AA XY blur to soften pixel stair-stepping after 3DAA sampling. Set 0 px with Custom to disable blur.'
            : 'Applies a grayscale edge blur after rasterization. Wider blur softens edges more, but can reduce fine detail.'}
        >
          <div className="grid grid-cols-5 gap-1">
            {BLUR_WIDTH_PRESETS.map((radius) => (
              <PresetButton key={radius} active={!settings.useCustomBlurBrushRadius && settings.blurBrushRadiusPx === radius} onClick={() => updateAaSettings({ blurBrushRadiusPx: radius, useCustomBlurBrushRadius: false })}>{radius}px</PresetButton>
            ))}
            <PresetButton active={settings.useCustomBlurBrushRadius} onClick={() => updateAaSettings({ useCustomBlurBrushRadius: true })}>Custom</PresetButton>
          </div>
          {settings.useCustomBlurBrushRadius && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <LabeledNumberInput
                label="Custom blur radius (px)"
                helpText="Blur radius in pixels. 0 disables the XY blur pass; larger values spread grayscale farther from the original edge."
                value={settings.blurBrushRadiusPx}
                onChange={(value) => updateAaSettings({ blurBrushRadiusPx: Math.round(clampAaNumber(value, 1, 0, 64)), useCustomBlurBrushRadius: true })}
              />
              <SelectDropdown label="Kernel" value={settings.blurBrushKernel} onChange={(value) => updateAaSettings({ blurBrushKernel: value === 'box' ? 'box' : 'gaussian' })} options={[{ value: 'box', label: 'Box' }, { value: 'gaussian', label: 'Gaussian' }]} className="space-y-1 block" labelClassName="font-medium" selectClassName="w-full h-[36px] px-2.5 pr-10 leading-tight text-sm" />
              <AaInlineHelp>Box is a hard average. Gaussian weights the center more heavily and usually gives a smoother resin-friendly falloff.</AaInlineHelp>
              {settings.blurBrushKernel === 'gaussian' && settings.blurBrushRadiusPx > 0 && (
                <>
                  <LabeledNumberInput label="Sigma X" helpText="Horizontal Gaussian falloff. Larger values spread the grayscale gradient farther in X." value={settings.blurBrushSigmaX} onChange={(value) => updateAaSettings({ blurBrushSigmaX: clampAaNumber(value, 0.5, 0.05, 16) })} />
                  <LabeledNumberInput label="Sigma Y" helpText="Vertical Gaussian falloff. Larger values spread the grayscale gradient farther in Y." value={settings.blurBrushSigmaY} onChange={(value) => updateAaSettings({ blurBrushSigmaY: clampAaNumber(value, 0.5, 0.05, 16) })} />
                </>
              )}
            </div>
          )}
        </AaCard>
      )}

      {settings.mode === '3DAA' && (
        <AaCard
          title="3DAA Blend Window"
          description="Controls how far 3DAA looks across neighboring layers and how quickly grayscale fades at Z transitions."
        >
          <div className="grid grid-cols-5 gap-1">
            {LOOK_BACK_PRESETS.map((layers) => (
              <PresetButton key={layers} active={!settings.useCustomZBlendLookBack && settings.zBlendLookBack === layers} onClick={() => updateAaSettings({ zBlendLookBack: layers, useCustomZBlendLookBack: false })}>{layers}L</PresetButton>
            ))}
            <PresetButton active={settings.useCustomZBlendLookBack} onClick={() => updateAaSettings({ useCustomZBlendLookBack: true })}>Custom</PresetButton>
          </div>
          {settings.useCustomZBlendLookBack && (
            <LabeledNumberInput
              label="Look-back layers"
              helpText="Number of earlier layers considered when blending 3DAA grayscale. Larger windows can smooth slow Z transitions, but may over-soften details."
              value={settings.zBlendLookBack}
              onChange={(value) => updateAaSettings({ zBlendLookBack: Math.round(clampAaNumber(value, 2, 1, 16)), useCustomZBlendLookBack: true })}
            />
          )}
          <div className="grid grid-cols-2 gap-1">
            {(['auto', 'manual'] as const).map((mode) => (
              <PresetButton key={mode} active={settings.zBlendFadeMode === mode} onClick={() => updateAaSettings({ zBlendFadeMode: mode })}>{mode === 'auto' ? 'Auto Fade' : 'Manual Fade'}</PresetButton>
            ))}
          </div>
          {settings.zBlendFadeMode === 'manual' && (
            <LabeledNumberInput
              label="Fade distance (px)"
              helpText="Manual pixel distance for the 3DAA grayscale fade. Higher values create a longer, softer transition."
              value={settings.zBlendFadePx}
              onChange={(value) => updateAaSettings({ zBlendFadePx: Math.round(clampAaNumber(value, 20, 1, 256)), useCustomZBlendFadePx: true })}
            />
          )}
          <LabeledToggleInput label="3DAA Auto Mode" checked={settings.zBlendAutoMode} onChange={(value) => updateAaSettings({ zBlendAutoMode: value })} />
          <AaInlineHelp>3DAA Auto Mode lets the engine derive blend-window behavior from the current material layer height and printer pixel pitch.</AaInlineHelp>
        </AaCard>
      )}

      {settings.mode === '3DAA' && (
        <AaCard
          title="3DAA Z Blur"
          description="Applies grayscale blur across neighboring layers after 3DAA sampling."
        >
          <div className="grid grid-cols-4 gap-1">
            {Z_BLUR_RADIUS_PRESETS.map((layers) => (
              <PresetButton key={layers} active={!settings.useCustomZBlurRadius && settings.zBlurRadiusLayers === layers} onClick={() => updateAaSettings({ zBlurRadiusLayers: layers, useCustomZBlurRadius: false })}>{layers}L</PresetButton>
            ))}
            <PresetButton active={settings.useCustomZBlurRadius} onClick={() => updateAaSettings({ useCustomZBlurRadius: true })}>Custom</PresetButton>
          </div>
          {settings.useCustomZBlurRadius && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <LabeledNumberInput
                label="Custom Z blur radius"
                helpText="Number of adjacent layers used for Z blur. 0 disables the Z blur pass."
                value={settings.zBlurRadiusLayers}
                onChange={(value) => updateAaSettings({ zBlurRadiusLayers: Math.round(clampAaNumber(value, 0, 0, 8)), useCustomZBlurRadius: true })}
              />
              <SelectDropdown label="Kernel" value={settings.zBlurKernel} onChange={(value) => updateAaSettings({ zBlurKernel: value === 'gaussian' ? 'gaussian' : 'box' })} options={[{ value: 'box', label: 'Box' }, { value: 'gaussian', label: 'Gaussian' }]} className="space-y-1 block" labelClassName="font-medium" selectClassName="w-full h-[36px] px-2.5 pr-10 leading-tight text-sm" />
              {settings.zBlurKernel === 'gaussian' && settings.zBlurRadiusLayers > 0 && (
                <LabeledNumberInput label="Sigma" helpText="Gaussian falloff for Z blur. Larger values spread grayscale across more of the selected layer window." value={settings.zBlurSigma} onChange={(value) => updateAaSettings({ zBlurSigma: clampAaNumber(value, 0.5, 0.05, 16) })} />
              )}
            </div>
          )}
        </AaCard>
      )}

      {settings.mode !== 'Off' && (
        <AaCard
          title="Grayscale Mapping"
          description="LUT Curve is the recommended grayscale path. Minimum Grey remains available for threshold-style resin tuning."
        >
          <div className="grid grid-cols-2 gap-1">
            <PresetButton active={settings.blurGraySourceMode === 'lut'} onClick={() => updateAaSettings({ blurGraySourceMode: 'lut' })}>LUT Curve</PresetButton>
            <PresetButton active={settings.blurGraySourceMode === 'minimum'} onClick={() => updateAaSettings({ blurGraySourceMode: 'minimum' })}>Minimum Grey</PresetButton>
          </div>
          {settings.blurGraySourceMode === 'lut' && (
            <div className="grid grid-cols-2 gap-1">
              <PresetButton active={settings.zBlendResinType === 'opaque'} onClick={() => updateAaSettings({ zBlendResinType: 'opaque' })}>Opaque</PresetButton>
              <PresetButton active={settings.zBlendResinType === 'clear'} onClick={() => updateAaSettings({ zBlendResinType: 'clear' })}>Clear</PresetButton>
            </div>
          )}
          {settings.blurGraySourceMode === 'lut' && (
            <AaInlineHelp>Opaque uses a stronger cure-response curve for standard resins. Clear uses a gentler curve for translucent materials.</AaInlineHelp>
          )}
          {settings.blurGraySourceMode === 'minimum' && (
            <LabeledNumberInput
              label="Minimum Grey Level"
              helpText="Minimum pixel intensity used by AA gradients. Higher values make faint grayscale pixels cure more strongly."
              value={draft.minimumAaAlphaPercent}
              onChange={(value) => onChange((prev) => ({ ...prev, minimumAaAlphaPercent: Math.max(0, Math.min(100, value)) }))}
            />
          )}
        </AaCard>
      )}

      {(settings.mode === 'Blur' || settings.mode === '3DAA') && (
        <AaCard
          title="AA on Supports"
          description="Controls whether native support and raft geometry receives grayscale AA in the selected mode."
        >
          <LabeledToggleInput label="AA on Supports" checked={settings.aaOnSupports} onChange={(value) => updateAaSettings({ aaOnSupports: value })} />
          <AaInlineHelp>Disabled keeps supports crisp and binary. Enabled allows anti-aliased support edges too.</AaInlineHelp>
        </AaCard>
      )}
    </>
  );
}

// ─── PluginLocalMaterialSettingsSections ──────────────────────────────────────

type PluginLocalMaterialSettingsSectionsProps = {
  outputFormat: string;
  settingsMode?: string;
  adapter: ReturnType<typeof getProfileLocalMaterialSettingsAdapter>;
  localSettingsByOutput: LocalSettingsByOutputDraft;
  onChange: React.Dispatch<React.SetStateAction<LocalSettingsByOutputDraft>>;
  replacementMode?: boolean;
  activeTabId?: string;
  onActiveTabChange?: (tabId: string) => void;
  showTabBar?: boolean;
};

export function PluginLocalMaterialSettingsSections({
  outputFormat,
  settingsMode,
  adapter,
  localSettingsByOutput,
  onChange,
  replacementMode = false,
  activeTabId: controlledActiveTabId,
  onActiveTabChange,
  showTabBar = true,
}: PluginLocalMaterialSettingsSectionsProps) {
  if (!adapter || adapter.fields.length === 0) return null;

  const normalizedOutput = outputFormat.trim().toLowerCase();
  const tabs = React.useMemo(() => {
    const declared = [...(adapter.tabs ?? [])]
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    if (declared.length > 0) return declared;
    return [{ id: 'local', title: adapter.displayName ?? 'Local Settings', order: 0 }];
  }, [adapter.displayName, adapter.tabs]);

  const defaultTabId = React.useMemo(() => tabs[0]?.id ?? 'local', [tabs]);

  const [uncontrolledActiveTabId, setUncontrolledActiveTabId] = React.useState(defaultTabId);
  const activeTabId = controlledActiveTabId ?? uncontrolledActiveTabId;
  const setActiveTabId = onActiveTabChange ?? setUncontrolledActiveTabId;

  React.useEffect(() => {
    if (!tabs.some((tab) => tab.id === activeTabId)) {
      setActiveTabId(defaultTabId);
    }
  }, [activeTabId, defaultTabId, tabs]);

  const valuesForOutput = localSettingsByOutput[normalizedOutput] ?? {};

  const fieldsForActiveTab = React.useMemo(() => {
    const fallbackTabId = tabs[0]?.id;
    return adapter.fields
      .filter((field) => (field.placement?.tabId ?? fallbackTabId) === activeTabId)
      .sort((a, b) => (a.placement?.order ?? 0) - (b.placement?.order ?? 0));
  }, [activeTabId, adapter.fields, tabs]);

  const sectionById = React.useMemo(() => {
    const map = new Map<string, { id: string; title: string; order?: number }>();
    (adapter.sections ?? []).forEach((section) => {
      map.set(section.id, section);
    });
    return map;
  }, [adapter.sections]);

  const cardById = React.useMemo(() => {
    const map = new Map<string, { id: string; title: string; order?: number }>();
    (adapter.cards ?? []).forEach((card) => {
      map.set(card.id, card);
    });
    return map;
  }, [adapter.cards]);

  const sectionGroups = React.useMemo(() => {
    const grouped = new Map<string, typeof fieldsForActiveTab>();

    fieldsForActiveTab.forEach((field) => {
      const sectionId = field.placement?.sectionId ?? 'general';
      const current = grouped.get(sectionId);
      if (current) {
        current.push(field);
      } else {
        grouped.set(sectionId, [field]);
      }
    });

    return Array.from(grouped.entries())
      .map(([sectionId, fields]) => ({
        sectionId,
        sectionTitle: sectionById.get(sectionId)?.title ?? 'General',
        sectionOrder: sectionById.get(sectionId)?.order ?? 0,
        fields,
      }))
      .sort((a, b) => a.sectionOrder - b.sectionOrder || a.sectionTitle.localeCompare(b.sectionTitle));
  }, [fieldsForActiveTab, sectionById]);

  const setFieldValue = React.useCallback((fieldKey: string, nextValue: string | number | boolean) => {
    onChange((prev) => ({
      ...prev,
      [normalizedOutput]: {
        ...(prev[normalizedOutput] ?? {}),
        [fieldKey]: nextValue,
      },
    }));
  }, [normalizedOutput, onChange]);

  return (
    <div
      className={replacementMode ? 'space-y-2' : 'rounded-xl border p-3 space-y-2'}
      style={replacementMode
        ? undefined
        : { borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}
    >
      {!replacementMode && (
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="ui-meta font-semibold uppercase tracking-wide">{adapter.displayName ?? 'Format-specific settings'}</div>
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Applied to {normalizedOutput} metadata for export.
            </div>
          </div>
        </div>
      )}

      {showTabBar && tabs.length > 1 && (
        <div className="flex items-center gap-1.5 border-b pb-2" style={{ borderColor: 'var(--border-subtle)' }}>
          {tabs.map((tab) => {
            const active = tab.id === activeTabId;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTabId(tab.id)}
                className="ui-button ui-button-secondary !h-7 !px-2.5 !py-0 text-[11px] rounded-md"
                style={active
                  ? { color: 'var(--accent-secondary)', borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 42%)' }
                  : { color: 'var(--text-muted)' }}
              >
                {tab.title}
              </button>
            );
          })}
        </div>
      )}

      {sectionGroups.length === 0 ? (
        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
          No custom settings are available for this tab.
        </div>
      ) : (
        <div className="space-y-2">
          {sectionGroups.map((section) => {
            const cardGroups = new Map<string, typeof section.fields>();
            section.fields.forEach((field) => {
              const cardId = field.placement?.cardId ?? 'general';
              const existing = cardGroups.get(cardId);
              if (existing) {
                existing.push(field);
              } else {
                cardGroups.set(cardId, [field]);
              }
            });

            const cards = Array.from(cardGroups.entries())
              .map(([cardId, fields]) => ({
                cardId,
                cardTitle: cardById.get(cardId)?.title ?? 'General',
                cardOrder: cardById.get(cardId)?.order ?? 0,
                fields: [...fields].sort((a, b) => (a.placement?.order ?? 0) - (b.placement?.order ?? 0)),
              }))
              .sort((a, b) => a.cardOrder - b.cardOrder || a.cardTitle.localeCompare(b.cardTitle));

            return (
              <div key={section.sectionId} className="space-y-1.5">
                {!replacementMode && (
                  <div className="ui-meta font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    {section.sectionTitle}
                  </div>
                )}
                {cards.map((card) => {
                  const renderedKeys = new Set<string>();
                  return (
                    <div
                      key={`${section.sectionId}-${card.cardId}`}
                      className="rounded-xl border p-3"
                      style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}
                    >
                      <div className="ui-meta font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>{card.cardTitle}</div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {card.fields.map((field) => {
                          if (renderedKeys.has(field.key)) return null;

                          const fieldValue = Object.prototype.hasOwnProperty.call(valuesForOutput, field.key)
                            ? valuesForOutput[field.key]
                            : field.defaultValue;
                          const sanitizedFieldValue = (field.kind === 'number' || field.kind === 'integer')
                            ? sanitizePluginNumericValue(field as PluginNumericFieldSchema, Number(fieldValue))
                            : fieldValue;

                          if (field.splitWithKey) {
                            const pairedField = card.fields.find((candidate) => candidate.key === field.splitWithKey);
                            if (pairedField) {
                              const pairedValue = Object.prototype.hasOwnProperty.call(valuesForOutput, pairedField.key)
                                ? valuesForOutput[pairedField.key]
                                : pairedField.defaultValue;
                              const sanitizedPairedValue = (pairedField.kind === 'number' || pairedField.kind === 'integer')
                                ? sanitizePluginNumericValue(pairedField as PluginNumericFieldSchema, Number(pairedValue))
                                : pairedValue;
                              renderedKeys.add(field.key);
                              renderedKeys.add(pairedField.key);
                              return (
                                <LabeledTwoStageNumberInput
                                  key={field.key}
                                  label={field.label}
                                  helpText={field.description}
                                  firstValue={Number(sanitizedFieldValue)}
                                  secondValue={Number(sanitizedPairedValue)}
                                  firstMin={field.min}
                                  firstMax={field.max}
                                  firstStep={field.step}
                                  firstTag={field.tag}
                                  firstColor={field.color}
                                  secondMin={pairedField.min}
                                  secondMax={pairedField.max}
                                  secondStep={pairedField.step}
                                  secondTag={pairedField.tag}
                                  secondColor={pairedField.color}
                                  onFirstChange={(next) => {
                                    const clamped = sanitizePluginNumericValue(field as PluginNumericFieldSchema, next);
                                    setFieldValue(field.key, clamped);
                                  }}
                                  onSecondChange={(next) => {
                                    const clamped = sanitizePluginNumericValue(pairedField as PluginNumericFieldSchema, next);
                                    setFieldValue(pairedField.key, clamped);
                                  }}
                                />
                              );
                            }
                          }

                          if (field.kind === 'boolean') {
                            return (
                              <LabeledToggleInput
                                key={field.key}
                                label={field.label}
                                checked={Boolean(fieldValue)}
                                onChange={(next) => setFieldValue(field.key, next)}
                              />
                            );
                          }

                          if (field.kind === 'select' && Array.isArray(field.options) && field.options.length > 0) {
                            return (
                              <SelectDropdown
                                key={field.key}
                                label={field.label}
                                value={String(fieldValue)}
                                onChange={(nextValue) => setFieldValue(field.key, nextValue)}
                                options={field.options.map((option) => ({
                                  value: option.value,
                                  label: option.label,
                                }))}
                                className="space-y-1 block"
                                labelClassName="font-medium"
                                selectClassName="w-full h-[36px] px-2.5 pr-10 leading-tight text-sm"
                              />
                            );
                          }

                          if (field.kind === 'number' || field.kind === 'integer') {
                            return (
                              <LabeledNumberInput
                                key={field.key}
                                label={field.label}
                                helpText={field.description}
                                tag={field.tag}
                                color={field.color}
                                value={Number(sanitizedFieldValue)}
                                onChange={(next) => {
                                  const clamped = sanitizePluginNumericValue(field as PluginNumericFieldSchema, next);
                                  setFieldValue(field.key, clamped);
                                }}
                              />
                            );
                          }

                          return (
                            <LabeledInput
                              key={field.key}
                              label={field.label}
                              helpText={field.description}
                              value={String(fieldValue)}
                              onChange={(next) => setFieldValue(field.key, next)}
                            />
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── ReplacementMaterialEditorShell ───────────────────────────────────────────

type ReplacementMaterialEditorShellProps = {
  tabs: Array<{ id: string; title: string; order: number }>;
  activeTabId: string;
  onActiveTabChange: (tabId: string) => void;
  draft: MaterialDraft;
  onDraftChange: React.Dispatch<React.SetStateAction<MaterialDraft>>;
  activeTabStyle?: React.CSSProperties;
  outputFormat: string;
  settingsMode?: string;
  adapter: ReturnType<typeof getProfileLocalMaterialSettingsAdapter> | null;
  localSettingsByOutput: LocalSettingsByOutputDraft;
  onLocalSettingsByOutputChange: React.Dispatch<React.SetStateAction<LocalSettingsByOutputDraft>>;
};

export function ReplacementMaterialEditorShell({
  tabs,
  activeTabId,
  onActiveTabChange,
  draft,
  onDraftChange,
  outputFormat,
  activeTabStyle,
  settingsMode,
  adapter,
  localSettingsByOutput,
  onLocalSettingsByOutputChange,
}: ReplacementMaterialEditorShellProps) {
  const measureRootRef = React.useRef<HTMLDivElement | null>(null);
  const [minBodyHeight, setMinBodyHeight] = React.useState<number | null>(null);

  const renderTabBody = React.useCallback((tabId: string) => {
    if (tabId === 'meta') {
      return <MaterialProfileIdentitySection draft={draft} onChange={onDraftChange} />;
    }

    if (tabId === 'anti-aliasing') {
      return <MaterialAntiAliasingSection draft={draft} onChange={onDraftChange} />;
    }

    return (
      <PluginLocalMaterialSettingsSections
        outputFormat={outputFormat}
        settingsMode={settingsMode}
        adapter={adapter}
        localSettingsByOutput={localSettingsByOutput}
        onChange={onLocalSettingsByOutputChange}
        replacementMode
        activeTabId={tabId}
        showTabBar={false}
      />
    );
  }, [adapter, draft, localSettingsByOutput, onDraftChange, onLocalSettingsByOutputChange, outputFormat, settingsMode]);

  React.useLayoutEffect(() => {
    const root = measureRootRef.current;
    if (!root) return;

    const heights = Array.from(root.querySelectorAll<HTMLElement>('[data-measure-tab-body]'))
      .map((element) => element.getBoundingClientRect().height)
      .filter((height) => Number.isFinite(height) && height > 0);

    const nextHeight = heights.length > 0 ? Math.ceil(Math.max(...heights)) : null;
    setMinBodyHeight((prev) => (prev === nextHeight ? prev : nextHeight));
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 border-b pb-2" style={{ borderColor: 'var(--border-subtle)' }}>
        {tabs.map((tab) => {
          const active = activeTabId === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onActiveTabChange(tab.id)}
              className="ui-button ui-button-secondary !h-7 !px-2.5 !py-0 text-[11px] rounded-md"
              style={active
                ? (activeTabStyle ?? { color: 'var(--accent-secondary)', borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 42%)' })
                : { color: 'var(--text-muted)' }}
            >
              {tab.title}
            </button>
          );
        })}
      </div>

      <div className="relative" style={minBodyHeight ? { minHeight: `${minBodyHeight}px` } : undefined}>
        <div className="space-y-3" data-measure-tab-body>
          {renderTabBody(activeTabId)}
        </div>

        <div ref={measureRootRef} aria-hidden="true" className="absolute inset-0 pointer-events-none invisible overflow-hidden" style={{ width: '100%' }}>
          {tabs.map((tab) => (
            <div key={tab.id} className="space-y-3" data-measure-tab-body>
              {renderTabBody(tab.id)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
