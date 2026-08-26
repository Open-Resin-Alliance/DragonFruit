import type * as THREE from 'three';
import type { PluginFileTypeDefinition } from '@/features/plugins/complexPluginContracts';
import type { DragonfruitImportFormat } from '@/supports/types';

/**
 * One model produced by a scene-file plugin import.
 *
 * `modelId` is REQUIRED and is the contract that binds a model to its supports.
 * The host uses it as the created model's id, and stamps it onto every support
 * in `supportData` so the association is guaranteed rather than assumed.
 *
 * Before this was declared here the bridge passed `payload: unknown`, so the
 * link existed only by convention: a plugin separately (a) stamped `modelId`
 * onto its supports and (b) returned the same value on the payload, and the two
 * happened to agree. Nothing verified that, so a plugin that disagreed with
 * itself -- or omitted `modelId` and fell through to the host's `uuidv4()`
 * fallback -- produced supports belonging to no model: invisible to
 * `getSupportsForModel`, unmoved by per-model transforms, and impossible to
 * chunk per model on save.
 */
export interface PluginSceneImportModel {
  /**
   * Stable id for this model. Used verbatim as the host model id and reconciled
   * onto every support in `supportData`.
   *
   * Derive it from the source file's own object identity where the format has
   * one (LYS object id, Chitubox per-model block) so a re-import of the same
   * file is stable. A generated uuid is acceptable when the format has no such
   * identity, but it must be the SAME id stamped onto this model's supports.
   */
  modelId: string;
  /**
   * Display name from the SOURCE file, where the format carries one: the LYS
   * object's `name`, or the per-model filename inside a `.chitubox` container.
   *
   * Preferred over a name derived from the imported filename, which cannot
   * distinguish models inside one container and falls back to numeric suffixes
   * ("project (2)", "project (3)"). Omit when the format carries no name.
   */
  objName?: string;
  geometry: THREE.BufferGeometry;
  transform: {
    position: THREE.Vector3;
    rotation: THREE.Euler;
    scale: THREE.Vector3;
  };
  /** Supports for THIS model only, in DragonFruit's internal format. */
  supportData?: DragonfruitImportFormat | null;
  /** Hollowing configuration / hole punches, when the format carries them. */
  meshModifiers?: unknown;
}

/**
 * Payload a scene-file plugin returns: one model, or several for a container
 * format that holds more than one (multi-model `.lys` / `.chitubox`).
 *
 * Emitting one entry PER MODEL -- each with its own `modelId` and only its own
 * supports -- is what lets the host keep supports attached to the right model.
 */
export type PluginSceneImportPayload = PluginSceneImportModel | PluginSceneImportModel[];

/**
 * The result returned by a plugin file-type import handler.
 *
 * `success: false` with an `error` string signals a user-visible import
 * failure; the host surfaces the error without crashing.
 *
 * On success, `payload` carries the structured import data the host dispatch
 * path consumes (see `useSceneCollectionManager`). Scene-file plugins should
 * return `PluginSceneImportPayload`; the union keeps `unknown` for non-scene
 * file types whose payload shape is private to the plugin and its own consumer.
 */
export type PluginFileTypeImportResult =
  | { success: true; payload: PluginSceneImportPayload }
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
