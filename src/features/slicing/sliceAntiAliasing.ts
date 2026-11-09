import {
  DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS,
  type MaterialAntiAliasingSettings,
  type MaterialProfile,
  type PrinterProfile,
} from '@/features/profiles/profileStore';
import { getProfileLocalMaterialSettingsAdapter } from '@/features/plugins/pluginRegistry';
import { computePhysicalAaConfig, type AaPreset } from './autoAaPhysics';
import { resolveOutputSettingsMode, resolveSlicingFormatDefinition } from './formats/registry';
import { clampSliceJobNumber } from './sliceJobLimits';
import {
  DEFAULT_CLEAR_EXP_100_CURVE,
  DEFAULT_OPAQUE_EXP_120_230_CURVE,
  sampleCurveToLut,
  type SavedCurve,
} from './lutCurves';
import type { AntiAliasingLevel } from './tauri/nativeSlicerBridge';

/**
 * Slice anti-aliasing resolution: turns what the user chose (an auto preset, or
 * the material's AA settings with a session override on top) into the
 * anti-aliasing half of a slice job.
 *
 * Pure: no React, Tauri, `window` or browser storage. The slicing panel and the
 * `scene slice` CLI both call it; see `docs/dev/slice-job-assembly.md`.
 */

/** The panel's auto AA choice. `raw` turns anti-aliasing off. */
export type AaAutoPresetChoice = 'raw' | AaPreset;

/**
 * A session override, in the shape the panel keeps it: the material's AA
 * settings and its minimum AA alpha, applied on top of the material's own.
 */
export type SliceAntiAliasingOverride = {
  antiAliasingSettings?: Partial<MaterialAntiAliasingSettings>;
  minimumAaAlphaPercent?: number;
};

export type SliceAntiAliasingInput = {
  printerProfile: PrinterProfile | null;
  /** The material as the store resolves it (the one the job is sliced with). */
  materialProfile: MaterialProfile | null;
  override?: SliceAntiAliasingOverride | null;
  preset: AaAutoPresetChoice;
  /** The job's layer height; anything not positive falls back to 0.05 mm. */
  layerHeightMm: number | null;
  /** The user's LUT curve library, looked up by `selectedLutCurveId`. */
  lutCurves?: readonly SavedCurve[];
};

export type AutoAaResolvedConfig = {
  aaMode: 'Off' | 'Blur' | '3DAA';
  antiAliasingMode: 'Coverage' | 'Blur' | 'Vertical2';
  aaSteps: number;
  blurBrushRadiusPx: number;
  zBlurRadiusLayers: number;
  zBlendLookBack: number;
};

/** The anti-aliasing options the panel hands the slice export orchestrator. */
export type SliceAntiAliasingOptions = {
  aaOnSupports: boolean;
  antiAliasingLevel: AntiAliasingLevel;
  antiAliasingMode: 'Blur' | '3DAA' | 'Vertical2' | 'Coverage';
  supportTipShrinkPercent: number;
  blurBrushRadiusPx: number;
  blurBrushKernel: 'box' | 'gaussian';
  blurBrushSigmaX: number;
  blurBrushSigmaY: number;
  zBlurRadiusLayers: number;
  zBlurKernel: 'box' | 'gaussian';
  zBlurSigma: number;
  zBlendLookBack: number | undefined;
  zBlendMinimumAlphaPercent: number | undefined;
  zBlendMaxAlphaPercent: number;
  zBlendCustomLut: number[] | undefined;
  zaaKernel: 'perturb' | undefined;
  zaaPattern: 'uniform' | 'halton' | 'base2' | undefined;
  zaaDuplicateZ: boolean | undefined;
  minimumAaAlphaPercentOverride: number;
};

/** What the decision was, for the panel's summary and controls. */
export type SliceAntiAliasingDecision = {
  available: boolean;
  overrideEnabled: boolean;
  settings: MaterialAntiAliasingSettings;
  autoConfig: AutoAaResolvedConfig;
  mode: 'Off' | 'Blur' | '3DAA';
  level: AntiAliasingLevel;
  duplicateZSupported: boolean;
  minimumAaAlpha: { available: boolean; value: number };
};

