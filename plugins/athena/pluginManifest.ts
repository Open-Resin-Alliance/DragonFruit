import athenaPrinters from './printers/printers.json';
import type { PrinterPreset } from '../../src/features/profiles/profileStore';
import { normalizeWebcamRotationDeg, DEFAULT_WEBCAM_ROTATION_DEG } from '../../src/features/profiles/outputFormatUtils';

/**
 * Athena built-in profile pack manifest.
 *
 * Where this is consumed:
 * - `src/features/plugins/pluginRegistry.ts` via `BUILTIN_ATHENA_PLUGIN`
 *
 * Why this file exists:
 * - Keeps Athena-owned printer presets/assets co-located in `plugins/athena/*`
 * - Prevents vendor profile data from leaking into core generic profile folders
 */

/**
 * Resolve a relative path against a logical base directory using POSIX-like
 * semantics. This keeps plugin asset normalization deterministic regardless of OS.
 */
function normalizeRelativePath(baseDir: string, relativePath: string): string {
  const stack = baseDir.split('/').filter(Boolean);
  const segments = relativePath.split('/');

  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(segment);
  }

  return stack.join('/');
}

/**
 * Normalize a printer preset image path into a runtime URL that can be served by
 * DragonFruit's `/api/profile-assets` endpoint.
 *
 * Supported forms:
 * - absolute web/data URLs (returned as-is)
 * - legacy `/assets/printers/...` paths (mapped into plugin-owned asset paths)
 * - rooted app paths (returned as-is)
 * - relative paths (resolved against `baseDir`)
 */
