'use client';

import React from 'react';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { useLingui } from '@lingui/react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/atoms/Button';
import { SettingRow } from '@/components/atoms/SettingRow';
import { Toggle } from '@/components/atoms/Toggle';
import { ContextMenu, type ContextMenuEntry } from '@/components/ui/ContextMenu';
import { NumberInput } from '@/components/ui/NumberInput';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';
import { normalizeFormatVersion } from '@/features/profiles/outputFormatUtils';
import { useLocaleFormat } from '@/hooks/useLocaleFormat';
import { resolveLayerSettingsFields } from '../formats/registry';
import type { SlicingFormatDefinition } from '../formats/types';
import {
  compileLayerSettingsRanges,
  findUnsupportedLayerSetting,
  LAYER_SETTING_FIELDS,
  parseLayerSettingsRanges,
  type LayerSettingField,
  type LayerPrintSettingsPatch,
  type LayerSettingsRange,
} from '../layerSettingsRanges';
import {
  formatLayerSettingsRangeBounds,
  formatUnsupportedLayerSetting,
  LAYER_SETTING_LABELS,
  LAYER_SETTING_UNITS,
} from '../layerSettingsRangeMessages';

type Translate = (descriptor: MessageDescriptor) => string;
type DialogState = { kind: 'manage' } | { kind: 'add' | 'edit'; draft: LayerSettingsRange };

export type LayerSettingsRangeEditorProps = {
  ranges: readonly LayerSettingsRange[];
  rangeColors: ReadonlyMap<string, string>;
  totalLayers: number;
  format: SlicingFormatDefinition | null;
  formatVersion?: string;
  normalExposureSec: number;
  menuRequest: { layerNumber: number | null; position: { x: number; y: number } } | null;
  onCloseMenu(): void;
  onApply(next: readonly LayerSettingsRange[]): void;
};

function formatOverrideLabel(translate: Translate, field: string): string {
  return translate(msg`Override ${field}`);
}

function formatInheritedValue(translate: Translate, value: string): string {
  return translate(msg`Inherited: ${value}`);
}

function formatSelectedFormat(translate: Translate, name: string, version: string): string {
  return translate(msg`${name} (${version})`);
}

function formatBoundsError(translate: Translate, first: string, last: string): string {
  return translate(msg`Use whole printed layer numbers from ${first} to ${last}.`);
}

function formatPwmError(translate: Translate, first: string, last: string): string {
  return translate(msg`Light PWM must be a whole number from ${first} to ${last}.`);
}

function RangeSwatch({ color }: { color: string | undefined }) {
  return color ? <span aria-hidden="true" className="inline-block h-3 w-3 shrink-0 rounded-sm" style={{ backgroundColor: color }} /> : null;
}