export type SliceAntiAliasing = {
  options: SliceAntiAliasingOptions;
  decision: SliceAntiAliasingDecision;
  /**
   * Choices that could not be honoured and what was used instead. The panel
   * slices anyway; the CLI refuses, since a silent fallback in a test run is
   * a wrong result.
   */
  warnings: string[];
};

const AA_STRENGTH_MIN_STEPS = 2;
const AA_STRENGTH_MAX_STEPS = 64;

/** Max-alpha (%) for the cure-window LUT keyed by material transparency. */
const Z_BLEND_MAX_ALPHA_BY_RESIN = {
  opaque: 90,
  clear: 65,
} as const;

const RAW_AUTO_AA_CONFIG: AutoAaResolvedConfig = {
  aaMode: 'Off',
  antiAliasingMode: 'Coverage',
  aaSteps: 0,
  blurBrushRadiusPx: 0,
  zBlurRadiusLayers: 0,
  zBlendLookBack: 0,
};

export function parseAaLevelSteps(level: string | null | undefined): number | null {
  const trimmed = (level ?? '').trim().toLowerCase();
  if (!trimmed.endsWith('x')) return null;
  const parsed = Number(trimmed.slice(0, -1));
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed);
}

function clampAaLevelSteps(value: number): number {
  const next = Number.isFinite(value) ? value : 4;
  return Math.max(AA_STRENGTH_MIN_STEPS, Math.min(AA_STRENGTH_MAX_STEPS, Math.round(next)));
}

export function formatAaLevel(steps: number): `${number}x` {
  return `${clampAaLevelSteps(steps)}x` as `${number}x`;
}

export function clampBlurSigma(value: number, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0.05, Math.min(16, Math.round(numeric * 100) / 100));
}

/**
 * Physical XY pixel pitch (mm). Prefers the explicit pixelSize (µm, straight
 * from the manufacturer spec) over build volume ÷ resolution, which is stored
 * at only three decimals.
 */
export function resolvePixelPitchMm(printerProfile: PrinterProfile | null): { x: number; y: number } {
  const pxSizeX = Number(printerProfile?.pixelSize?.x);
  const pxSizeY = Number(printerProfile?.pixelSize?.y);
  if (Number.isFinite(pxSizeX) && Number.isFinite(pxSizeY) && pxSizeX > 0 && pxSizeY > 0) {
    return {
      x: pxSizeX / 1000,
      y: pxSizeY / 1000,
    }; // µm → mm
  }

  const resX = Number(printerProfile?.display?.resolutionX);
  const resY = Number(printerProfile?.display?.resolutionY);
  const buildW = Number(printerProfile?.buildVolumeMm?.width);
  const buildD = Number(printerProfile?.buildVolumeMm?.depth);

  let pitchX: number | null = null;
  let pitchY: number | null = null;
  if (Number.isFinite(resX) && Number.isFinite(buildW) && resX > 0 && buildW > 0) {
    pitchX = buildW / resX;
  }
  if (Number.isFinite(resY) && Number.isFinite(buildD) && resY > 0 && buildD > 0) {
    pitchY = buildD / resY;
  }
  return {
    x: pitchX ?? pitchY ?? 0.05,
    y: pitchY ?? pitchX ?? 0.05,
  };
}

let defaultLuts: { opaque: number[]; clear: number[] } | null = null;
function getDefaultLuts(): { opaque: number[]; clear: number[] } {
  defaultLuts ??= {
    opaque: sampleCurveToLut(DEFAULT_OPAQUE_EXP_120_230_CURVE),
    clear: sampleCurveToLut(DEFAULT_CLEAR_EXP_100_CURVE),
  };
  return defaultLuts;
}

