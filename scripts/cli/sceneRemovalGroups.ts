type LinkedModel = { id: string; linkGroupId?: string };
type ModelGroup = { id: string; name: string; modelIds: string[] };

/**
 * What a removed model leaves behind in the scene's groups. The model comes off every
 * group it was in, and a group or link group left with fewer than two members is
 * dissolved, because one model has nothing to be grouped with. `deleteModels` in the
 * app dissolves link groups the same way.
 */
export function withoutModelInGroups<M extends LinkedModel>(params: {
  models: M[];
  groups: ModelGroup[];
  removed: LinkedModel;
}): { models: M[]; groups: ModelGroup[] } {
  const { models, groups, removed } = params;
  const linkGroupId = removed.linkGroupId;
  const linkPeers = linkGroupId ? models.filter((model) => model.linkGroupId === linkGroupId) : [];
  return {
    models: linkPeers.length === 1
      ? models.map((model) => (model === linkPeers[0] ? { ...model, linkGroupId: undefined } : model))
      : models,
    groups: groups
      .map((group) => ({ ...group, modelIds: group.modelIds.filter((id) => id !== removed.id) }))
      .filter((group, index) => group.modelIds.length >= 2 || group.modelIds.length === groups[index].modelIds.length),
  };
}
