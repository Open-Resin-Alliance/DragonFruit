import { isSensibleNanoDlpAdvancedField } from './advanced';
import { NANODLP_PRIMARY_EDIT_FIELDS } from './fields';
import type { NanoDlpMaterialProcessValues } from './types';

/**
 * Athena NanoDLP metadata mapping module.
 *
 * Responsibilities:
 * - normalize raw NanoDLP profile metadata into UI edit drafts,
 * - extract process values used to sync selected material settings,
 * - denormalize edited drafts back into backend-ready key/value payloads.
 */

/**
 * Return first finite numeric value from a key alias list.
 *
 * NanoDLP profiles commonly vary key names by firmware/version/vendor flavor.
 */
function firstMetaNumericValue(meta: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    if (!(key in meta)) continue;
    const value = Number(meta[key]);
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * Extract DragonFruit material-process values from raw NanoDLP profile metadata.
 *
 * Handles key aliases and converts layer height from microns to mm when needed.
 */
export function resolveNanodlpMaterialProcessValues(metaInput: Record<string, unknown>): NanoDlpMaterialProcessValues {
  const meta = metaInput ?? {};

  const rawLayerHeight = firstMetaNumericValue(meta, [
    'LayerHeight',
    'layerHeight',
    'SliceHeight',
    'sliceHeight',
    'Depth',
    'depth',
  ]);

  const layerHeightMm = rawLayerHeight == null
    ? undefined
    : (rawLayerHeight > 1 ? rawLayerHeight / 1000 : rawLayerHeight);

  const normalExposureSec = firstMetaNumericValue(meta, [
    'CureTime',
    'cureTime',
    'Exposure',
    'exposure',
    'NormalExposure',
    'normalExposure',
    'ExpTime',
  ]);

  const bottomExposureSec = firstMetaNumericValue(meta, [
    'SupportCureTime',
    'supportCureTime',
    'BottomCureTime',
    'bottomCureTime',
    'BottomExposure',
    'bottomExposure',
    'BottomExp',
    'bottomExp',
  ]);

  const bottomLayerCount = firstMetaNumericValue(meta, [
    'SupportLayerNumber',
    'supportLayerNumber',
    'BottomLayerCount',
    'bottomLayerCount',
    'BottomLayers',
    'bottomLayers',
  ]);

  return {
    layerHeightMm: layerHeightMm != null && layerHeightMm > 0 ? layerHeightMm : undefined,
    normalExposureSec: normalExposureSec != null && normalExposureSec > 0 ? normalExposureSec : undefined,
    bottomExposureSec: bottomExposureSec != null && bottomExposureSec > 0 ? bottomExposureSec : undefined,
    bottomLayerCount: bottomLayerCount != null && bottomLayerCount > 0 ? bottomLayerCount : undefined,
  };
}

/**
 * Build an editable draft from raw NanoDLP metadata.
 *
 * Includes:
 * - curated primary fields (with defaults and alias resolution),
 * - additional advanced fields that pass classifier heuristics.
 */
export function resolveNanodlpEditDraftFromMeta(metaInput: Record<string, unknown>): Record<string, string> {
  const meta = metaInput ?? {};
  const draft: Record<string, string> = {};

  for (const field of NANODLP_PRIMARY_EDIT_FIELDS) {
    const resolved = firstMetaNumericValue(meta, field.aliases);
    const normalized = field.key === 'SupportLayerNumber' || field.key === 'TransitionalLayer'
      ? Math.max(0, Math.round(resolved ?? field.defaultValue))
      : (resolved ?? field.defaultValue);
    draft[field.key] = String(normalized);
  }

  for (const [key, value] of Object.entries(meta)) {
    if (!isSensibleNanoDlpAdvancedField(key)) continue;
    if (value == null) continue;
    const editableValue = typeof value === 'string'
      ? value.trim()
      : typeof value === 'number'
        ? (Number.isFinite(value) ? String(value) : '')
        : typeof value === 'boolean'
          ? String(value)
          : '';
    if (!editableValue) continue;
    if (key.trim().length === 0) continue;
    if (key in draft) continue;
    draft[key] = editableValue;
  }

  return draft;
}

/**
 * Normalize UI draft payload before posting to NanoDLP backend.
 *
 * Trims empty keys/values and ensures integer semantics where required.
 */
export function denormalizeNanodlpEditDraftForBackend(draft: Record<string, string>): Record<string, string> {
  const payload: Record<string, string> = {};

  for (const [key, value] of Object.entries(draft)) {
    const normalizedKey = key.trim();
    const normalizedValue = String(value ?? '').trim();
    if (!normalizedKey || !normalizedValue) continue;
    if (normalizedKey === 'SupportLayerNumber') {
      const layerCount = Number(normalizedValue);
      payload[normalizedKey] = Number.isFinite(layerCount)
        ? String(Math.max(0, Math.round(layerCount)))
        : normalizedValue;
      continue;
    }
    payload[normalizedKey] = normalizedValue;
  }

  return payload;
}