import type {
  PluginFileTypeHandler,
  PluginFileTypeImportResult,
} from '@/features/plugins/pluginFileTypeBridge';
import { importSideloadedFile, listSideloadedPlugins, type InstalledSideloadedPlugin } from '@/features/plugins/sideloadedPlugins';
import { getInstalledProfilePlugins } from '@/features/plugins/pluginRegistry';
import { installPluginFromManifest, uninstallPlugin } from '@/features/profiles/profileStore';
import type { PluginManifest } from '@/features/plugins/pluginRegistry';
import { parseSideloadedSceneContainer } from '@/features/plugins/sideloadedSceneContainer';
import {
  applySideloadedFileTypes,
  applySideloadedOutputFormats,
  type SideloadedFileType,
  type SideloadedOutputFormat,
} from '@/features/plugins/sideloadedFileTypeRegistry';

export type { SideloadedFileType };
export {
  findSideloadedSceneFileType,
  getSideloadedFileTypesSnapshot,
  isSideloadedFileName,
  isSideloadedSceneFileName,
  sideloadedSceneExtensions,
  subscribeSideloadedFileTypes,
} from '@/features/plugins/sideloadedFileTypeRegistry';

let inFlight: Promise<void> | null = null;

/**
 * Packages whose presets we have registered with the profile store. Module state
 * because the store owns the persistence: this is only what *we* added, so a
 * removal takes away our entry and never someone's GitHub plugin.
 */
const syncedProfilePluginIds = new Set<string>();

/**
 * Packages can contribute printer presets and material templates. They go through
 * the same store entry point the simple-plugin tier uses, which is what makes the
 * printer library, the format dropdown and the material picker see them; the
 * package's own row in Settings stays the sideloaded one.
 */
function syncProfileContributions(plugins: InstalledSideloadedPlugin[]) {
  const present = new Set<string>();
  for (const plugin of plugins) {
    const source = plugin.manifest;
    const printerPresets = Array.isArray(source.printerPresets) ? source.printerPresets : [];
    const materialTemplates = Array.isArray(source.materialTemplates) ? source.materialTemplates : [];
    if (printerPresets.length === 0 && materialTemplates.length === 0) continue;

    present.add(source.id);
    if (syncedProfilePluginIds.has(source.id)) continue;

    // A restart must not rewrite the registry, and an unchanged package must not
    // look like a change to everything that memoises the profile snapshot.
    const registered = getInstalledProfilePlugins().find((plugin) => plugin.manifest.id === source.id);
    if (
      registered
      && JSON.stringify(registered.manifest.printerPresets ?? []) === JSON.stringify(printerPresets)
      && JSON.stringify(registered.manifest.materialTemplates ?? []) === JSON.stringify(materialTemplates)
    ) {
      syncedProfilePluginIds.add(source.id);
      continue;
    }

    const manifest: PluginManifest = {
      schemaVersion: 1,
      id: source.id,
      name: source.name,
      version: source.version,
      description: source.description,
      printerPresets: printerPresets as PluginManifest['printerPresets'],
      materialTemplates: materialTemplates as PluginManifest['materialTemplates'],
    };
    installPluginFromManifest(manifest, source.vendor.homepage ?? undefined);
    syncedProfilePluginIds.add(source.id);
  }

  for (const id of [...syncedProfilePluginIds]) {
    if (present.has(id)) continue;
    uninstallPlugin(id);
    syncedProfilePluginIds.delete(id);
  }
}

/** Re-reads installed packages. Safe to call after an install, remove or toggle. */
export function refreshSideloadedContributions(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const plugins = await listSideloadedPlugins();
      const fileTypes: SideloadedFileType[] = [];
      const formats: SideloadedOutputFormat[] = [];
      for (const plugin of plugins) {
        const manifest = plugin.manifest;
        for (const format of manifest.formats ?? []) {
          for (const extension of format.extensions) {
            formats.push({
              pluginId: manifest.id,
              pluginName: manifest.name,
              extension: extension.toLowerCase(),
              displayName: format.displayName ?? format.id,
            });
          }
        }
        if (!manifest.capabilities.includes('fileType')) continue;
        for (const fileType of manifest.fileTypes ?? []) {
          fileTypes.push({
            pluginId: manifest.id,
            pluginName: manifest.name,
            extension: fileType.extension.toLowerCase(),
            displayName: fileType.displayName,
            isSceneFile: fileType.isSceneFile === true,
          });
        }
      }
      applySideloadedFileTypes(fileTypes);
      applySideloadedOutputFormats(formats);
      syncProfileContributions(plugins);
    } catch {
      // The runtime is unavailable (web build, or nothing installed yet).
      applySideloadedFileTypes([]);
      applySideloadedOutputFormats([]);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * The handler the scene import expects, built around a native round trip: the
 * bytes go to the plugin, the container comes back, and this turns it into the
 * geometry the importer already knows how to place.
 */
export function createSideloadedFileTypeHandler(fileType: SideloadedFileType): PluginFileTypeHandler {
  return async (file): Promise<PluginFileTypeImportResult> => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const container = await importSideloadedFile(fileType.pluginId, file.name, bytes);
      const models = parseSideloadedSceneContainer(container);
      if (models.length === 0) {
        return { success: false, error: `${fileType.displayName} produced no models.` };
      }
      return { success: true, payload: models };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}
