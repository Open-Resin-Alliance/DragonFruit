import type { ExportSceneContext } from '@/features/export/logic/ExportManager';

type SceneSaveKey = Exclude<keyof ExportSceneContext, 'exportThumbnailPng'>;

/**
 * Everything a scene save writes, apart from the thumbnail. Every key must be
 * passed, even when its value is `undefined`, so adding a field to
 * `ExportSceneContext` stops each save from compiling until it passes it.
 */
export type SceneSaveSource = { [K in SceneSaveKey]: ExportSceneContext[K] };

/**
 * The scene part of a save, shared by Ctrl/Cmd+S and autosave so the two
 * cannot write different scenes. A save writes every model, hidden ones
 * included: hiding a model is a view setting, not a deletion (#925).
 */
export function buildSceneSaveContext(
  source: SceneSaveSource,
  exportThumbnailPng?: Uint8Array | null,
): ExportSceneContext {
  return {
    models: source.models,
    activeModelId: source.activeModelId,
    selectedModelIds: source.selectedModelIds,
    plates: source.plates,
    activePlateId: source.activePlateId,
    plateName: source.plateName,
    printer: source.printer,
    plateOrdering: source.plateOrdering,
    ...(exportThumbnailPng ? { exportThumbnailPng } : {}),
  };
}
