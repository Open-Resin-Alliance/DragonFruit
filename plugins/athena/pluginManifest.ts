import concepts3dPrinters from './printers/concepts3d/printers.json';
import type { PrinterPreset } from '../../src/features/profiles/profileStore';

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
 * Dragonfruit's `/api/profile-assets` endpoint.
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

/**
 * Built-in Athena plugin manifest.
 *
 * Note:
 * - This manifest is bundled with the app (not fetched remotely).
 * - Concepts3D printer profiles and assets are plugin-owned under
 *   `plugins/athena/printers/concepts3d`.
 * - Presets are coerced into the strict runtime `PrinterPreset` shape to ensure
 *   stable behavior when merged with other profile sources.
 */
export const ATHENA_PLUGIN_MANIFEST = {
  schemaVersion: 1,
  id: 'athena-builtin',
  name: 'Athena Plugin',
  version: '1.1.0',
  description: 'Built-in Athena/NanoDLP integration and Concepts3D profile pack.',
  printerPresets: withResolvedImagePaths('plugins/athena/printers/concepts3d', concepts3dPrinters).map((preset) => ({
    presetId: String((preset as any).presetId),
    manufacturer: String((preset as any).manufacturer),
    name: String((preset as any).name),
    imageAssetPath: (preset as any).imageAssetPath,
    buildVolumeMm: {
      width: Number((preset as any).buildVolumeMm?.width) || 143,
      depth: Number((preset as any).buildVolumeMm?.depth) || 89,
      height: Number((preset as any).buildVolumeMm?.height) || 175,
    },
    display: {
      resolutionX: Number((preset as any).display?.resolutionX) || 2560,
      resolutionY: Number((preset as any).display?.resolutionY) || 1620,
      outputFormat: '.nanodlp' as const,
    },
    networkSupport: 'nanodlp' as const,
  })) as PrinterPreset[],
  materialTemplates: [],
};