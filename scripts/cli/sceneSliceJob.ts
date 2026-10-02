/**
 * Slice-job assembly for `scene slice`: printer profile, material and flags in,
 * the arguments for `dragonfruit-cli slice run` out.
 *
 * The job comes from the app's own code, not from a copy of it: profiles go
 * through the profile store the way the app adds them, and the job fields and
 * `metadata_json` come from `assembleSliceJob`. See docs/dev/slice-job-assembly.md.
 *
 * Kept apart from the CLI entry point so tests can import it without running
 * `main()`, and so the CLI loads it (and the plugin registry it needs) only for
 * `scene slice`.
 */

import { computePhysicalAaConfig, type AaPreset } from '../../src/features/slicing/autoAaPhysics';
import {
  addMaterialProfile,
  addPrinterProfileFromPreset,
  getAvailablePrinterPresets,
  getMaterialProfilesForPrinter,
  getProfileStoreSnapshot,
  importPrinterBundle,
  type MaterialProfile,
  type PrinterProfile,
} from '../../src/features/profiles/profileStore';
import {
  assembleSliceJob,
  resolveSliceLayerCount,
  resolveSliceRasterSettings,
  type AssembledSliceJob,
  type SliceJobManifestModel,
} from '../../src/features/slicing/sliceJobAssembly';

export interface SceneSliceJobOptions {
  /** Parsed printer JSON: an official preset, a custom profile, a list of either, or an app-exported bundle. */
  printer?: unknown;
  printerId?: string;
  /** Parsed material JSON. Without it, the bundle's first material or the printer's default is used. */
  material?: unknown;
  layerHeight?: string;
  buildWidthMm?: string;
  buildDepthMm?: string;
  aaPreset?: AaPreset | 'raw';
  dither?: string;
  ditherBitDepth?: string;
  ditherDeviceGamma?: string;
}

export interface SceneSliceJob {
  /** The printer as the profile store holds it, with `--build-*-mm` applied. */
  printer: PrinterProfile | null;
  /** The material as the profile store holds it, with `--layer-height` applied. */
  material: MaterialProfile | null;
  aaPreset?: AaPreset | 'raw';
  dither: { ditherEnabled?: boolean; ditherBitDepth?: number; ditherDeviceGamma?: number };
  /** Raw engine values, used only without a printer. */
  layerHeight: string;
  buildWidth: string;
  buildDepth: string;
}

type Profile = Record<string, unknown>;

const isObject = (value: unknown): value is Profile => value !== null && typeof value === 'object' && !Array.isArray(value);

/** An app-exported bundle wraps the profile as `{ version, printer, materials, … }`. */
const isBundle = (value: unknown): value is Profile & { printer: Profile } => (
  isObject(value) && isObject(value.printer) && value.display == null
);

function pickPrinterEntry(raw: unknown, wantId?: string): unknown {
  const list = Array.isArray(raw) ? raw : [raw];
  const profileOf = (entry: unknown): Profile => (isBundle(entry) ? entry.printer : isObject(entry) ? entry : {});
  if (wantId) {
    const hit = list.find((entry) => {
      const p = profileOf(entry);
      return p.id === wantId || p.name === wantId || p.presetId === wantId || p.officialPresetId === wantId;
    });
    if (!hit) {
      throw new Error(
        `Printer '${wantId}' not found (have: ${list.map((entry) => profileOf(entry).id ?? profileOf(entry).name).join(', ')})`,
      );
    }
    return hit;
  }
  if (list.length !== 1) {
    throw new Error(`Printer profile has ${list.length} entries; pass --printer-id to choose one`);
  }
  return list[0];
}

/** Adds the printer to the profile store the way the app would, and returns its store id. */
function storePrinter(entry: unknown): string {
  if (isBundle(entry)) return importPrinterBundle(entry);
  if (!isObject(entry)) throw new Error('Printer profile must be a JSON object');
  const presetId = typeof entry.presetId === 'string' ? entry.presetId : undefined;
  if (presetId && getAvailablePrinterPresets().some((preset) => preset.presetId === presetId)) {
    return addPrinterProfileFromPreset(presetId);
  }
  return importPrinterBundle({ printer: entry });
}

function storedMaterial(printerId: string, raw: unknown): MaterialProfile {
  let materialId: string | undefined;
  if (raw !== undefined) {
    if (!isObject(raw)) throw new Error('Material profile must be a JSON object');
    const partial = { ...raw };
    delete partial.id;
    delete partial.printerProfileId;
    materialId = addMaterialProfile(printerId, partial as Partial<MaterialProfile>);
  }
  const materials = getMaterialProfilesForPrinter(printerId);
  const material = materialId ? materials.find((entry) => entry.id === materialId) : materials[0];
  if (material) return material;
  // No material anywhere: the defaults a new material gets in the app.
  const defaultId = addMaterialProfile(printerId);
  return getMaterialProfilesForPrinter(printerId).find((entry) => entry.id === defaultId)!;
}

