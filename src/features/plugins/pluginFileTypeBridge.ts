import type { PluginFileTypeDefinition } from '@/features/plugins/complexPluginContracts';

/**
 * The result returned by a plugin file-type import handler.
 *
 * `success: false` with an `error` string signals a user-visible import
 * failure; the host surfaces the error without crashing.
 *
 * On success, `payload` carries the structured import data that the host
 * dispatch path consumes (e.g. scene objects, support geometry). The exact
 * shape is intentionally opaque here and agreed between the plugin and the
 * host scene-import dispatcher (see `useSceneCollectionManager`).
 */
export type PluginFileTypeImportResult =
  | { success: true; payload: unknown }
  | { success: false; error: string };

/**
 * Handler function that every `fileType`-capable plugin must export from
 * `fileTypeHandlers.ts` as the named export `handleFileTypeImport`.
 *
 * @param file - The raw `File` object received from a file picker or
 *   drag-and-drop event.
 * @param fileTypeDefinition - The matching `PluginFileTypeDefinition` from
 *   the plugin's `pluginDefinition.ts`, provided for convenience so the
 *   handler can inspect metadata (e.g. `isSceneFile`) without hard-coding it.
 * @returns A promise that resolves to a `PluginFileTypeImportResult`.
 */
export type PluginFileTypeHandler = (
  file: File,
  fileTypeDefinition: PluginFileTypeDefinition,
) => Promise<PluginFileTypeImportResult>;
