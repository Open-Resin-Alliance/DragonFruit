import { normalizeFormatVersion } from '@/features/profiles/outputFormatUtils';
import type { LayerSettingField } from '../layerSettingsRanges';
import type { SlicingFormatDefinition } from './types';

/** Version capabilities replace the format list; absent capabilities mean unsupported. */
export function resolveLayerSettingsFields(
  definition: SlicingFormatDefinition,
  formatVersion?: string,
): readonly LayerSettingField[] {
  const normalized = normalizeFormatVersion(formatVersion);
  const versions = definition.formatVersions ?? [];
  const version = versions.find((entry) => normalized && entry.value.toLowerCase() === normalized.toLowerCase())
    ?? versions.find((entry) => entry.isDefault)
    ?? versions[0];
  return version?.layerSettingsFields ?? definition.layerSettingsFields ?? [];
}