export function LayerSettingsRangeEditor({
  ranges,
  rangeColors,
  totalLayers,
  format,
  formatVersion,
  normalExposureSec,
  menuRequest,
  onCloseMenu,
  onApply,
}: LayerSettingsRangeEditorProps) {
  const { _ } = useLingui();
  const fmt = useLocaleFormat();
  const [dialog, setDialog] = React.useState<DialogState | null>(null);
  const draft = dialog && dialog.kind !== 'manage' ? dialog.draft : null;
  const supportedFields = format ? resolveLayerSettingsFields(format, formatVersion) : [];
  const canEditNumbers = supportedFields.length > 0;
  const layerNumber = menuRequest?.layerNumber ?? null;
  const canAdd = canEditNumbers && totalLayers > 0 && layerNumber !== null;
  const normalizedVersion = normalizeFormatVersion(formatVersion);
  const versions = format?.formatVersions ?? [];
  const selectedVersion = versions.find((version) => normalizedVersion && version.value.toLowerCase() === normalizedVersion.toLowerCase())
    ?? versions.find((version) => version.isDefault) ?? versions[0];
  const selectedFormat = format
    ? (selectedVersion ? formatSelectedFormat(_, format.displayName, selectedVersion.label) : format.displayName)
    : _(msg`No supported printer selected`);
  const bounds = (range: LayerSettingsRange) => formatLayerSettingsRangeBounds(_, fmt.number(range.startLayer), fmt.number(range.endLayer));
  const closeDialog = () => setDialog(null);

  const editRange = (id: string) => {
    const range = ranges.find((candidate) => candidate.id === id);
    if (range) setDialog({ kind: 'edit', draft: { ...range, settings: { ...range.settings } } });
  };
  const deleteRange = (id: string) => {
    if (!ranges.some((range) => range.id === id)) return;
    onApply(parseLayerSettingsRanges(ranges.filter((range) => range.id !== id)));
    if (draft?.id === id) setDialog({ kind: 'manage' });
  };

  const matchingRanges = layerNumber === null ? [] : ranges
    .map((range, index) => ({ range, index }))
    .filter(({ range }) => range.startLayer <= layerNumber && range.endLayer >= layerNumber)
    .sort((a, b) => (a.range.endLayer - a.range.startLayer) - (b.range.endLayer - b.range.startLayer) || b.index - a.index);
  const entries: ContextMenuEntry[] = [
    { id: 'add-range', label: _(msg`Add range`), icon: Plus, disabled: !canAdd },
    { id: 'manage-ranges', label: _(msg`Manage ranges`) },
    ...matchingRanges.map(({ range }, index): ContextMenuEntry => ({
      id: `range:${range.id}`,
      label: bounds(range),
      startsGroup: index === 0,
      iconNode: <RangeSwatch color={rangeColors.get(range.id)} />,
      iconBare: true,
      children: [
        { id: `edit:${range.id}`, label: _(msg`Edit`), iconNode: <RangeSwatch color={rangeColors.get(range.id)} />, iconBare: true },
        { id: `delete:${range.id}`, label: _(msg`Delete`), iconNode: <RangeSwatch color={rangeColors.get(range.id)} />, iconBare: true, danger: true },
      ],
    })),
  ];

  const inheritedPatch = React.useMemo<LayerPrintSettingsPatch>(() => {
    if (!draft || !Number.isInteger(draft.startLayer) || draft.startLayer < 1 || draft.startLayer > 4294967295) return {};
    // Stored ranges beyond the current print are editable and retain their inheritance.
    return compileLayerSettingsRanges(ranges, Math.max(totalLayers, draft.startLayer))
      .find((segment) => segment.startLayer <= draft.startLayer && segment.endLayer >= draft.startLayer)?.settings ?? {};
  }, [ranges, totalLayers, draft?.startLayer]);
  const inheritedValue = (field: LayerSettingField) => inheritedPatch[field]
    ?? (field === 'exposureSec' ? normalExposureSec : field === 'lightPwm' ? 255 : 0);
  const updateDraft = (next: LayerSettingsRange) => {
    if (dialog && dialog.kind !== 'manage') setDialog({ ...dialog, draft: next });
  };
  const setFieldEnabled = (field: LayerSettingField, enabled: boolean) => {
    if (!draft) return;
    const settings = { ...draft.settings };
    if (enabled) settings[field] = inheritedValue(field);
    else delete settings[field];
    updateDraft({ ...draft, settings });
  };

  let error: string | null = null;
  let validatedNext: LayerSettingsRange[] | null = null;
  if (draft && dialog && dialog.kind !== 'manage') {
    if (dialog.kind === 'edit' && !ranges.some((range) => range.id === draft.id)) {
      error = _(msg`This range no longer exists`);
    } else if (![draft.startLayer, draft.endLayer].every((value) => Number.isInteger(value) && value >= 1 && value <= 4294967295)) {
      error = formatBoundsError(_, fmt.number(1), fmt.number(4294967295));
    } else if (draft.startLayer > draft.endLayer) {
      error = _(msg`The start layer must not exceed the end layer.`);
    } else if (Object.keys(draft.settings).length === 0) {
      error = _(msg`Enable at least one setting override.`);
    } else if (Object.values(draft.settings).some((value) => !Number.isFinite(value) || value < 0 || value > 3.4028234663852886e38)) {
      error = _(msg`Override values must be finite, nonnegative numbers within the supported numeric range.`);
    } else if (draft.settings.lightPwm !== undefined && (!Number.isInteger(draft.settings.lightPwm) || draft.settings.lightPwm > 255)) {
      error = formatPwmError(_, fmt.number(0), fmt.number(255));
    } else {
      const incompatible = findUnsupportedLayerSetting([draft], supportedFields);
      if (incompatible) {
        error = formatUnsupportedLayerSetting(_, selectedFormat, bounds(draft), _(LAYER_SETTING_LABELS[incompatible.field]));
      } else {
        try {
          // Build against the current props, never the array captured when editing began.
          validatedNext = parseLayerSettingsRanges(dialog.kind === 'add'
            ? [...ranges, draft]
            : ranges.map((range) => range.id === draft.id ? draft : range));
        } catch {
          error = _(msg`The range collection is invalid. Correct its layer bounds and overrides before applying.`);
        }
      }
    }
  }
  const applyDraft = () => {
    if (!draft || !validatedNext || error) return;
    const previous = ranges.find((range) => range.id === draft.id);
    const unchanged = dialog?.kind === 'edit' && previous
      && previous.startLayer === draft.startLayer && previous.endLayer === draft.endLayer
      && LAYER_SETTING_FIELDS.every((field) => previous.settings[field] === draft.settings[field]);
    if (!unchanged) onApply(validatedNext);
    closeDialog();
  };
  const title = dialog?.kind === 'add' ? _(msg`Add range`) : dialog?.kind === 'edit' ? _(msg`Edit range`) : _(msg`Manage ranges`);

  return (
    <>
      <ContextMenu
        position={menuRequest?.position ?? null}
        entries={entries}
        ariaLabel={_(msg`Layer settings ranges`)}
        onClose={onCloseMenu}
        onSelect={(id) => {
          if (id === 'manage-ranges') setDialog({ kind: 'manage' });
          else if (id === 'add-range' && canAdd && layerNumber !== null) {
            setDialog({ kind: 'add', draft: { id: crypto.randomUUID(), startLayer: layerNumber, endLayer: layerNumber, settings: {} } });
          } else if (id.startsWith('edit:')) editRange(id.slice(5));
          else if (id.startsWith('delete:')) deleteRange(id.slice(7));
        }}
      />
      <StructuredDialogModal
        open={dialog !== null}
        ariaLabel={title}
        title={title}
        subtitle={_(msg`Ranges apply to the next slice; existing files are unchanged`)}
        closeAriaLabel={_(msg`Close dialog`)}
        onClose={closeDialog}
        maxWidthClassName="max-w-2xl"
        bodyClassName="max-h-[75vh] space-y-4 overflow-y-auto p-5"
        actions={(
          <>
            <Button onClick={closeDialog}>{dialog?.kind === 'manage' ? _(msg`Close`) : _(msg`Cancel`)}</Button>
            {draft ? <Button variant="primary" disabled={!validatedNext || Boolean(error)} onClick={applyDraft}>{_(msg`Apply`)}</Button> : null}
          </>
        )}
      >
        {!canEditNumbers ? <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{_(msg`The selected format does not support per-layer settings. Existing ranges can be inspected or deleted; select a supported printer to edit values.`)}</p> : null}
        {draft ? (
          <section className="space-y-2" aria-label={_(msg`Range settings`)}>
            <div className="flex items-center gap-2 text-sm font-semibold">
              <RangeSwatch color={rangeColors.get(draft.id)} />
              <span>{bounds(draft)}</span>
            </div>
            <SettingRow label={_(msg`Start layer`)}>
              <NumberInput aria-label={_(msg`Start layer`)} value={draft.startLayer} min={1} max={4294967295} step={1} disabled={!canEditNumbers} onChange={(startLayer) => updateDraft({ ...draft, startLayer })} className="ui-input w-32 pr-5" />
            </SettingRow>
            <SettingRow label={_(msg`End layer`)}>
              <NumberInput aria-label={_(msg`End layer`)} value={draft.endLayer} min={1} max={4294967295} step={1} disabled={!canEditNumbers} onChange={(endLayer) => updateDraft({ ...draft, endLayer })} className="ui-input w-32 pr-5" />
            </SettingRow>
            {LAYER_SETTING_FIELDS.filter((field) => supportedFields.includes(field) || draft.settings[field] !== undefined).map((field) => {
              const enabled = draft.settings[field] !== undefined;
              const supported = supportedFields.includes(field);
              const label = _(LAYER_SETTING_LABELS[field]);
              const value = draft.settings[field] ?? inheritedValue(field);
              const unit = LAYER_SETTING_UNITS[field];
              const formattedValue = unit ? fmt.quantity(value, 2, unit) : fmt.number(value);
              return (
                <SettingRow
                  key={field}
                  label={label}
                  bordered
                  surface="raised"
                  description={!supported
                    ? formatUnsupportedLayerSetting(_, selectedFormat, bounds(draft), label)
                    : !enabled ? formatInheritedValue(_, formattedValue) : undefined}
                >
                  <Toggle label={formatOverrideLabel(_, label)} checked={enabled} disabled={!supported && !enabled} size="sm" onChange={(checked) => setFieldEnabled(field, checked)} />
                  <NumberInput
                    aria-label={label}
                    value={value}
                    min={0}
                    max={field === 'lightPwm' ? 255 : 3.4028234663852886e38}
                    step={field === 'lightPwm' || unit === 'mmPerMin' ? 1 : 0.01}
                    disabled={!enabled || !supported}
                    onChange={(next) => updateDraft({ ...draft, settings: { ...draft.settings, [field]: next } })}
                    className="ui-input w-28 pr-5"
                  />
                  {unit ? <span className="min-w-8 text-xs" style={{ color: 'var(--text-muted)' }}>{fmt.unit(unit, '')}</span> : null}
                </SettingRow>
              );
            })}
            {error ? <p role="alert" className="text-xs" style={{ color: 'var(--danger)' }}>{error}</p> : null}
          </section>
        ) : null}
        <section className="space-y-2" aria-label={_(msg`Saved ranges`)}>
          <h3 className="text-xs font-semibold">{_(msg`Saved ranges`)}</h3>
          {ranges.length === 0 ? <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{_(msg`No layer settings ranges`)}</p> : null}
          {ranges.map((range) => (
            <div key={range.id} className="flex items-center gap-2 rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)' }}>
              <RangeSwatch color={rangeColors.get(range.id)} />
              <span className="flex-1 text-xs">{bounds(range)}</span>
              {draft?.id === range.id ? <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{_(msg`Editing`)}</span> : null}
              <Button size="xs" onClick={() => editRange(range.id)}><Pencil className="h-3 w-3" />{_(msg`Edit`)}</Button>
              <Button size="xs" variant="tinted-danger" onClick={() => deleteRange(range.id)}><Trash2 className="h-3 w-3" />{_(msg`Delete`)}</Button>
            </div>
          ))}
        </section>
      </StructuredDialogModal>
    </>
  );
}
