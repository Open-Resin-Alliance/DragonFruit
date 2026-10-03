/**
 * Slice-job assembly for `scene slice`: printer profile, material and flags in,
 * the arguments for `dragonfruit-cli slice run` out.
 *
 * Kept apart from the CLI entry point so tests can import it without running
 * `main()`.
 */

import { computePhysicalAaConfig, type AaPreset } from '../../src/features/slicing/autoAaPhysics';

// ---------------------------------------------------------------------------
// NOTE: the functions below (packing, dither policy, pixel pitch) are ported
// from the UI rather than imported. Reusing the originals directly is deferred
// as a design decision — the app functions aren't currently exported and their
// modules pull in the Tauri/THREE dependency chain. A future shared pure-module
// extraction would let both the UI and this CLI import one source of truth.
// ---------------------------------------------------------------------------
// Printer-profile → slice-parameter mapping.
// Mirrors the UI so `scene slice --printer` behaves like a user picking that
// printer in the app:
//   - bit-depth → x-packing : src/features/slicing/rasterLayerZipExport.ts:207
//   - build volume → dims    : src/features/slicing/sliceExportOrchestrator.ts:111
//   - pixel pitch            : src/features/slicing/components/SlicingPanel.tsx:1399
// width_px itself is NOT passed: Rust `slice run` recomputes it from
// source_width_px + x_packing_mode (main.rs), matching this mapping.
// ---------------------------------------------------------------------------
export type XPackingMode = 'none' | 'rgb8_div3' | 'gray3_div2';

export interface PrinterSliceParams {
  sourceWidthPx: number;
  sourceHeightPx: number;
  xPackingMode: XPackingMode;
  buildWidthMm: number;
  buildDepthMm: number;
  mirrorX: boolean;
  mirrorY: boolean;
  outputExt: string;
  formatVersion?: string;
  /** Physical XY pixel pitch (mm), honoring non-square pixels. */
  pitchXMm: number;
  pitchYMm: number;
  name: string;
}

export function resolvePrinterProfile(raw: unknown, wantId?: string): any {
  // App-exported bundles wrap the profile as { version, printer, materials, … };
  // unwrap so downstream reads (.display, .buildVolumeMm, .name, …) hit the real object.
  const unwrap = (p: any) => (p && p.printer && p.display == null ? p.printer : p);
  const list = (Array.isArray(raw) ? raw : [raw]).map(unwrap);
  if (wantId) {
    const hit = list.find(
      (p) => p?.id === wantId || p?.name === wantId || p?.officialPresetId === wantId,
    );
    if (!hit) {
      throw new Error(
        `Printer '${wantId}' not found (have: ${list.map((p) => p?.id ?? p?.name).join(', ')})`,
      );
    }
    return hit;
  }
  if (list.length !== 1) {
    throw new Error(`Printer profile has ${list.length} entries; pass --printer-id to choose one`);
  }
  return list[0];
}

export function resolveBitDepth(printer: any): number {
  const explicit = Number(printer?.bitDepth?.bits);
  if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit);
  // Fallback fingerprint / divisibility — mirrors rasterLayerZipExport.ts:221-251.
  const fp = [printer?.name, printer?.manufacturer, printer?.officialPresetId, printer?.id]
    .filter((v) => typeof v === 'string' && v.length)
    .join(' ')
    .toLowerCase();
  if (/\b3\s*[-_ ]?bit\b|\b3b\b|16k3b|gray3/.test(fp)) return 3;
  if (/\b8\s*[-_ ]?bit\b|\b8b\b|rgb8/.test(fp)) return 8;
  const resX = Math.max(1, Math.round(Number(printer?.display?.resolutionX) || 0));
  const by2 = resX % 2 === 0;
  const by3 = resX % 3 === 0;
  if (by2 && !by3) return 3;
  if (by3 && !by2) return 8;
  if (by2 && by3) return /rgb|color/.test(fp) ? 8 : 3;
  return 3; // NanoDLP failsafe
}

export function outputFormatToExt(fmt: unknown): string {
  const f = String(fmt ?? '').toLowerCase();
  if (f.includes('ctb')) return '.ctb';
  if (f.includes('nanodlp') || f === '') return '.nanodlp';
  return f.startsWith('.') ? f : `.${f}`;
}

