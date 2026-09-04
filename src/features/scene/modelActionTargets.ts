export type ModelActionTargetInput = {
  modelIds: readonly string[];
  selectedModelIds: readonly string[];
  activeModelId?: string | null;
  contextModelId?: string | null;
};

export function resolveModelActionTargetIds({
  modelIds,
  selectedModelIds,
  activeModelId,
  contextModelId,
}: ModelActionTargetInput): string[] {
  const validIds = new Set(modelIds);
  const seen = new Set<string>();
  const selectedIds = selectedModelIds.filter((id) => {
    if (!validIds.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  if (selectedIds.length > 0) return selectedIds;

  const fallbackId = [contextModelId, activeModelId]
    .find((id): id is string => typeof id === 'string' && validIds.has(id));
  return fallbackId ? [fallbackId] : [];
}

export function dispatchDeleteModelAction(
  targets: ModelActionTargetInput,
  deleteModels: (ids: string[]) => void | Promise<void>,
): boolean {
  const targetIds = resolveModelActionTargetIds(targets);
  if (targetIds.length === 0) return false;

  void deleteModels(targetIds);
  return true;
}

export function dispatchCutModelAction(
  targets: ModelActionTargetInput,
  cutSelectedModels: (ids: string[]) => boolean,
): boolean {
  const targetIds = resolveModelActionTargetIds(targets);
  if (targetIds.length === 0) return false;

  return cutSelectedModels(targetIds);
}