function normalizePresetImagePath(baseDir: string, imageAssetPath?: string): string | undefined {
  if (!imageAssetPath) return undefined;

  const trimmed = imageAssetPath.trim();
  if (!trimmed) return undefined;

  if (
    trimmed.startsWith('http://')
    || trimmed.startsWith('https://')
    || trimmed.startsWith('data:')
    || trimmed.startsWith('/api/profile-assets/')
  ) {
    return trimmed;
  }

  if (trimmed.startsWith('/assets/printers/')) {
    const relative = trimmed.replace(/^\/assets\//, '');
    const tail = relative.split('/').filter(Boolean);
    if (tail.length >= 3) {
      const [group, manufacturer, ...rest] = tail;
      return `/api/profile-assets/plugins/athena/${group}/${manufacturer}/assets/${rest.join('/')}`;
    }
    return `/api/profile-assets/plugins/athena/${relative}`;
  }

  if (trimmed.startsWith('/')) {
    return trimmed;
  }

  const normalized = normalizeRelativePath(baseDir, trimmed);
  return `/api/profile-assets/${normalized}`;
}

/**
 * Apply image path normalization to every preset in a list.
 */
function withResolvedImagePaths<T extends object>(
  baseDir: string,
  presets: T[],
): T[] {
  return presets.map((preset) => {
    const currentImagePath = (preset as { imageAssetPath?: string }).imageAssetPath;
    const normalizedImagePath = normalizePresetImagePath(baseDir, currentImagePath);

    if (!normalizedImagePath) {
      return preset;
    }

    return {
      ...preset,
      imageAssetPath: normalizedImagePath,
    } as T;
  });
}

function sanitizePositiveNumber(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function sanitizeProfileVersion(value: unknown): number | undefined {
  const n = sanitizePositiveNumber(value);
  if (n == null) return undefined;
  return Math.max(1, Math.round(n));
}

function resolveBuildDimensionMm(
  explicitValue: unknown,
  resolutionPx: unknown,
  pixelSizeUm: unknown,
  fallbackMm: number,
): number {
  const explicit = sanitizePositiveNumber(explicitValue);
  if (explicit != null) return explicit;

  const resolution = sanitizePositiveNumber(resolutionPx);
  const pixelSize = sanitizePositiveNumber(pixelSizeUm);
  if (resolution != null && pixelSize != null) {
    return (resolution * pixelSize) / 1000;
  }

  return fallbackMm;
}

/**
 * The Athena printer entries exactly as `printers/printers.json` carries them.
 * Fields only some entries declare are optional, and build width/depth are
 * explicitly nullable — the JSON leaves them null so the pixel-size derivation
 * runs instead.
 */
interface RawAthenaPreset {
  presetId: string;
  profileVersion: number;
  manufacturer: string;
  family?: string;
  name: string;
  libraryDisplayName?: string;
  platformBadge?: { text: string; color: string };
  imageAssetPath?: string;
  pixelSize?: { x: number; y: number };
  bitDepth?: { bits: number; description: string };
  display?: {
    resolutionX?: number;
    resolutionY?: number;
    outputFormat?: string;
    webcamRotationDeg?: number;
    webcamOrientation?: number;
    mirrorX?: boolean;
    mirrorY?: boolean;
  };
  antiAliasing?: boolean;
  buildVolumeMm?: { width?: number | null; depth?: number | null; height?: number };
  safetyMarginMm?: { front?: number; back?: number; left?: number; right?: number } | null;
  hasCamera?: boolean;
  networkSupport?: string;
  networkFilter?: string;
  modelVariants?: unknown[];
  modelVariantDetectPath?: string;
  isModelVariant?: boolean;
}

/**
 * Built-in Athena plugin manifest.
 *
 * Note:
 * - This manifest is bundled with the app (not fetched remotely).
 * - Athena printer profiles and assets are plugin-owned under
 *   `plugins/athena/printers`.
 * - Presets are coerced into the strict runtime `PrinterPreset` shape to ensure
 *   stable behavior when merged with other profile sources.
 */
export const ATHENA_PLUGIN_MANIFEST = {
  schemaVersion: 1,
  id: 'athena-builtin',
  name: 'Athena Plugin',
  version: '1.1.0',
  description: 'Athena/NanoDLP integration and Athena profile pack.',
  printerPresets: withResolvedImagePaths('plugins/athena/printers', athenaPrinters as RawAthenaPreset[]).map((preset) => {
    const resolutionX = Number(preset.display?.resolutionX) || 2560;
    const resolutionY = Number(preset.display?.resolutionY) || 1620;
    const explicitBuildWidth = sanitizePositiveNumber(preset.buildVolumeMm?.width);
    const explicitBuildDepth = sanitizePositiveNumber(preset.buildVolumeMm?.depth);
    const pixelSizeX = sanitizePositiveNumber(preset.pixelSize?.x);
    const pixelSizeY = sanitizePositiveNumber(preset.pixelSize?.y);
    const buildDimensionMode = explicitBuildWidth == null
      && explicitBuildDepth == null
      && pixelSizeX != null
      && pixelSizeY != null
        ? 'auto'
        : 'manual';
    const outputFormat = (preset.display?.outputFormat === '.nanodlp'
      || preset.display?.outputFormat === '.goo'
      || preset.display?.outputFormat === '.lumen')
      ? preset.display?.outputFormat
      : '.nanodlp';
    const mirrorX = typeof preset.display?.mirrorX === 'boolean'
      ? preset.display?.mirrorX
      : undefined;
    const mirrorY = typeof preset.display?.mirrorY === 'boolean'
      ? preset.display?.mirrorY
      : undefined;
    const webcamRotationDeg = normalizeWebcamRotationDeg(
      preset.display?.webcamRotationDeg ?? preset.display?.webcamOrientation,
      DEFAULT_WEBCAM_ROTATION_DEG,
    );

    return {
      presetId: String(preset.presetId),
      profileVersion: sanitizeProfileVersion(preset.profileVersion),
      manufacturer: String(preset.manufacturer),
      name: String(preset.name),
      family: typeof preset.family === 'string' && preset.family.trim().length > 0
        ? preset.family.trim()
        : undefined,
      imageAssetPath: preset.imageAssetPath,
      antiAliasing: typeof preset.antiAliasing === 'boolean' ? preset.antiAliasing : undefined,
      hasCamera: typeof preset.hasCamera === 'boolean' ? preset.hasCamera : undefined,
      platformBadge: preset.platformBadge,
      pixelSize: preset.pixelSize,
      bitDepth: preset.bitDepth,
      modelVariants: Array.isArray(preset.modelVariants)
        ? preset.modelVariants
          .slice(0, 32)
          .map((id) => String(id).trim())
          .filter((id) => id.length > 0)
        : undefined,
      modelVariantDetectPath: typeof preset.modelVariantDetectPath === 'string'
        && preset.modelVariantDetectPath.trim().length > 0
        ? preset.modelVariantDetectPath.trim()
        : undefined,
      libraryDisplayName: typeof preset.libraryDisplayName === 'string'
        && preset.libraryDisplayName.trim().length > 0
        ? preset.libraryDisplayName.trim()
        : undefined,
      isModelVariant: typeof preset.isModelVariant === 'boolean'
        ? preset.isModelVariant
        : undefined,
      buildDimensionMode,
      buildVolumeMm: {
        width: resolveBuildDimensionMm(
          preset.buildVolumeMm?.width,
          resolutionX,
          preset.pixelSize?.x,
          143,
        ),
        depth: resolveBuildDimensionMm(
          preset.buildVolumeMm?.depth,
          resolutionY,
          preset.pixelSize?.y,
          89,
        ),
        height: Number(preset.buildVolumeMm?.height) || 175,
      },
      display: {
        resolutionX,
        resolutionY,
        outputFormat,
        webcamRotationDeg,
        mirrorX,
        mirrorY,
      },
      networkSupport: preset.networkSupport === 'nanodlp' ? 'nanodlp' as const : undefined,
      networkFilter: typeof preset.networkFilter === 'string' && preset.networkFilter.trim().length > 0
        ? preset.networkFilter.trim()
        : undefined,
      safetyMarginMm: preset.safetyMarginMm != null
        ? {
          front: Number(preset.safetyMarginMm.front) || 0,
          back: Number(preset.safetyMarginMm.back) || 0,
          left: Number(preset.safetyMarginMm.left) || 0,
          right: Number(preset.safetyMarginMm.right) || 0,
        }
        : undefined,
    };
  }) as PrinterPreset[],
  materialTemplates: [],
};