export function resolveSceneSliceJob(options: SceneSliceJobOptions): SceneSliceJob {
  const ditherFlag = options.dither; // 'on' | 'off' | undefined
  const dither = {
    ditherEnabled: ditherFlag === 'on' ? true : ditherFlag === 'off' ? false : undefined,
    ditherBitDepth: options.ditherBitDepth ? Number(options.ditherBitDepth) : undefined,
    ditherDeviceGamma: options.ditherDeviceGamma ? Number(options.ditherDeviceGamma) : undefined,
  };

  let printer: PrinterProfile | null = null;
  let material: MaterialProfile | null = null;
  if (options.printer !== undefined) {
    const printerId = storePrinter(pickPrinterEntry(options.printer, options.printerId));
    const stored = getProfileStoreSnapshot().printerProfiles.find((entry) => entry.id === printerId)!;
    printer = {
      ...stored,
      buildVolumeMm: {
        ...stored.buildVolumeMm,
        ...(options.buildWidthMm ? { width: Number(options.buildWidthMm) } : {}),
        ...(options.buildDepthMm ? { depth: Number(options.buildDepthMm) } : {}),
      },
    };
    const storedMat = storedMaterial(printerId, options.material);
    material = options.layerHeight ? { ...storedMat, layerHeightMm: Number(options.layerHeight) } : storedMat;
  }

  if (options.aaPreset && options.aaPreset !== 'raw' && !printer) {
    throw new Error('--aa-preset requires --printer (pixel pitch comes from the printer profile)');
  }

  return {
    printer,
    material,
    aaPreset: options.aaPreset,
    dither,
    layerHeight: options.layerHeight ?? '0.05',
    buildWidth: options.buildWidthMm ?? '218',
    buildDepth: options.buildDepthMm ?? '122',
  };
}

/** What the CLI knows about the scene once it has merged the models. */
export type SceneSliceGeometry = {
  maxZMm: number;
  models: SliceJobManifestModel[];
};

export type SceneSliceRun = {
  /** Arguments for `dragonfruit-cli`, from `slice run` on (the binary path is the caller's). */
  args: string[];
  /** The assembled job, when a printer was given. */
  assembled: AssembledSliceJob | null;
  aa: ReturnType<typeof computePhysicalAaConfig> | null;
};

// Physical XY pixel pitch (mm) for the AA preset. Prefers explicit pixelSize (µm)
// for non-square pixels; falls back to build volume ÷ resolution, as the panel does.
// Anti-aliasing is outside the shared job assembly, so this stays here.
function resolvePixelPitchMm(printer: PrinterProfile): { x: number; y: number } {
  const pxX = Number(printer.pixelSize?.x);
  const pxY = Number(printer.pixelSize?.y);
  if (Number.isFinite(pxX) && Number.isFinite(pxY) && pxX > 0 && pxY > 0) {
    return { x: pxX / 1000, y: pxY / 1000 }; // µm → mm
  }
  const resX = Number(printer.display?.resolutionX);
  const resY = Number(printer.display?.resolutionY);
  const buildW = Number(printer.buildVolumeMm?.width);
  const buildD = Number(printer.buildVolumeMm?.depth);
  const pitchX = Number.isFinite(resX) && Number.isFinite(buildW) && resX > 0 && buildW > 0 ? buildW / resX : null;
  const pitchY = Number.isFinite(resY) && Number.isFinite(buildD) && resY > 0 && buildD > 0 ? buildD / resY : null;
  return { x: pitchX ?? pitchY ?? 0.05, y: pitchY ?? pitchX ?? 0.05 };
}

export function buildSceneSliceRun(
  job: SceneSliceJob,
  geometry: SceneSliceGeometry,
  inputPath: string,
  outputPath: string,
): SceneSliceRun {
  if (!job.printer || !job.material) {
    // No printer: raw engine defaults, as `slice run` itself would use.
    return {
      args: [
        'slice', 'run', inputPath, '-o', outputPath,
        '--layer-height', job.layerHeight,
        '--build-width-mm', job.buildWidth,
        '--build-depth-mm', job.buildDepth,
        '--json',
      ],
      assembled: null,
      aa: null,
    };
  }

  const { layerHeightMm } = resolveSliceRasterSettings({ printerProfile: job.printer, materialProfile: job.material });
  const layers = resolveSliceLayerCount({ maxZMm: geometry.maxZMm, printerProfile: job.printer, layerHeightMm });
  const assembled = assembleSliceJob({
    printerProfile: job.printer,
    materialProfile: job.material,
    scene: { ...layers, models: geometry.models },
    dither: job.dither,
  });

  let aa: ReturnType<typeof computePhysicalAaConfig> | null = null;
  if (job.aaPreset && job.aaPreset !== 'raw') {
    const pitch = resolvePixelPitchMm(job.printer);
    aa = computePhysicalAaConfig(job.aaPreset, pitch.x, assembled.layerHeightMm, pitch.y);
  }

  const args = [
    'slice', 'run',
    inputPath,
    '-o', outputPath,
    '--layer-height', String(assembled.layerHeightMm),
    '--build-width-mm', String(assembled.buildWidthMm),
    '--build-depth-mm', String(assembled.buildDepthMm),
    '--source-width-px', String(assembled.sourceWidthPx),
    '--source-height-px', String(assembled.sourceHeightPx),
    '--x-packing-mode', assembled.xPackingMode,
  ];
  if (assembled.mirrorX) args.push('--mirror-x');
  if (assembled.mirrorY) args.push('--mirror-y');
  if (assembled.formatVersion) args.push('--format-version', assembled.formatVersion);
  if (aa) {
    args.push('--anti-aliasing', `${aa.aaSteps}x`);
    args.push('--anti-aliasing-mode', aa.antiAliasingMode); // Coverage | Blur | Vertical2
    args.push('--blur-brush-radius-px', String(aa.blurBrushRadiusPx));
    args.push('--z-blur-radius-layers', String(aa.zBlurRadiusLayers));
    args.push('--z-blend-look-back', String(aa.zBlendLookBack));
  }
  if (assembled.ditherEnabled) {
    args.push('--dither');
    args.push('--dither-bit-depth', String(assembled.ditherBitDepth));
    args.push('--dither-device-gamma', String(assembled.ditherDeviceGamma));
  }
  args.push('--metadata-json', assembled.metadataJson);
  args.push('--json');
  return { args, assembled, aa };
}
