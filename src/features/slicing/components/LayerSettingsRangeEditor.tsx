'use client';

import React from 'react';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { useLingui } from '@lingui/react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/atoms/Button';
import { SettingRow } from '@/components/atoms/SettingRow';
import { SegmentedControl } from '@/components/atoms/SegmentedControl';
import { Toggle } from '@/components/atoms/Toggle';
import { ContextMenu, type ContextMenuEntry } from '@/components/ui/ContextMenu';
import { NumberInput } from '@/components/ui/NumberInput';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';
import type { LocalMaterialFieldSchema } from '@/features/plugins/complexPluginContracts';
import { normalizeFormatVersion } from '@/features/profiles/outputFormatUtils';
import { useLocaleFormat } from '@/hooks/useLocaleFormat';
import { resolveLayerSettingsFields } from '../formats/layerSettingsFields';
import { resolveLayerSettingsMaterialRows } from '../layerSettingsMaterialFields';
import type { SlicingFormatDefinition } from '../formats/types';
import {
  compileLayerSettingsRanges,
  findUnsupportedLayerSetting,
  LAYER_SETTING_FIELDS,
  parseLayerSettingsRanges,
  resolveLayerSettingsRangeBounds,
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
  layerHeightMm: number;
  format: SlicingFormatDefinition | null;
  formatVersion?: string;
  materialSettings: { fields: LocalMaterialFieldSchema[] } | null;
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

function formatFieldNote(translate: Translate, field: string, value: string): string {
  return translate(msg`${field}: ${value}`);
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

const MAX_LAYER = 4294967295;
const MAX_F32 = 3.4028234663852886e38;
const CONTROL_GRID = 'grid shrink-0 grid-cols-[36px_112px_12px_112px_60px] items-center gap-2';

type SettingRowDefinition = {
  fields: readonly LayerSettingField[];
  label: MessageDescriptor;
  hint?: MessageDescriptor;
};

function materialRowDefinition(fields: readonly LayerSettingField[]): SettingRowDefinition {
  const first = fields[0];
  const paired = fields.length === 2;
  const totalTravel = first === 'liftHeightMm' || first === 'retractHeightMm';
  return {
    fields,
    label: paired && totalTravel
      ? first === 'liftHeightMm' ? msg`Lift travel` : msg`Retract travel`
      : LAYER_SETTING_LABELS[first],
    hint: paired && fields[1] === first.replace(/(MmMin|Mm)$/, '2$1')
      ? totalTravel ? msg`Total / Stage 2` : msg`Stage 1 / Stage 2`
      : undefined,
  };
}



function hasValidBounds(range: LayerSettingsRange): boolean {
  return range.unit === 'mm'
    ? [range.startMm, range.endMm].every((value) => Number.isFinite(value) && value >= 0 && value <= MAX_F32) && range.startMm <= range.endMm
    : [range.startLayer, range.endLayer].every((value) => Number.isInteger(value) && value >= 1 && value <= MAX_LAYER) && range.startLayer <= range.endLayer;
}

function RangeSwatch({ color }: { color: string | undefined }) {
  return color ? <span aria-hidden="true" className="inline-block h-3 w-3 shrink-0 rounded-sm" style={{ backgroundColor: color }} /> : null;
}

export function LayerSettingsRangeEditor({
  ranges,
  rangeColors,
  totalLayers,
  layerHeightMm,
  format,
  formatVersion,
  materialSettings,
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
  const settingRows = resolveLayerSettingsMaterialRows(materialSettings, supportedFields)
    .map((row) => materialRowDefinition(row.controls.map((control) => control.field)));
  const editableFields = settingRows.flatMap((row) => row.fields);
  const unavailableFields = LAYER_SETTING_FIELDS.filter((field) => draft?.settings[field] !== undefined && !editableFields.includes(field));
  const canEditNumbers = editableFields.length > 0;
  const layerNumber = menuRequest?.layerNumber ?? null;
  const canAdd = canEditNumbers && totalLayers > 0 && layerNumber !== null;
  const normalizedVersion = normalizeFormatVersion(formatVersion);
  const versions = format?.formatVersions ?? [];
  const selectedVersion = versions.find((version) => normalizedVersion && version.value.toLowerCase() === normalizedVersion.toLowerCase())
    ?? versions.find((version) => version.isDefault) ?? versions[0];
  const selectedFormat = format
    ? (selectedVersion ? formatSelectedFormat(_, format.displayName, selectedVersion.label) : format.displayName)
    : _(msg`No supported printer selected`);
  const bounds = (range: LayerSettingsRange) => formatLayerSettingsRangeBounds(_, fmt, range);
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
    .map((range, index) => ({ range, index, resolved: resolveLayerSettingsRangeBounds(range, layerHeightMm) }))
    .filter(({ resolved }) => resolved !== null && resolved.startLayer <= layerNumber && resolved.endLayer >= layerNumber)
    .sort((a, b) => (a.resolved!.endLayer - a.resolved!.startLayer) - (b.resolved!.endLayer - b.resolved!.startLayer) || b.index - a.index);
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

  const resolvedDraft = draft && hasValidBounds(draft) ? resolveLayerSettingsRangeBounds(draft, layerHeightMm) : null;
  const inheritedLayer = resolvedDraft?.startLayer;
  const inheritedPatch = React.useMemo<LayerPrintSettingsPatch>(() => {
    if (inheritedLayer === undefined || inheritedLayer > MAX_LAYER) return {};
    // Stored ranges beyond the current print are editable and retain their inheritance.
    return compileLayerSettingsRanges(ranges, Math.min(MAX_LAYER, Math.max(totalLayers, inheritedLayer)), layerHeightMm)
      .find((segment) => segment.startLayer <= inheritedLayer && segment.endLayer >= inheritedLayer)?.settings ?? {};
  }, [ranges, totalLayers, layerHeightMm, inheritedLayer]);
  const inheritedValue = (field: LayerSettingField) => inheritedPatch[field]
    ?? (field === 'exposureSec' ? normalExposureSec : field === 'lightPwm' ? 255 : 0);
  const updateDraft = (update: (current: LayerSettingsRange) => LayerSettingsRange) => {
    setDialog((current) => current && current.kind !== 'manage' ? { ...current, draft: update(current.draft) } : current);
  };
  const setRowEnabled = (row: SettingRowDefinition, enabled: boolean) => {
    updateDraft((current) => {
      const settings = { ...current.settings };
      for (const field of row.fields) {
        if (!enabled) delete settings[field];
        else if (editableFields.includes(field) && settings[field] === undefined) settings[field] = inheritedValue(field);
      }
      return { ...current, settings };
    });
  };
  const canUseLayerBounds = draft?.unit !== 'mm' || (resolvedDraft !== null && resolvedDraft.startLayer <= MAX_LAYER && resolvedDraft.endLayer <= MAX_LAYER);
  const switchUnit = (unit: 'layers' | 'mm') => {
    updateDraft((current) => {
      if (unit === 'mm' && current.unit !== 'mm') {
        return { id: current.id, unit: 'mm', startMm: current.startLayer * layerHeightMm, endMm: current.endLayer * layerHeightMm, settings: current.settings };
      }
      if (unit === 'layers' && current.unit === 'mm' && hasValidBounds(current)) {
        const resolved = resolveLayerSettingsRangeBounds(current, layerHeightMm);
        if (resolved && resolved.startLayer <= MAX_LAYER && resolved.endLayer <= MAX_LAYER) {
          return { id: current.id, startLayer: resolved.startLayer, endLayer: resolved.endLayer, settings: current.settings };
        }
      }
      return current;
    });
  };

  let error: string | null = null;
  let validatedNext: LayerSettingsRange[] | null = null;
  if (draft && dialog && dialog.kind !== 'manage') {
    if (dialog.kind === 'edit' && !ranges.some((range) => range.id === draft.id)) {
      error = _(msg`This range no longer exists`);
    } else if (draft.unit === 'mm' && ![draft.startMm, draft.endMm].every((value) => Number.isFinite(value) && value >= 0 && value <= MAX_F32)) {
      error = _(msg`Height bounds must be finite, nonnegative numbers within the supported numeric range.`);
    } else if (draft.unit === 'mm' && draft.startMm > draft.endMm) {
      error = _(msg`The start height must not exceed the end height.`);
    } else if (draft.unit !== 'mm' && ![draft.startLayer, draft.endLayer].every((value) => Number.isInteger(value) && value >= 1 && value <= MAX_LAYER)) {
      error = formatBoundsError(_, fmt.number(1), fmt.number(4294967295));
    } else if (draft.unit !== 'mm' && draft.startLayer > draft.endLayer) {
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
      && (previous.unit === 'mm'
        ? draft.unit === 'mm' && previous.startMm === draft.startMm && previous.endMm === draft.endMm
        : draft.unit !== 'mm' && previous.startLayer === draft.startLayer && previous.endLayer === draft.endLayer)
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
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{_(msg`Unspecified values inherit wider ranges or mode-adjusted material settings. Explicit overrides take precedence over the material mode.`)}</p>
        {!canEditNumbers ? <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{_(msg`The selected printer and material mode have no editable per-layer settings. Existing ranges can be inspected or deleted.`)}</p> : null}
        {draft ? (
          <section className="space-y-2" aria-label={_(msg`Range settings`)}>
            <div className="flex items-center gap-2 text-sm font-semibold">
              <RangeSwatch color={rangeColors.get(draft.id)} />
              <span>{bounds(draft)}</span>
            </div>
            <SettingRow label={_(msg`Range units`)}>
              <SegmentedControl
                label={_(msg`Range units`)}
                size="sm"
                value={draft.unit === 'mm' ? 'mm' : 'layers'}
                options={[
                  { value: 'layers', label: _(msg`Layers`), disabled: !canEditNumbers || !canUseLayerBounds },
                  { value: 'mm', label: fmt.unit('mm', ''), disabled: !canEditNumbers },
                ]}
                onChange={switchUnit}
              />
            </SettingRow>
            {(['start', 'end'] as const).map((edge) => {
              const isMm = draft.unit === 'mm';
              const label = isMm
                ? edge === 'start' ? _(msg`Start height`) : _(msg`End height`)
                : edge === 'start' ? _(msg`Start layer`) : _(msg`End layer`);
              const value = draft.unit === 'mm'
                ? edge === 'start' ? draft.startMm : draft.endMm
                : edge === 'start' ? draft.startLayer : draft.endLayer;
              return (
                <SettingRow key={edge} label={label} bordered surface="raised">
                  <div className={CONTROL_GRID}>
                    <span aria-hidden="true" />
                    <span aria-hidden="true" />
                    <span aria-hidden="true" />
                    <NumberInput
                      aria-label={label}
                      value={value}
                      min={isMm ? 0 : 1}
                      max={isMm ? MAX_F32 : MAX_LAYER}
                      step={isMm ? 0.001 : 1}
                      decimalPlaces={isMm ? 6 : undefined}
                      disabled={!canEditNumbers}
                      onChange={(next) => updateDraft((current) => current.unit === 'mm'
                        ? { ...current, [edge === 'start' ? 'startMm' : 'endMm']: next }
                        : { ...current, [edge === 'start' ? 'startLayer' : 'endLayer']: next })}
                      className="ui-input w-full pr-5"
                    />
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{isMm ? fmt.unit('mm', '') : null}</span>
                  </div>
                </SettingRow>
              );
            })}
            {settingRows.map((row) => {
              const paired = row.fields.length === 2;
              const enabled = row.fields.some((field) => draft.settings[field] !== undefined);
              const label = _(row.label);
              const unit = LAYER_SETTING_UNITS[row.fields[0]];
              const notes = row.fields.flatMap((field) => {
                const fieldLabel = _(LAYER_SETTING_LABELS[field]);
                const inherited = inheritedPatch[field];
                const value = draft.settings[field] ?? inheritedValue(field);
                const fieldUnit = LAYER_SETTING_UNITS[field];
                const formatted = fieldUnit ? fmt.quantity(value, 2, fieldUnit) : fmt.number(value);
                const text = draft.settings[field] === undefined
                  ? inherited === undefined ? _(msg`Material mode default`) : formatInheritedValue(_, formatted)
                  : null;
                return text ? [{ field, text: paired ? formatFieldNote(_, fieldLabel, text) : text }] : [];
              });
              const inputs = row.fields.map((field) => {
                const fieldLabel = _(LAYER_SETTING_LABELS[field]);
                return (
                  <NumberInput
                    key={field}
                    aria-label={fieldLabel}
                    value={draft.settings[field] ?? inheritedValue(field)}
                    min={0}
                    max={field === 'lightPwm' ? 255 : MAX_F32}
                    step={field === 'lightPwm' || LAYER_SETTING_UNITS[field] === 'mmPerMin' ? 1 : 0.01}
                    onChange={(next) => updateDraft((current) => ({ ...current, settings: { ...current.settings, [field]: next } }))}
                    className="ui-input w-full pr-5"
                  />
                );
              });
              return (
                <SettingRow
                  key={row.fields[0]}
                  role="group"
                  aria-label={label}
                  label={label}
                  bordered
                  surface="raised"
                  description={row.hint || notes.length > 0 ? <>{row.hint ? <div>{_(row.hint)}</div> : null}{notes.map((note) => <div key={note.field}>{note.text}</div>)}</> : undefined}
                >
                  <div className={CONTROL_GRID}>
                    <Toggle label={formatOverrideLabel(_, label)} checked={enabled} size="sm" onChange={(checked) => setRowEnabled(row, checked)} />
                    {paired ? inputs[0] : <span aria-hidden="true" />}
                    <span aria-hidden="true" className="text-center text-xs" style={{ color: 'var(--text-muted)' }}>{paired ? '/' : null}</span>
                    {paired ? inputs[1] : inputs[0]}
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{unit ? fmt.unit(unit, '') : null}</span>
                  </div>
                </SettingRow>
              );
            })}
            {unavailableFields.length > 0 ? (
              <section className="space-y-2" aria-label={_(msg`Unavailable stored overrides`)}>
                <h3 className="text-xs font-semibold">{_(msg`Unavailable stored overrides`)}</h3>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{_(msg`These stored overrides are not editable for the selected printer and material mode. They are preserved until you remove them.`)}</p>
                {unavailableFields.map((field) => {
                  const label = _(LAYER_SETTING_LABELS[field]);
                  const unit = LAYER_SETTING_UNITS[field];
                  return (
                    <SettingRow key={field} role="group" aria-label={label} label={label} bordered surface="raised">
                      <div className={CONTROL_GRID}>
                        <Toggle label={formatOverrideLabel(_, label)} checked size="sm" onChange={() => setRowEnabled({ fields: [field], label: LAYER_SETTING_LABELS[field] }, false)} />
                        <span aria-hidden="true" />
                        <span aria-hidden="true" />
                        <NumberInput aria-label={label} value={draft.settings[field]!} disabled className="ui-input w-full pr-5" />
                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{unit ? fmt.unit(unit, '') : null}</span>
                      </div>
                    </SettingRow>
                  );
                })}
              </section>
            ) : null}
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