function resolveMinimumAaAlpha(
  printerProfile: PrinterProfile | null,
  materialProfile: MaterialProfile | null,
  override: SliceAntiAliasingOverride | null | undefined,
): { available: boolean; value: number } {
  const fallback = Math.max(
    0,
    Math.min(100, Math.round(Number(override?.minimumAaAlphaPercent ?? materialProfile?.minimumAaAlphaPercent ?? 35))),
  );

  if (!materialProfile) {
    return { available: false, value: fallback };
  }

  const selectedFormat = printerProfile
    ? resolveSlicingFormatDefinition({ printerProfile, materialProfile })
    : null;
  const outputFormat = (selectedFormat?.outputFormat ?? printerProfile?.display.outputFormat ?? '').trim();
  if (!outputFormat) {
    return { available: false, value: fallback };
  }

  const normalizedOutput = outputFormat.toLowerCase();
  const outputWithoutDot = normalizedOutput.replace(/^\./, '');
  const settingsMode = resolveOutputSettingsMode(outputFormat, printerProfile?.display.settingsMode);

  const localAdapter = getProfileLocalMaterialSettingsAdapter(outputFormat, settingsMode);
  const profileField = localAdapter?.fields.find((field) => {
    const metadataPath = field.metadataPath?.trim().toLowerCase();
    return metadataPath === 'dragonfruit.minimumaaalphapercent' || field.key === 'minimumAaAlphaPercent';
  });

  if (!profileField) {
    return { available: false, value: fallback };
  }

  const localForOutput = materialProfile.localSettingsByOutput?.[normalizedOutput]
    ?? materialProfile.localSettingsByOutput?.[outputWithoutDot]
    ?? null;

  const parsed = Number(localForOutput?.[profileField.key]);
  if (!Number.isFinite(parsed)) {
    return { available: true, value: fallback };
  }

  return { available: true, value: Math.max(0, Math.min(100, Math.round(parsed))) };
}

