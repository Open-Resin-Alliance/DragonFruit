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

/** A body of a multi-body 3MF model, picked from its row in the model list. */
export type SelectedModelBody = { modelId: string; bodyIndex: number };

export type BodyDeleteTargets = {
  selectedBodies: readonly SelectedModelBody[];
  deleteModelBodies: (modelId: string, bodyIndices: number[]) => unknown;
};

/** The selected bodies of the target models, grouped by model in selection order. */
export function groupSelectedBodiesByModel(
  targetIds: readonly string[],
  selectedBodies: readonly SelectedModelBody[],
): Map<string, number[]> {
  const byModel = new Map<string, number[]>();
  for (const { modelId, bodyIndex } of selectedBodies) {
    if (!targetIds.includes(modelId)) continue;
    const indices = byModel.get(modelId);
    if (!indices) byModel.set(modelId, [bodyIndex]);
    else if (!indices.includes(bodyIndex)) indices.push(bodyIndex);
  }
  return byModel;
}

export function dispatchDeleteModelAction(
  targets: ModelActionTargetInput,
  deleteModels: (ids: string[]) => void | Promise<void>,
  bodies?: BodyDeleteTargets,
): boolean {
  const targetIds = resolveModelActionTargetIds(targets);
  if (targetIds.length === 0) return false;

  // A model with selected bodies loses only those bodies; the other targets go whole.
  const bodiesByModel = groupSelectedBodiesByModel(targetIds, bodies?.selectedBodies ?? []);
  for (const [modelId, bodyIndices] of bodiesByModel) {
    bodies?.deleteModelBodies(modelId, bodyIndices);
  }
  const wholeIds = targetIds.filter((id) => !bodiesByModel.has(id));
  if (wholeIds.length > 0) void deleteModels(wholeIds);
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
