import type {
  PluginFileTypeHandler,
  PluginFileTypeImportResult,
} from '@/features/plugins/pluginFileTypeBridge';
import { importSideloadedFile, listSideloadedPlugins } from '@/features/plugins/sideloadedPlugins';
import { parseSideloadedSceneContainer } from '@/features/plugins/sideloadedSceneContainer';
import {
  applySideloadedFileTypes,
  type SideloadedFileType,
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

/** Re-reads installed packages. Safe to call after an install, remove or toggle. */
export function refreshSideloadedFileTypes(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const plugins = await listSideloadedPlugins();
      const next: SideloadedFileType[] = [];
      for (const plugin of plugins) {
        const manifest = plugin.manifest;
        if (!manifest.capabilities.includes('fileType')) continue;
        for (const fileType of manifest.fileTypes ?? []) {
          next.push({
            pluginId: manifest.id,
            pluginName: manifest.name,
            extension: fileType.extension.toLowerCase(),
            displayName: fileType.displayName,
            isSceneFile: fileType.isSceneFile === true,
          });
        }
      }
      applySideloadedFileTypes(next);
    } catch {
      // The runtime is unavailable (web build, or nothing installed yet).
      applySideloadedFileTypes([]);
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
