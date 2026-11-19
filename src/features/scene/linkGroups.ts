/** Clears the link group of every model that removing `removed` leaves without a linked peer. */
export function dissolveLoneLinkGroups<M extends { linkGroupId?: string }>({ models, removed }: {
  models: M[];
  removed: Iterable<{ linkGroupId?: string }>;
}): M[] {
  let next = models;
  const removedLinkGroupIds = new Set<string>();
  for (const model of removed) if (model.linkGroupId) removedLinkGroupIds.add(model.linkGroupId);
  for (const linkGroupId of removedLinkGroupIds) {
    if (next.filter((model) => model.linkGroupId === linkGroupId).length >= 2) continue;
    next = next.map((model) => (model.linkGroupId === linkGroupId ? { ...model, linkGroupId: undefined } : model));
  }
  return next;
}