// Physical XY pixel pitch (mm). Prefers explicit pixelSize (µm) for non-square
// pixels; falls back to buildVolume ÷ resolution. Matches SlicingPanel.tsx:1399.
export function resolvePixelPitchMm(printer: any): { x: number; y: number } {
  const pxX = Number(printer?.pixelSize?.x);
  const pxY = Number(printer?.pixelSize?.y);
  if (Number.isFinite(pxX) && Number.isFinite(pxY) && pxX > 0 && pxY > 0) {
    return { x: pxX / 1000, y: pxY / 1000 }; // µm → mm
  }
  const resX = Number(printer?.display?.resolutionX);
  const resY = Number(printer?.display?.resolutionY);
  const buildW = Number(printer?.buildVolumeMm?.width);
  const buildD = Number(printer?.buildVolumeMm?.depth);
  const pitchX = Number.isFinite(resX) && Number.isFinite(buildW) && resX > 0 && buildW > 0 ? buildW / resX : null;
  const pitchY = Number.isFinite(resY) && Number.isFinite(buildD) && resY > 0 && buildD > 0 ? buildD / resY : null;
  return { x: pitchX ?? pitchY ?? 0.05, y: pitchY ?? pitchX ?? 0.05 };
}

export interface DitherPolicy {
  enabled: boolean;
  bitDepth: number;
  deviceGamma: number;
}

// Faithful port of sliceExportOrchestrator.ts:resolveDitherPolicy (line ~443).
// A known non-8-bit panel (e.g. 3-bit mono) FORCES dithering on, with the
// panel bit depth as the target — this is why "some printers utilize dithering".
// Material defaults / explicit overrides only apply when the panel isn't a
// known low-bit-depth display.
export function resolveDitherPolicy(
  printer: any,
  overrides: { enabled?: boolean; bitDepth?: number; gamma?: number; material?: any },
): DitherPolicy {
  const aa = overrides.material?.antiAliasingSettings ?? {};
  const materialEnabled = aa.ditherEnabled ?? false;
  const materialBitDepth = aa.ditherBitDepth ?? 3;
  const materialGamma = aa.ditherDeviceGamma ?? 3.0;

  const configuredEnabled = overrides.enabled ?? materialEnabled;
  const configuredBitDepth = overrides.bitDepth ?? materialBitDepth;
  const configuredGamma = overrides.gamma ?? materialGamma;

  const raw = Number(printer?.bitDepth?.bits);
  const printerBitDepth = Number.isFinite(raw) ? Math.round(raw) : null;
  const hasKnownNon8BitDisplay = printerBitDepth != null && printerBitDepth > 0 && printerBitDepth !== 8;
  const derivedBitDepth = printerBitDepth != null && printerBitDepth > 0
    ? Math.max(2, Math.min(7, printerBitDepth))
    : Math.max(2, Math.min(7, Math.round(configuredBitDepth)));

  return {
    enabled: hasKnownNon8BitDisplay ? true : configuredEnabled,
    bitDepth: derivedBitDepth,
    deviceGamma: Math.max(0.5, Math.min(4.0, Number(configuredGamma))),
  };
}

export function derivePrinterSliceParams(printer: any): PrinterSliceParams {
  const d = printer?.display ?? {};
  const sourceWidthPx = Math.max(1, Math.round(Number(d.resolutionX)));
  const sourceHeightPx = Math.max(1, Math.round(Number(d.resolutionY)));
  const bitDepth = resolveBitDepth(printer);
  const xPackingMode: XPackingMode = bitDepth === 8 ? 'rgb8_div3' : 'gray3_div2';
  const bv = printer?.buildVolumeMm ?? {};
  const pitch = resolvePixelPitchMm(printer);
  return {
    sourceWidthPx,
    sourceHeightPx,
    xPackingMode,
    buildWidthMm: Math.max(1, Number(bv.width) || 218),
    buildDepthMm: Math.max(1, Number(bv.depth) || 122),
    mirrorX: Boolean(d.mirrorX),
    mirrorY: Boolean(d.mirrorY),
    outputExt: outputFormatToExt(d.outputFormat),
    formatVersion: typeof d.formatVersion === 'string' ? d.formatVersion : undefined,
    pitchXMm: pitch.x,
    pitchYMm: pitch.y,
    name: String(printer?.name ?? printer?.id ?? 'printer'),
  };
}

