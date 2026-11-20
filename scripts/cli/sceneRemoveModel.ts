import { dissolveLoneLinkGroups } from '../../src/features/scene/linkGroups';
import type { VoxlDocumentV1 } from '../../src/features/scene/voxl/types';
import { withoutModelSupports } from '../../src/supports/PlacementLogic/SupportModelLinker';

/** `scene remove-model` on a loaded document, apart from the CLI entry point so tests can call it. */

type VoxlGroup = { id: string; name: string; modelIds: string[] };

/** Removes a model with its supports, link group and CLI group memberships; throws if it is not there. */
export function removeModelFromDocument(doc: VoxlDocumentV1, id: string): void {
  const removed = doc.models.find((model) => model.id === id);
  if (!removed) throw new Error(`Model '${id}' not found`);

  doc.models = dissolveLoneLinkGroups({ models: doc.models.filter((model) => model.id !== id), removed: [removed] });

  // CLI-only groups: a group lives while one model is in it, as an app group does through `groupId`.
  const groups = doc.extensions?.groups as VoxlGroup[] | undefined;
  if (groups) {
    doc.extensions!.groups = groups.flatMap((group) => {
      if (!group.modelIds.includes(id)) return [group];
      const modelIds = group.modelIds.filter((modelId) => modelId !== id);
      return modelIds.length > 0 ? [{ ...group, modelIds }] : [];
    });
  }

  doc.supports = withoutModelSupports({ payload: doc.supports, modelIds: [id] }).payload;

  if (doc.scene.activeModelId === id) doc.scene.activeModelId = null;
  doc.scene.selectedModelIds = doc.scene.selectedModelIds.filter((selectedId) => selectedId !== id);
}
