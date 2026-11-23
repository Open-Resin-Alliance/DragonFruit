import type { HistorySelection } from '@/history/types';

/**
 * The selection an undone or redone entry should bring back, or `null` to leave the
 * current one alone.
 *
 * Only models that still exist and can be selected come back; a model the entry
 * itself removed (undoing its import) is simply left out. When none are left the
 * current selection stays, rather than being cleared by an entry that has nothing
 * to point at. `null` also when the selection is already the one saved, so a run
 * of undos on the same model does not keep moving the camera.
 */
export function resolveHistorySelection(
  saved: HistorySelection | undefined,
  current: HistorySelection,
  isSelectable: (modelId: string) => boolean,
): HistorySelection | null {
  if (!saved) return null;
  const modelIds = saved.modelIds.filter(isSelectable);
  const activeModelId = saved.activeModelId && isSelectable(saved.activeModelId)
    ? saved.activeModelId
    : (modelIds[0] ?? null);
  if (activeModelId && !modelIds.includes(activeModelId)) modelIds.unshift(activeModelId);
  if (modelIds.length === 0) return null;

  const next = { activeModelId, modelIds };
  return sameHistorySelection(next, current) ? null : next;
}

/** Same active model and the same models selected, in any order. */
export function sameHistorySelection(a: HistorySelection, b: HistorySelection): boolean {
  return a.activeModelId === b.activeModelId
    && a.modelIds.length === b.modelIds.length
    && a.modelIds.every((id) => b.modelIds.includes(id));
}