export function resolveSliceAntiAliasing(input: SliceAntiAliasingInput): SliceAntiAliasing {
  const { printerProfile, materialProfile, override } = input;

  const settings: MaterialAntiAliasingSettings = {
    ...DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS,
    ...(materialProfile?.antiAliasingSettings ?? {}),
    ...(override?.antiAliasingSettings ?? {}),
  };

  // Respect printer-profile capability: explicit `false` means AA must be disabled.
  const available = printerProfile != null && printerProfile.antiAliasing !== false;

  const layerHeightMm = Number(input.layerHeightMm);
  const safeLayerH = Number.isFinite(layerHeightMm) && layerHeightMm > 0 ? layerHeightMm : 0.05;
  const pixelPitchMm = resolvePixelPitchMm(printerProfile);

  const autoConfig: AutoAaResolvedConfig = input.preset === 'raw'
    ? RAW_AUTO_AA_CONFIG
    : computePhysicalAaConfig(input.preset, pixelPitchMm.x, safeLayerH, pixelPitchMm.y);
  const autoZBlendLookBack = computePhysicalAaConfig('balanced', pixelPitchMm.x, safeLayerH, pixelPitchMm.y).zBlendLookBack;

  const overrideEnabled = settings.enableOverride === true;

  const mode = overrideEnabled ? settings.mode : autoConfig.aaMode;
  const level: AntiAliasingLevel = overrideEnabled
    ? formatAaLevel(parseAaLevelSteps(settings.level) ?? 4)
    : (autoConfig.aaMode === 'Off' ? 'Off' : formatAaLevel(autoConfig.aaSteps || 4));

  const blurBrushRadiusPx = overrideEnabled
    ? settings.blurBrushRadiusPx
    : autoConfig.blurBrushRadiusPx;
  const blurBrushKernel = overrideEnabled && settings.useCustomBlurBrushRadius
    ? settings.blurBrushKernel
    : 'gaussian';
  const blurBrushSigmaX = clampBlurSigma(settings.blurBrushSigmaX, 0.5);
  const blurBrushSigmaY = clampBlurSigma(settings.blurBrushSigmaY, 0.5);
  const zBlurRadiusLayers = mode === '3DAA'
    ? (overrideEnabled ? settings.zBlurRadiusLayers : autoConfig.zBlurRadiusLayers)
    : 0;
  const zBlurKernel = overrideEnabled && settings.useCustomZBlurRadius
    ? settings.zBlurKernel
    : 'box';
  const zBlurSigma = clampBlurSigma(settings.zBlurSigma, 0.5);
  const zBlendLookBack = mode === '3DAA' ? autoZBlendLookBack : 0;

  const antiAliasingLevel: AntiAliasingLevel =
    !available || mode === 'Off' ? 'Off' : level;
  const antiAliasingMode: 'Blur' | '3DAA' | 'Vertical2' | 'Coverage' =
    !available || mode === 'Off' ? 'Coverage' :
    mode === '3DAA' ? 'Vertical2' :
    'Blur';
  const zaaKernel = mode === '3DAA' ? 'perturb' as const : undefined;
  const zaaPattern = mode === '3DAA' ? settings.zaaPattern : undefined;
  const zaaDuplicateZ = mode === '3DAA' ? settings.zaaDuplicateZ : undefined;
  const duplicateZSupported = (parseAaLevelSteps(level) ?? 4) >= 16;

  const autoDetectedResinType: 'opaque' | 'clear' = /\bclear\b/i.test(materialProfile?.name ?? '') ? 'clear' : 'opaque';
  const blurGraySourceMode = overrideEnabled ? settings.blurGraySourceMode : 'lut';
  const zBlendResinType = overrideEnabled ? settings.zBlendResinType : autoDetectedResinType;
  // Without an override the resin type is auto-detected as opaque or clear, so
  // the custom curve below is only ever reached through the override's id.
  const customLutCurve = overrideEnabled
    ? (input.lutCurves ?? []).find((curve) => curve.id === settings.selectedLutCurveId) ?? null
    : null;
  const warnings: string[] = [];
  if (zBlendResinType === 'custom' && !customLutCurve) {
    warnings.push(`LUT curve '${settings.selectedLutCurveId}' is not in the curve library; using the default opaque curve.`);
  }
  const defaults = getDefaultLuts();
  const customLut = customLutCurve ? sampleCurveToLut(customLutCurve.points) : defaults.opaque;
  const zBlendMaxAlphaPercent = zBlendResinType === 'clear'
    ? Z_BLEND_MAX_ALPHA_BY_RESIN.clear
    : zBlendResinType === 'custom'
      ? Math.max(...customLut) / 255 * 100
      : Z_BLEND_MAX_ALPHA_BY_RESIN.opaque;
  const useLutCurve =
    (antiAliasingMode === 'Vertical2' || antiAliasingMode === 'Blur' || antiAliasingMode === 'Coverage')
    && blurGraySourceMode === 'lut';

  const minimumAaAlpha = resolveMinimumAaAlpha(printerProfile, materialProfile, override);

  return {
    options: {
      aaOnSupports: settings.aaOnSupports === true,
      antiAliasingLevel,
      antiAliasingMode,
      supportTipShrinkPercent: settings.supportTipShrinkPercent,
      blurBrushRadiusPx,
      blurBrushKernel,
      blurBrushSigmaX,
      blurBrushSigmaY,
      zBlurRadiusLayers,
      zBlurKernel,
      zBlurSigma,
      zBlendLookBack: mode === '3DAA' ? zBlendLookBack : undefined,
      zBlendMinimumAlphaPercent: mode === '3DAA' ? minimumAaAlpha.value : undefined,
      zBlendMaxAlphaPercent: mode === '3DAA' ? zBlendMaxAlphaPercent : 90,
      zBlendCustomLut: useLutCurve
        ? (zBlendResinType === 'clear'
            ? defaults.clear
            : zBlendResinType === 'custom'
              ? customLut
              : defaults.opaque)
        : undefined,
      zaaKernel,
      zaaPattern,
      zaaDuplicateZ,
      minimumAaAlphaPercentOverride: useLutCurve && antiAliasingMode === 'Blur'
        ? 0
        : minimumAaAlpha.value,
    },
    decision: {
      available,
      overrideEnabled,
      settings,
      autoConfig,
      mode,
      level,
      duplicateZSupported,
      minimumAaAlpha,
    },
    warnings,
  };
}

// ── The job's anti-aliasing fields ────────────────────────────────────────────

/**
 * What a caller asks for: everything `resolveSliceAntiAliasing` needs besides
 * the printer, the material and the layer height, which the job already has.
 */
export type SliceJobAntiAliasingRequest = Pick<SliceAntiAliasingInput, 'preset' | 'override' | 'lutCurves'>;