export interface SceneSliceJobOptions {
  /** Parsed printer JSON: a single profile, a list, or an app-exported bundle. */
  printer?: unknown;
  printerId?: string;
  /** Parsed material JSON. Read only when a printer is given. */
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
  printer: PrinterSliceParams | null;
  aa: ReturnType<typeof computePhysicalAaConfig> | null;
  dither: DitherPolicy | null;
  layerHeight: string;
  buildWidth: string;
  buildDepth: string;
}

export function resolveSceneSliceJob(options: SceneSliceJobOptions): SceneSliceJob {
  const layerHeight = options.layerHeight ?? '0.05';
  const aaPreset = options.aaPreset;

  // Printer profile drives resolution, packing, build dims, mirror, format, and
  // pixel pitch — just like selecting that printer in the UI.
  let p: PrinterSliceParams | null = null;
  let printer: any = null;
  if (options.printer !== undefined) {
    printer = resolvePrinterProfile(options.printer, options.printerId);
    p = derivePrinterSliceParams(printer);
  }
  const buildWidth = options.buildWidthMm ?? String(p?.buildWidthMm ?? 218.0);
  const buildDepth = options.buildDepthMm ?? String(p?.buildDepthMm ?? 122.0);

  // Resolve AA from the named preset using the app's exact physics function.
  let aa: ReturnType<typeof computePhysicalAaConfig> | null = null;
  if (aaPreset && aaPreset !== 'raw') {
    if (!p) throw new Error('--aa-preset requires --printer (pixel pitch comes from the printer profile)');
    aa = computePhysicalAaConfig(aaPreset, p.pitchXMm, Number(layerHeight), p.pitchYMm);
  }

  // Resolve dithering the way the UI does — a low-bit-depth panel forces it on.
  let dither: DitherPolicy | null = null;
  if (printer) {
    const ditherFlag = options.dither; // 'on' | 'off' | undefined
    dither = resolveDitherPolicy(printer, {
      enabled: ditherFlag === 'on' ? true : ditherFlag === 'off' ? false : undefined,
      bitDepth: options.ditherBitDepth ? Number(options.ditherBitDepth) : undefined,
      gamma: options.ditherDeviceGamma ? Number(options.ditherDeviceGamma) : undefined,
      material: options.material,
    });
  }

  return { printer: p, aa, dither, layerHeight, buildWidth, buildDepth };
}

/** Arguments for `dragonfruit-cli`, from `slice run` on (the binary path is the caller's). */
export function sliceRunArgs(job: SceneSliceJob, inputPath: string, outputPath: string): string[] {
  const p = job.printer;
  const aa = job.aa;
  const dither = job.dither;
  const argv = [
    'slice', 'run',
    inputPath,
    '-o', outputPath,
    '--layer-height', job.layerHeight,
    '--build-width-mm', job.buildWidth,
    '--build-depth-mm', job.buildDepth,
  ];
  if (p) {
    argv.push('--source-width-px', String(p.sourceWidthPx));
    argv.push('--source-height-px', String(p.sourceHeightPx));
    argv.push('--x-packing-mode', p.xPackingMode);
    if (p.mirrorX) argv.push('--mirror-x');
    if (p.mirrorY) argv.push('--mirror-y');
    if (p.formatVersion) argv.push('--format-version', p.formatVersion);
  }
  if (aa) {
    argv.push('--anti-aliasing', `${aa.aaSteps}x`);
    argv.push('--anti-aliasing-mode', aa.antiAliasingMode); // Coverage | Blur | Vertical2
    argv.push('--blur-brush-radius-px', String(aa.blurBrushRadiusPx));
    argv.push('--z-blur-radius-layers', String(aa.zBlurRadiusLayers));
    argv.push('--z-blend-look-back', String(aa.zBlendLookBack));
  }
  if (dither?.enabled) {
    argv.push('--dither');
    argv.push('--dither-bit-depth', String(dither.bitDepth));
    argv.push('--dither-device-gamma', String(dither.deviceGamma));
  }
  argv.push('--json');
  return argv;
}
