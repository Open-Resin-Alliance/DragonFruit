import type { MaterialProfile, PrinterProfile } from '@/features/profiles/profileStore';
import { getProfileLocalMaterialSettingsAdapter } from '@/features/plugins/pluginRegistry';
import { resolveSlicingFormatDefinition } from '@/features/slicing/formats/registry';

/**
 * Slice-job assembly: printer profile, material profile and scene facts in, the
 * fields of the native slice job and its `metadata_json` out.
 *
 * Pure on purpose: no React, Tauri, `window` or THREE. The app's export and the
 * `scene slice` CLI both build their job here, so the two cannot drift. See
 * docs/dev/slice-job-assembly.md.
 */

// The app, not the engine: format encoders stamp this as the slicer that made the
// file. Left out when unknown (e.g. under tests) so no encoder writes a guess.
export const SLICER_IDENTITY = {
  name: 'DragonFruit',
  version: process.env.NEXT_PUBLIC_APP_VERSION || undefined,
};

const MAX_CANVAS_PIXELS = 24_000_000;

export type SliceRasterSettings = {
  widthPx: number;
  heightPx: number;
  sourceResolutionX: number;
  sourceResolutionY: number;
  xPackingMode: 'none' | 'rgb8_div3' | 'gray3_div2';
  mirrorX: boolean;
  mirrorY: boolean;
  layerHeightMm: number;
  totalLayers: number;
  tallestObjectHeightMm: number;
};

function resolvePluginPackedWidth(printerProfile: PrinterProfile): {
  widthPx: number;
  sourceResolutionX: number;
  sourceResolutionY: number;
  xPackingMode: 'none' | 'rgb8_div3' | 'gray3_div2';
} {
  const sourceResolutionX = Math.max(1, Math.round(printerProfile.display.resolutionX));
  const sourceResolutionY = Math.max(1, Math.round(printerProfile.display.resolutionY));

  const explicitBitDepth = Number(printerProfile.bitDepth?.bits);
  let bitDepth = Number.isFinite(explicitBitDepth) && explicitBitDepth > 0
    ? Math.round(explicitBitDepth)
    : 0;

  if (bitDepth <= 0) {
    const fingerprint = [
      printerProfile.name,
      printerProfile.manufacturer,
      printerProfile.officialPresetId,
      printerProfile.id,
    ]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join(' ')
      .toLowerCase();

    if (/\b3\s*[-_ ]?bit\b|\b3b\b|16k3b|gray3/.test(fingerprint)) {
      bitDepth = 3;
    } else if (/\b8\s*[-_ ]?bit\b|\b8b\b|rgb8/.test(fingerprint)) {
      bitDepth = 8;
    } else {
      const divisibleBy2 = sourceResolutionX % 2 === 0;
      const divisibleBy3 = sourceResolutionX % 3 === 0;

      if (divisibleBy2 && !divisibleBy3) {
        bitDepth = 3;
      } else if (divisibleBy3 && !divisibleBy2) {
        bitDepth = 8;
      } else if (divisibleBy2 && divisibleBy3) {
        // Ambiguous resolution: prefer Mono/3-bit path for Athena-class NanoDLP printers.
        bitDepth = /rgb|color/.test(fingerprint) ? 8 : 3;
      } else {
        // Failsafe: NanoDLP path should remain packed; default to 3-bit packing.
        bitDepth = 3;
      }
    }
  }

  if (bitDepth === 8) {
    // NanoDLP RGB 8-bit path packs 3 subpixels into 1 RGB output pixel on X.
    return {
      widthPx: Math.max(1, Math.floor(sourceResolutionX / 3)),
      sourceResolutionX,
      sourceResolutionY,
      xPackingMode: 'rgb8_div3',
    };
  }

  if (bitDepth === 3) {
    // NanoDLP 3-bit path packs 2 source subpixels into 1 grayscale output pixel on X.
    return {
      widthPx: Math.max(1, Math.floor(sourceResolutionX / 2)),
      sourceResolutionX,
      sourceResolutionY,
      xPackingMode: 'gray3_div2',
    };
  }

  // Unknown/unsupported bit-depth values still default to 3-bit packed path for NanoDLP.
  return {
    widthPx: Math.max(1, Math.floor(sourceResolutionX / 2)),
    sourceResolutionX,
    sourceResolutionY,
    xPackingMode: 'gray3_div2',
  };
}