/** The anti-aliasing fields of the native slice job. */
export type SliceJobAntiAliasing = {
  antiAliasingLevel: AntiAliasingLevel;
  antiAliasingMode: 'Blur' | '3DAA' | 'Vertical2' | 'Coverage';
  blurBrushRadiusPx: number;
  blurBrushKernel: 'box' | 'gaussian';
  blurBrushSigmaX: number;
  blurBrushSigmaY: number;
  zBlurRadiusLayers: number;
  zBlurKernel: 'box' | 'gaussian';
  zBlurSigma: number;
  zBlendLookBack: number;
  zBlendMinimumAlphaPercent: number;
  zBlendMaxAlphaPercent: number;
  zBlendCustomLut: number[] | undefined;
  zaaKernel: 'perturb' | undefined;
  zaaPattern: 'uniform' | 'halton' | 'base2' | undefined;
  zaaDuplicateZ: boolean | undefined;
  /** Undefined when nothing was requested; the export falls back to the performance setting. */
  aaOnSupports: boolean | undefined;
  minimumAaAlphaPercent: number;
  /**
   * How much support contact tips shrink before slicing. Geometry, applied
   * while the mesh is prepared — not a field the native slicer receives.
   */
  supportTipShrinkPercent: number;
  /** See `SliceAntiAliasing.warnings`. Not part of the job. */
  warnings: string[];
};

/**
 * The anti-aliasing fields of a slice job. Without a request, the job gets the
 * engine defaults: anti-aliasing off.
 */
export function resolveSliceJobAntiAliasing(input: {
  printerProfile: PrinterProfile;
  materialProfile: MaterialProfile;
  layerHeightMm: number;
  request?: SliceJobAntiAliasingRequest;
}): SliceJobAntiAliasing {
  const { materialProfile } = input;
  const resolved = input.request
    ? resolveSliceAntiAliasing({
        printerProfile: input.printerProfile,
        materialProfile,
        layerHeightMm: input.layerHeightMm,
        ...input.request,
      })
    : null;
  const options: Partial<SliceAntiAliasingOptions> = resolved?.options ?? {};

  const requestedTipShrinkPercent = options.supportTipShrinkPercent
    ?? materialProfile.antiAliasingSettings?.supportTipShrinkPercent
    ?? DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS.supportTipShrinkPercent;
  const supportTipShrinkPercent = (
    (options.antiAliasingMode === 'Vertical2' || options.antiAliasingMode === '3DAA')
    && (options.antiAliasingLevel ?? 'Off') !== 'Off'
  ) ? Math.round(Math.max(0, Math.min(90,
      Number.isFinite(requestedTipShrinkPercent)
        ? requestedTipShrinkPercent
        : DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS.supportTipShrinkPercent,
    ))) : 0;

  return {
    antiAliasingLevel: options.antiAliasingLevel ?? 'Off',
    antiAliasingMode: options.antiAliasingMode ?? 'Blur',
    blurBrushRadiusPx: clampSliceJobNumber('blurBrushRadiusPx', options.blurBrushRadiusPx),
    blurBrushKernel: options.blurBrushKernel ?? 'gaussian',
    blurBrushSigmaX: clampSliceJobNumber('blurBrushSigmaX', options.blurBrushSigmaX),
    blurBrushSigmaY: clampSliceJobNumber('blurBrushSigmaY', options.blurBrushSigmaY),
    zBlurRadiusLayers: clampSliceJobNumber('zBlurRadiusLayers', options.zBlurRadiusLayers),
    zBlurKernel: options.zBlurKernel ?? 'box',
    zBlurSigma: clampSliceJobNumber('zBlurSigma', options.zBlurSigma),
    zBlendLookBack: clampSliceJobNumber('zBlendLookBack', options.zBlendLookBack),
    zBlendMinimumAlphaPercent: clampSliceJobNumber('zBlendMinimumAlphaPercent', options.zBlendMinimumAlphaPercent),
    zBlendMaxAlphaPercent: clampSliceJobNumber('zBlendMaxAlphaPercent', options.zBlendMaxAlphaPercent),
    zBlendCustomLut: options.zBlendCustomLut,
    zaaKernel: options.zaaKernel,
    zaaPattern: options.zaaPattern,
    zaaDuplicateZ: options.zaaDuplicateZ,
    aaOnSupports: options.aaOnSupports,
    minimumAaAlphaPercent: clampSliceJobNumber(
      'minimumAaAlphaPercent',
      options.minimumAaAlphaPercentOverride
      ?? materialProfile.minimumAaAlphaPercent
      ?? 50,
    ),
    supportTipShrinkPercent,
    warnings: resolved?.warnings ?? [],
  };
}
