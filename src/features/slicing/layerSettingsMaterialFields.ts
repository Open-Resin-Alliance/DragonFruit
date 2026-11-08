import type { LocalMaterialFieldSchema } from '@/features/plugins/complexPluginContracts';
import { LAYER_SETTING_FIELDS, type LayerSettingField } from './layerSettingsRanges';

export type LayerSettingsMaterialControl = {
  field: LayerSettingField;
  schema: LocalMaterialFieldSchema;
};

export type LayerSettingsMaterialRow = {
  controls: readonly LayerSettingsMaterialControl[];
};

const canonicalFields = new Set<string>(LAYER_SETTING_FIELDS);

function canonicalUnit(field: LayerSettingField): string {
  if (field.endsWith('MmMin')) return 'mm/min';
  if (field.endsWith('Mm')) return 'mm';
  if (field.endsWith('Sec')) return 's';
  return 'pwm';
}

/** Resolve opted-in material controls without loading the profile/plugin registry. */
export function resolveLayerSettingsMaterialRows(
  adapter: { fields: LocalMaterialFieldSchema[] } | null | undefined,
  supportedFields: readonly LayerSettingField[],
): LayerSettingsMaterialRow[] {
  const selectedFields = new Set<LayerSettingField>();
  const groups = new Map<string, LayerSettingsMaterialControl[]>();
  for (const schema of adapter?.fields ?? []) {
    const binding = schema.perLayerField ?? schema.key;
    if (schema.perLayerEditable !== true || schema.disabled
      || (schema.kind !== 'number' && schema.kind !== 'integer')
      || !canonicalFields.has(binding)) continue;
    const field = binding as LayerSettingField;
    if (!supportedFields.includes(field) || selectedFields.has(field)) continue;
    selectedFields.add(field);
    const placement = schema.placement;
    const groupKey = JSON.stringify([placement?.tabId, placement?.sectionId, placement?.cardId]);
    const group = groups.get(groupKey);
    const control = { field, schema };
    if (group) group.push(control);
    else groups.set(groupKey, [control]);
  }

  const rows: LayerSettingsMaterialRow[] = [];
  // Retain material group order and the profile form's stable intra-group ordering.
  for (const controls of groups.values()) {
    controls.sort((a, b) => (a.schema.placement?.order ?? 0) - (b.schema.placement?.order ?? 0));
    const byKey = new Map(controls.map((control) => [control.schema.key, control]));
    const pairedRows = new Map<LayerSettingsMaterialControl, LayerSettingsMaterialRow>();
    // Resolve declarations before emitting rows so a companion preceding its owner
    // is not first emitted alone. Declaration order sets the two value columns.
    for (const control of controls) {
      const companion = byKey.get(control.schema.splitWithKey ?? '');
      if (!companion || companion === control || pairedRows.has(control) || pairedRows.has(companion)
        || canonicalUnit(control.field) !== canonicalUnit(companion.field)) continue;
      const row = { controls: [control, companion] };
      pairedRows.set(control, row);
      pairedRows.set(companion, row);
    }
    const emitted = new Set<LayerSettingsMaterialRow>();
    for (const control of controls) {
      const row = pairedRows.get(control);
      if (!row) rows.push({ controls: [control] });
      else if (!emitted.has(row)) {
        emitted.add(row);
        rows.push(row);
      }
    }
  }
  return rows;
}
