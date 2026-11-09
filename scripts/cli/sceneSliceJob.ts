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

import type { AaPreset } from '../../src/features/slicing/autoAaPhysics';
import type { SavedCurve } from '../../src/features/slicing/lutCurves';
import type { SliceAntiAliasingOverride, SliceJobAntiAliasingRequest } from '../../src/features/slicing/sliceAntiAliasing';
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
import { toNativeMetadataPayload } from '../../src/features/slicing/tauri/nativeSlicerBridge';
import {
  assembleSliceJob,
  buildNativeSliceJob,
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
  /**
   * Parsed `--aa-settings` JSON: `{ antiAliasingSettings?, minimumAaAlphaPercent? }`,
   * applied on top of the material's own like the panel's session override.
   */
  aaSettings?: unknown;
  /** Parsed `--lut-curves` JSON: the curve library a custom LUT is looked up in. */
  lutCurves?: unknown;
  dither?: string;
  ditherBitDepth?: string;
  ditherDeviceGamma?: string;
}

export interface SceneSliceJob {
  /** The printer as the profile store holds it, with `--build-*-mm` applied. */
  printer: PrinterProfile | null;
  /** The material as the profile store holds it, with `--layer-height` applied. */
  material: MaterialProfile | null;
  /** What the job's anti-aliasing is resolved from; null without a printer. */
  antiAliasing: SliceJobAntiAliasingRequest | null;
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

const AA_PRESETS = ['raw', 'sharp', 'balanced', 'smooth'] as const;

function parseAaOverride(raw: unknown): SliceAntiAliasingOverride {
  if (!isObject(raw) || !('antiAliasingSettings' in raw || 'minimumAaAlphaPercent' in raw)) {
    throw new Error(
      '--aa-settings must be a JSON object with antiAliasingSettings and/or minimumAaAlphaPercent, '
      + 'the shape a material stores them in',
    );
  }
  if (raw.antiAliasingSettings !== undefined && !isObject(raw.antiAliasingSettings)) {
    throw new Error('--aa-settings: antiAliasingSettings must be an object');
  }
  if (raw.minimumAaAlphaPercent !== undefined && typeof raw.minimumAaAlphaPercent !== 'number') {
    throw new Error('--aa-settings: minimumAaAlphaPercent must be a number');
  }
  return {
    // Passing settings is asking for them: the override is on, as when the
    // panel opens a session override.
    antiAliasingSettings: { ...(raw.antiAliasingSettings as Profile | undefined), enableOverride: true },
    ...(raw.minimumAaAlphaPercent === undefined ? {} : { minimumAaAlphaPercent: raw.minimumAaAlphaPercent }),
  };
}

function parseLutCurves(raw: unknown): SavedCurve[] {
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((entry, index) => {
    if (!isObject(entry) || typeof entry.id !== 'string' || !Array.isArray(entry.points)) {
      throw new Error(`--lut-curves: entry ${index} needs an id and a points array`);
    }
    return entry as unknown as SavedCurve;
  });
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

  if (options.aaPreset && !(AA_PRESETS as readonly string[]).includes(options.aaPreset)) {
    throw new Error(`--aa-preset must be one of ${AA_PRESETS.join(', ')}`);
  }
  if (!printer && (options.aaPreset || options.aaSettings !== undefined || options.lutCurves !== undefined)) {
    throw new Error('--aa-preset, --aa-settings and --lut-curves require --printer');
  }

  // The app's choice when nothing is given: the balanced preset, and whatever
  // the material's own anti-aliasing settings say.
  const antiAliasing: SliceJobAntiAliasingRequest | null = printer
    ? {
        preset: options.aaPreset ?? 'balanced',
        override: options.aaSettings === undefined ? null : parseAaOverride(options.aaSettings),
        lutCurves: options.lutCurves === undefined ? [] : parseLutCurves(options.lutCurves),
      }
    : null;

  return {
    printer,
    material,
    antiAliasing,
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
  /**
   * Model-only triangle count, the split point before baked support/raft
   * triangles in `positions.bin`. Omitted (or 0) means the whole mesh is model
   * geometry and the engine treats it as one piece.
   */
  modelTriangleCount?: number;
};

export type SceneSliceRun = {
  /** Arguments for `dragonfruit-cli`, from `slice run` on (the binary path is the caller's). */
  args: string[];
  /** The assembled job, when a printer was given. */
  assembled: AssembledSliceJob | null;
  /**
   * The job `slice run --job` reads, when a printer was given: the payload the
   * app hands the native slicer, without the mesh. The caller writes it to the
   * `jobPath` it passed.
   */
  jobJson: string | null;
};

export function buildSceneSliceRun(
  job: SceneSliceJob,
  geometry: SceneSliceGeometry,
  inputPath: string,
  outputPath: string,
  jobPath: string,
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
      jobJson: null,
    };
  }

  const { layerHeightMm } = resolveSliceRasterSettings({ printerProfile: job.printer, materialProfile: job.material });
  const layers = resolveSliceLayerCount({ maxZMm: geometry.maxZMm, printerProfile: job.printer, layerHeightMm });
  const assembled = assembleSliceJob({
    printerProfile: job.printer,
    materialProfile: job.material,
    scene: { ...layers, models: geometry.models },
    dither: job.dither,
    antiAliasing: job.antiAliasing ?? undefined,
  });
  if (assembled.antiAliasing.warnings.length > 0) {
    throw new Error(`scene slice will not fall back silently: ${assembled.antiAliasing.warnings.join(' ')}`);
  }

  // The app's defaults for what its performance settings decide. The model
  // triangle count is the split point for baked supports in `positions.bin`;
  // 0 lets `slice run` treat the whole mesh as model geometry.
  const payload = toNativeMetadataPayload({
    ...buildNativeSliceJob(assembled, { pngCompressionMode: 'auto', aaOnSupportsFallback: false, modelTriangleCount: geometry.modelTriangleCount ?? 0 }),
    trianglesXYZ: new Float32Array(0),
  });
  return {
    args: ['slice', 'run', inputPath, '-o', outputPath, '--job', jobPath, '--json'],
    assembled,
    jobJson: JSON.stringify(payload),
  };
}
