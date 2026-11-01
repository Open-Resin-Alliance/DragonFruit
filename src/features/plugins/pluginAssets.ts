import { invoke } from '@tauri-apps/api/core';

export type SideloadedAsset = {
  mime: string;
  dataUrl: string;
};

export type SideloadedAssetReader = (pluginId: string, assetPath: string) => Promise<SideloadedAsset>;

/** Reads one image from an installed package's `payload/assets/`. */
export const readSideloadedAsset: SideloadedAssetReader = (pluginId, assetPath) => (
  invoke<SideloadedAsset>('sideloaded_plugin_asset', { id: pluginId, assetPath })
);

/** Base64 characters, across every preset of one package. */
const MAX_INLINE_ASSET_CHARS = 20_000_000;

/**
 * Rewrites a preset's `imageAssetPath` from a package-relative path into a data
 * URL, which is what an `<img src>` can actually load from a webview: the package
 * lives under the app data dir, not under a served origin.
 *
 * Remote and data paths pass through untouched; a read that fails or exceeds the
 * budget leaves the preset without an image rather than failing the install.
 */
export async function inlineSideloadedPresetAssets<T extends Record<string, unknown>>(
  pluginId: string,
  presets: T[],
  reader: SideloadedAssetReader = readSideloadedAsset,
): Promise<T[]> {
  let budget = MAX_INLINE_ASSET_CHARS;
  const transformed: T[] = [];

  for (const preset of presets) {
    const raw = preset.imageAssetPath;
    if (typeof raw !== 'string') {
      transformed.push(preset);
      continue;
    }

    const assetPath = raw.trim().replace(/^assets\//, '');
    const isRelative = assetPath.length > 0
      && !assetPath.startsWith('/')
      && !/^[a-z][a-z0-9+.-]*:/i.test(assetPath);
    if (!isRelative) {
      transformed.push(preset);
      continue;
    }

    try {
      const asset = await reader(pluginId, assetPath);
      if (!asset?.dataUrl || asset.dataUrl.length > budget) {
        transformed.push(preset);
        continue;
      }
      budget -= asset.dataUrl.length;
      transformed.push({ ...preset, imageAssetPath: asset.dataUrl });
    } catch {
      transformed.push(preset);
    }
  }

  return transformed;
}