export function resolveSliceRasterSettings(options: {
  printerProfile: PrinterProfile;
  materialProfile: MaterialProfile;
}): SliceRasterSettings {
  const sourceResolutionX = Math.max(1, Math.round(options.printerProfile.display.resolutionX));
  const sourceResolutionY = Math.max(1, Math.round(options.printerProfile.display.resolutionY));

  const resolvedFormat = resolveSlicingFormatDefinition({
    printerProfile: options.printerProfile,
    materialProfile: options.materialProfile,
  });
  // Same rule as the orchestrator: an unresolved format is an error, never another
  // format's settings. `resolveSliceRasterSettings` is reached from the same export.
  if (!resolvedFormat) {
    throw new Error(
      `No encoder is installed for "${options.printerProfile.display.outputFormat}".`,
    );
  }
  const usesPluginOwnedEncoding = resolvedFormat.ownership === 'plugin';
  const xPackingStrategy = resolvedFormat.xPackingStrategy ?? 'none';

  const packed = xPackingStrategy === 'bitdepth-packed-x'
    ? resolvePluginPackedWidth(options.printerProfile)
    : {
      widthPx: sourceResolutionX,
      sourceResolutionX,
      sourceResolutionY,
      xPackingMode: 'none' as const,
    };

  let widthPx = packed.widthPx;
  let heightPx = packed.sourceResolutionY;

  const pixelCount = widthPx * heightPx;
  if (pixelCount > MAX_CANVAS_PIXELS && !usesPluginOwnedEncoding) {
    const scale = Math.sqrt(MAX_CANVAS_PIXELS / pixelCount);
    widthPx = Math.max(1, Math.floor(widthPx * scale));
    heightPx = Math.max(1, Math.floor(heightPx * scale));
  }

  const layerHeightMm = Math.max(0.001, Number(options.materialProfile.layerHeightMm) || 0.05);

  return {
    widthPx,
    heightPx,
    sourceResolutionX: packed.sourceResolutionX,
    sourceResolutionY: packed.sourceResolutionY,
    xPackingMode: packed.xPackingMode,
    mirrorX: options.printerProfile.display.mirrorX === true,
    mirrorY: options.printerProfile.display.mirrorY === true,
    layerHeightMm,
    totalLayers: 1,
    tallestObjectHeightMm: layerHeightMm,
  };
}

function setMetadataPathValue(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path
    .split('.')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) return;

  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    const existing = cursor[segment];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }

  cursor[segments[segments.length - 1]] = value;
}

function coerceLocalMaterialSettingValue(
  rawValue: string | number | boolean,
  kind: 'number' | 'integer' | 'text' | 'boolean' | 'select',
): string | number | boolean {
  if (kind === 'boolean') {
    if (typeof rawValue === 'boolean') return rawValue;
    if (typeof rawValue === 'string') {
      const normalized = rawValue.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
    return Boolean(rawValue);
  }

  if (kind === 'number' || kind === 'integer') {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) return kind === 'integer' ? 0 : 0;
    return kind === 'integer' ? Math.round(parsed) : parsed;
  }

  return String(rawValue);
}

export function mergeMetadataOverridesIntoMetadata(
  metadataJson: string,
  outputFormat: string,
  materialProfile: MaterialProfile,
  settingsMode?: string,
  printerOutputFormat?: string,
): string {
  try {
    const parsed = JSON.parse(metadataJson) as Record<string, unknown>;

    if (settingsMode) {
      const printer = (parsed.printer ?? {}) as Record<string, unknown>;
      parsed.printer = {
        ...printer,
        settingsMode,
      };

      const exportNode = (parsed.export ?? {}) as Record<string, unknown>;
      const formatKey = outputFormat.replace(/^\./, '').toLowerCase();
      const formatNode = (exportNode[formatKey] ?? {}) as Record<string, unknown>;
      exportNode[formatKey] = {
        ...formatNode,
        settingsMode,
      };
      parsed.export = exportNode;
    }

    const adapter = getProfileLocalMaterialSettingsAdapter(printerOutputFormat ?? outputFormat, settingsMode)
      ?? getProfileLocalMaterialSettingsAdapter(outputFormat, settingsMode);
    const fieldSchema = adapter?.fields ?? [];
    if (fieldSchema.length > 0) {
      const localForOutput = materialProfile.localSettingsByOutput?.[printerOutputFormat ?? outputFormat]
        ?? materialProfile.localSettingsByOutput?.[outputFormat]
        ?? {};

      fieldSchema.forEach((field) => {
        if (field.kind === 'spacer') return;

        const fieldValue = Object.prototype.hasOwnProperty.call(localForOutput, field.key)
          ? localForOutput[field.key]
          : field.defaultValue;

        const coercedValue = coerceLocalMaterialSettingValue(
          fieldValue,
          field.kind,
        );

        const targetPath = (field.metadataPath?.trim() || `material.${field.key}`);
        setMetadataPathValue(parsed, targetPath, coercedValue);
      });
    }

    return JSON.stringify(parsed);
  } catch {
    return metadataJson;
  }
}
