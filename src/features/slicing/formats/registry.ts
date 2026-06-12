import type { PrinterOutputFormat } from '@/features/profiles/profileStore';
import type { ResolveSlicingFormatContext, SlicingFormatDefinition } from './types';
import { getBuiltinComplexPluginDefinitions } from '@/features/plugins/builtinComplexPlugins';
import { getProfileNetworkUiAdapter } from '@/features/plugins/pluginRegistry';
import { normalizeFormatVersion, normalizeSettingsMode } from '@/features/profiles/outputFormatUtils';

const CORE_LUMEN_FORMAT_DEFINITION: SlicingFormatDefinition = {
  id: 'core.lumen.v1',
  outputFormat: '.lumen',
  displayName: 'Lumen (Core Placeholder)',
  ownership: 'core',
  layerDataKind: 'png',
  rustModulePath: 'formats::lumen',
  wasmExportName: 'encode_lumen_container',
  notes: 'Placeholder format definition. Rust encoder scaffold only.',
};

function resolveBuiltinPluginSlicingFormat(
  outputFormat: PrinterOutputFormat,
  preferredPluginId?: string,
): SlicingFormatDefinition | null {
  if (preferredPluginId) {
    const preferred = getBuiltinComplexPluginDefinitions().find((definition) => definition.id === preferredPluginId);
    const preferredMatch = preferred?.slicingFormatsByOutput?.[outputFormat] as SlicingFormatDefinition | undefined;
    if (preferredMatch) return preferredMatch;
  }

  for (const definition of getBuiltinComplexPluginDefinitions()) {
    if (preferredPluginId && definition.id === preferredPluginId) continue;
    const formats = definition.slicingFormatsByOutput ?? {};
    const match = formats[outputFormat] as SlicingFormatDefinition | undefined;
    if (match) return match;
  }
  return null;
}

const CORE_FALLBACK_BY_OUTPUT_FORMAT: Partial<Record<PrinterOutputFormat, SlicingFormatDefinition>> = {
  '.lumen': CORE_LUMEN_FORMAT_DEFINITION,
};

export function outputFormatUsesPngLayers(outputFormat: PrinterOutputFormat | string | null | undefined): boolean {
  if (!outputFormat) return true;
  const format = outputFormat as PrinterOutputFormat;
  const definition = resolveBuiltinPluginSlicingFormat(format) ?? CORE_FALLBACK_BY_OUTPUT_FORMAT[format];
  if (!definition) return true;
  return definition.layerDataKind === 'png';
}

export function getAvailableOutputFormatOptions(): Array<{ value: PrinterOutputFormat; label: string }> {
  const formats = new Set<PrinterOutputFormat>();

  formats.add('.lumen');

  for (const definition of getBuiltinComplexPluginDefinitions()) {
    const pluginFormats = definition.slicingFormatsByOutput ?? {};
    for (const outputFormat of Object.keys(pluginFormats)) {
      if (typeof outputFormat === 'string' && outputFormat.trim().length > 0) {
        formats.add(outputFormat as PrinterOutputFormat);
      }
    }
  }

  return Array.from(formats)
    .sort((a, b) => a.localeCompare(b))
    .map((format) => ({ value: format, label: format }));
}

export function resolveSlicingFormatDefinition(context: ResolveSlicingFormatContext): SlicingFormatDefinition {
  const format = context.printerProfile.display.outputFormat;
  const preferredPluginId = getProfileNetworkUiAdapter(context.printerProfile.networkSupport)?.pluginId;

  const pluginOwnedFormat = resolveBuiltinPluginSlicingFormat(format, preferredPluginId);
  if (pluginOwnedFormat) {
    return pluginOwnedFormat;
  }

  return CORE_FALLBACK_BY_OUTPUT_FORMAT[format] ?? CORE_LUMEN_FORMAT_DEFINITION;
}

function resolveSlicingFormatDefinitionByOutput(
  outputFormat: PrinterOutputFormat,
  preferredPluginId?: string,
): SlicingFormatDefinition | null {
  return resolveBuiltinPluginSlicingFormat(outputFormat, preferredPluginId)
    ?? CORE_FALLBACK_BY_OUTPUT_FORMAT[outputFormat]
    ?? null;
}

export function getAvailableFormatVersionOptions(
  outputFormat: PrinterOutputFormat | string | null | undefined,
  preferredPluginId?: string,
): Array<{ value: string; label: string; isDefault?: boolean }> {
  if (!outputFormat) return [];

  const definition = resolveSlicingFormatDefinitionByOutput(outputFormat as PrinterOutputFormat, preferredPluginId);
  return (definition?.formatVersions ?? []).map((entry) => ({
    value: entry.value,
    label: entry.label,
    isDefault: entry.isDefault,
  }));
}

export function resolveOutputFormatVersion(
  outputFormat: PrinterOutputFormat | string | null | undefined,
  requestedVersion: string | null | undefined,
  preferredPluginId?: string,
): string | undefined {
  const normalizedRequested = normalizeFormatVersion(requestedVersion);
  if (!outputFormat) return normalizedRequested;

  const options = getAvailableFormatVersionOptions(outputFormat, preferredPluginId);
  if (options.length === 0) {
    return normalizedRequested;
  }

  if (normalizedRequested) {
    const matched = options.find((entry) => entry.value.toLowerCase() === normalizedRequested.toLowerCase());
    if (matched) return matched.value;
  }

  const defaultOption = options.find((entry) => entry.isDefault);
  return (defaultOption ?? options[0])?.value;
}

export function getAvailableSettingsModeOptions(
  outputFormat: PrinterOutputFormat | string | null | undefined,
  preferredPluginId?: string,
): Array<{ value: string; label: string; isDefault?: boolean }> {
  if (!outputFormat) return [];

  const definition = resolveSlicingFormatDefinitionByOutput(outputFormat as PrinterOutputFormat, preferredPluginId);
  return (definition?.settingsModes ?? []).map((entry) => ({
    value: entry.value,
    label: entry.label,
    isDefault: entry.isDefault,
  }));
}

export function resolveOutputSettingsMode(
  outputFormat: PrinterOutputFormat | string | null | undefined,
  requestedMode: string | null | undefined,
  preferredPluginId?: string,
): string | undefined {
  const normalizedRequested = normalizeSettingsMode(requestedMode);
  if (!outputFormat) return normalizedRequested;

  const options = getAvailableSettingsModeOptions(outputFormat, preferredPluginId);
  if (options.length === 0) {
    return normalizedRequested;
  }

  if (normalizedRequested) {
    const matched = options.find((entry) => entry.value.toLowerCase() === normalizedRequested.toLowerCase());
    if (matched) return matched.value;
  }

  const defaultOption = options.find((entry) => entry.isDefault);
  return (defaultOption ?? options[0])?.value;
}
