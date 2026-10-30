import type { PluginFileTypeHandler, PluginFileTypeImportResult } from '@/features/plugins/pluginFileTypeBridge';
import { importSideloadedFile } from '@/features/plugins/sideloadedPlugins';
import { listSideloadedPlugins } from '@/features/plugins/sideloadedPlugins';
import { parseSideloadedSceneContainer } from '@/features/plugins/sideloadedSceneContainer';

/**
 * File types contributed by installed `.dfplugin` packages.
 *
 * The compiled-in tier reads its extensions from generated definitions at build
 * time; a sideloaded package arrives at runtime, so this small store is what the
 * scene-import lookup consults after it.
 *
 * Nothing here runs in the web build: it has no installed packages and no native
 * runner, so the list stays empty and no extension is ever claimed.
 */
export type SideloadedFileType = {
  pluginId: string;
  pluginName: string;
  extension: string;
  displayName: string;
  isSceneFile: boolean;
};

const EMPTY: SideloadedFileType[] = [];

let snapshot: SideloadedFileType[] = EMPTY;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function subscribeSideloadedFileTypes(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSideloadedFileTypesSnapshot(): SideloadedFileType[] {
  return snapshot;
}

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
      setSnapshot(next);
    } catch {
      // The runtime is unavailable (web build, or nothing installed yet).
      setSnapshot(EMPTY);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function setSnapshot(next: SideloadedFileType[]) {
  const same =
    next.length === snapshot.length &&
    next.every((entry, index) => {
      const current = snapshot[index];
      return (
        current?.pluginId === entry.pluginId &&
        current.extension === entry.extension &&
        current.displayName === entry.displayName &&
        current.isSceneFile === entry.isSceneFile
      );
    });
  if (same) return;
  snapshot = next.length === 0 ? EMPTY : next;
  for (const listener of listeners) listener();
}

/** The package that opens `fileName`, matched case-insensitively by extension. */
export function findSideloadedSceneFileType(fileName: string): SideloadedFileType | null {
  const normalized = fileName.trim().toLowerCase();
  if (!normalized) return null;
  return (
    snapshot.find((entry) => entry.isSceneFile && normalized.endsWith(entry.extension)) ?? null
  );
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
