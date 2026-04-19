'use client';

import React from 'react';
import { CarFront, ChevronDown, ChevronUp, Snail } from 'lucide-react';
import { NumberInput } from '@/components/ui/NumberInput';
import { SelectDropdown } from '@/components/ui/SelectDropdown';
import type { MaterialProfile, PrinterOutputFormat } from '@/features/profiles/profileStore';
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

export function isSlowFastPair(firstTag?: string, secondTag?: string): boolean {
  const first = typeof firstTag === 'string' ? firstTag.trim().toLowerCase() : '';
  const second = typeof secondTag === 'string' ? secondTag.trim().toLowerCase() : '';
  return (first === 'slow' && second === 'fast') || (first === 'fast' && second === 'slow');
}

export function resolveFieldTagTone(tag?: string): { icon: typeof CarFront | typeof Snail; fallbackColor: string } | null {
  const normalized = typeof tag === 'string' ? tag.trim().toLowerCase() : '';
  if (!normalized) return null;

  if (normalized === 'slow') {
    return { icon: Snail, fallbackColor: '#f59e0b' };
  }

  return { icon: CarFront, fallbackColor: '#22c55e' };
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
        {helpText && (
          <span
            title={helpText}
            aria-label={`${label} help`}
            className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border text-[9px] font-semibold cursor-help"
            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)', background: 'var(--surface-2)' }}
          >
            ?
          </span>
        )}
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
        {helpText && (
          <span
            title={helpText}
            aria-label={`${label} help`}
            className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border text-[9px] font-semibold cursor-help"
            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)', background: 'var(--surface-2)' }}
          >
            ?
          </span>
        )}
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
        {helpText && (
          <span
            title={helpText}
            aria-label={`${label} help`}
            className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border text-[9px] font-semibold cursor-help"
            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)', background: 'var(--surface-2)' }}
          >
            ?
          </span>
        )}
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
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
};

export function LabeledToggleInput({ label, checked, onChange, disabled = false }: LabeledToggleInputProps) {
  return (
    <label className="space-y-1 block">
      <span className="ui-label font-medium inline-flex items-center">
        {label}
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
          <LabeledNumberInput
            label="Minimum AA alpha (%)"
            value={draft.minimumAaAlphaPercent}
            onChange={(value) => onChange((prev) => ({
              ...prev,
              minimumAaAlphaPercent: Math.max(0, Math.min(100, value)),
            }))}
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
                                    const pairedClamped = sanitizePluginNumericValue(pairedField as PluginNumericFieldSchema, Number(sanitizedPairedValue));

                                    if (isSlowFastPair(field.tag, pairedField.tag)) {
                                      const fieldTag = field.tag?.trim().toLowerCase();
                                      if (fieldTag === 'slow' && clamped > pairedClamped) {
                                        setFieldValue(field.key, clamped);
                                        setFieldValue(pairedField.key, clamped);
                                        return;
                                      }
                                      if (fieldTag === 'fast' && clamped < pairedClamped) {
                                        setFieldValue(field.key, clamped);
                                        setFieldValue(pairedField.key, clamped);
                                        return;
                                      }
                                    }

                                    setFieldValue(field.key, clamped);
                                  }}
                                  onSecondChange={(next) => {
                                    const clamped = sanitizePluginNumericValue(pairedField as PluginNumericFieldSchema, next);
                                    const fieldClamped = sanitizePluginNumericValue(
                                      field as PluginNumericFieldSchema,
                                      Number(sanitizedFieldValue),
                                    );

                                    if (isSlowFastPair(field.tag, pairedField.tag)) {
                                      const pairedTag = pairedField.tag?.trim().toLowerCase();
                                      if (pairedTag === 'slow' && clamped > fieldClamped) {
                                        setFieldValue(field.key, clamped);
                                        setFieldValue(pairedField.key, clamped);
                                        return;
                                      }
                                      if (pairedTag === 'fast' && clamped < fieldClamped) {
                                        setFieldValue(field.key, clamped);
                                        setFieldValue(pairedField.key, clamped);
                                        return;
                                      }
                                    }

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
