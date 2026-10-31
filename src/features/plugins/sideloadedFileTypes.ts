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
 * Packages contribute manifest data: printer presets, material templates and the
 * network mode they host. Registering the package in the profile plugin registry
 * is how the renderer reads it, so every installed package goes in, and a removal
 * takes it out again. The package's own row in Settings stays the sideloaded one.
 *
 * A version bump refreshes an entry, plus a network mode that was not there
 * before: packages imported by an earlier build carried neither.
 */
function syncProfileContributions(plugins: InstalledSideloadedPlugin[]) {
  const sameList = (left: unknown[] | undefined, right: unknown[] | undefined) => (
    JSON.stringify(left ?? []) === JSON.stringify(right ?? [])
  );
  const present = new Set<string>();

  for (const plugin of plugins) {
    const source = plugin.manifest;
    const printerPresets = Array.isArray(source.printerPresets) ? source.printerPresets : [];
    const materialTemplates = Array.isArray(source.materialTemplates) ? source.materialTemplates : [];
    const declaredMode = (source.network?.mode ?? '').trim().toLowerCase();
    present.add(source.id);

    const registered = getInstalledProfilePlugins().find((entry) => entry.manifest.id === source.id);
    const unchanged = Boolean(registered)
      && registered!.manifest.version === source.version
      && sameList(registered!.manifest.printerPresets, printerPresets)
      && sameList(registered!.manifest.materialTemplates, materialTemplates)
      && (registered!.manifest.network?.mode ?? '') === declaredMode
      && JSON.stringify(registered!.manifest.materialSettings ?? null) === JSON.stringify(source.materialSettings ?? null);
    if (unchanged) continue;

    const manifest: PluginManifest = {
      schemaVersion: 1,
      id: source.id,
      name: source.name,
      version: source.version,
      description: source.description,
      network: source.network ? {
        pluginId: source.network.pluginId || source.id,
        mode: source.network.mode,
        displayName: source.network.displayName,
        hostnames: Array.isArray(source.network.hostnames) ? source.network.hostnames : [],
        operations: source.network.operations ?? {},
      } as PluginManifest['network'] : undefined,
      materialSettings: source.materialSettings,
      printerPresets: printerPresets as PluginManifest['printerPresets'],
      materialTemplates: materialTemplates as PluginManifest['materialTemplates'],
    };
    installPluginFromManifest(manifest, source.vendor.homepage ?? undefined);
  }

  for (const entry of getInstalledProfilePlugins()) {
    const id = entry.manifest.id;
    if (present.has(id)) continue;
    // The registry also holds compiled plugins. Only packages this sync put there
    // are withdrawn when the package disappears.
    if (!entry.manifest.network && !(entry.manifest.printerPresets?.length) && !(entry.manifest.materialTemplates?.length)) continue;
    uninstallPlugin(id);
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
