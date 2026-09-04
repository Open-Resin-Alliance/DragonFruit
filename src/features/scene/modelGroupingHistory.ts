export type GroupableModel = {
  id: string;
  name: string;
  groupId?: string;
  groupName?: string;
};

type GroupingTransition<T extends GroupableModel> = {
  models: T[];
  activeModelId: string | null;
  selectedModelIds: string[];
  changed: boolean;
  groupId?: string;
  description?: string;
};

export function applyModelGrouping<T extends GroupableModel>({
  models,
  modelIds,
  groupId,
  groupName,
  activeModelId,
  selectedModelIds,
}: {
  models: T[];
  modelIds: string[];
  groupId: string;
  groupName?: string;
  activeModelId: string | null;
  selectedModelIds: string[];
}): GroupingTransition<T> {
  const ids = Array.from(new Set(modelIds));
  if (ids.length === 0) {
    return { models, activeModelId, selectedModelIds, changed: false };
  }

  const selected = models.filter((model) => ids.includes(model.id));
  if (selected.length === 0) {
    return { models, activeModelId, selectedModelIds, changed: false };
  }

  const commonGroupId = selected.every((model) => model.groupId && model.groupId === selected[0].groupId)
    ? (selected[0].groupId ?? null)
    : null;

  const resolvedGroupId = commonGroupId ?? groupId;
  const rawName = groupName?.trim();
  const resolvedGroupName = rawName && rawName.length > 0
    ? rawName
    : (selected.find((model) => model.groupName?.trim())?.groupName ?? selected[0].name);

  let changed = false;
  const nextModels = models.map((model) => {
    if (!ids.includes(model.id)) return model;
    if (model.groupId === resolvedGroupId && model.groupName === resolvedGroupName) return model;
    changed = true;
    return {
      ...model,
      groupId: resolvedGroupId,
      groupName: resolvedGroupName,
    };
  });

  if (!changed) {
    return { models, activeModelId, selectedModelIds, changed: false, groupId: resolvedGroupId };
  }

  return {
    models: nextModels,
    activeModelId: activeModelId ?? ids[0] ?? null,
    selectedModelIds: Array.from(new Set([...selectedModelIds, ...ids])),
    changed: true,
    groupId: resolvedGroupId,
    description: selected.length === 1 ? `Group Model ${selected[0].name}` : `Group ${selected.length} Models`,
  };
}

export function applyModelUngrouping<T extends GroupableModel>({
  models,
  modelIds,
  activeModelId,
  selectedModelIds,
}: {
  models: T[];
  modelIds: string[];
  activeModelId: string | null;
  selectedModelIds: string[];
}): GroupingTransition<T> {
  const ids = new Set(modelIds);
  if (ids.size === 0) {
    return { models, activeModelId, selectedModelIds, changed: false };
  }

  const affected = models.filter((model) => ids.has(model.id) && model.groupId);
  if (affected.length === 0) {
    return { models, activeModelId, selectedModelIds, changed: false };
  }

  const nextModels = models.map((model) => (
    ids.has(model.id) && model.groupId
      ? { ...model, groupId: undefined, groupName: undefined }
      : model
  ));

  return {
    models: nextModels,
    activeModelId,
    selectedModelIds,
    changed: true,
    description: affected.length === 1 ? `Ungroup Model ${affected[0].name}` : `Ungroup ${affected.length} Models`,
  };
}

export function applyModelGroupUngrouping<T extends GroupableModel>({
  models,
  groupId,
  activeModelId,
  selectedModelIds,
}: {
  models: T[];
  groupId: string;
  activeModelId: string | null;
  selectedModelIds: string[];
}): GroupingTransition<T> {
  const affected = models.filter((model) => model.groupId === groupId);
  if (affected.length === 0) {
    return { models, activeModelId, selectedModelIds, changed: false };
  }

  const nextModels = models.map((model) => (
    model.groupId === groupId
      ? { ...model, groupId: undefined, groupName: undefined }
      : model
  ));
  const groupName = affected.find((model) => model.groupName?.trim())?.groupName?.trim();

  return {
    models: nextModels,
    activeModelId,
    selectedModelIds,
    changed: true,
    description: groupName ? `Ungroup ${groupName}` : `Ungroup ${affected.length} Models`,
  };
}
