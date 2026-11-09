import type * as THREE from 'three';
import type { PluginFileTypeDefinition } from '@/features/plugins/complexPluginContracts';
import type { DragonfruitImportFormat } from '@/supports/types';

/**
 * One model produced by a scene-file plugin import.
 *
 * `modelId` is required: the host uses it as the created model's id and stamps
 * it onto every support in `supportData`, so the association is guaranteed
 * rather than left to a plugin and the host agreeing by convention.
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
 * `success: false` with an `error` string surfaces a user-visible failure.
 * Scene-file plugins return `PluginSceneImportPayload`; the union keeps
 * `unknown` for file types whose payload is private to the plugin.
 */
export type PluginFileTypeImportResult =
  | { success: true; payload: PluginSceneImportPayload }
  | { success: true; payload: unknown }
  | { success: false; error: string };

/**
 * Exported by every `fileType`-capable plugin from `fileTypeHandlers.ts` as
 * `handleFileTypeImport`.
 *
 * @param file - from a file picker or drag-and-drop.
 * @param fileTypeDefinition - the matching definition, so the handler can read
 *   metadata such as `isSceneFile` without hard-coding it.
 */
export type PluginFileTypeHandler = (
  file: File,
  fileTypeDefinition: PluginFileTypeDefinition,
) => Promise<PluginFileTypeImportResult>;
