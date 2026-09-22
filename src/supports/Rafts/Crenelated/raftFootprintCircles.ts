import type { SupportBaseCircle } from './RaftTypes';
import { INLINE_ROOT_TYPES, type SupportCollectionKey } from '@/supports/supportTypeRegistry';
import type { SupportState } from '@/supports/types';

export const RAFT_UNASSIGNED_MODEL_KEY = '__raft_unassigned__';

/**
 * The state a raft footprint is read from: the collections it walks, which are
 * the shared roots plus whichever types carry their own inline root.
 */
export type RaftFootprintSource = Pick<SupportState, SupportCollectionKey>;

type CollectRaftBaseCirclesOptions = {
  modelFilterId?: string | null;
  excludeModelId?: string | null;
  excludedModelIds?: ReadonlySet<string> | Iterable<string>;
  fallbackModelKey?: string;
};

function shouldIncludeModel(
  modelId: string | null | undefined,
  options: CollectRaftBaseCirclesOptions,
  excludedModelIdSet: ReadonlySet<string>,
): boolean {
  if (options.modelFilterId != null) {
    return modelId === options.modelFilterId;
  }

  if (options.excludeModelId && modelId === options.excludeModelId) {
    return false;
  }

  if (modelId && excludedModelIdSet.has(modelId)) {
    return false;
  }

  return true;
}

function toExcludedModelIdSet(
  excludedModelIds: CollectRaftBaseCirclesOptions['excludedModelIds'],
): ReadonlySet<string> {
  if (!excludedModelIds) {
    return new Set<string>();
  }

  return excludedModelIds instanceof Set
    ? excludedModelIds
    : new Set(excludedModelIds);
}

export function toRaftModelKey(
  modelId: string | null | undefined,
  fallbackModelKey = RAFT_UNASSIGNED_MODEL_KEY,
): string {
  return modelId ?? fallbackModelKey;
}

export function fromRaftModelKey(
  modelKey: string,
  fallbackModelKey = RAFT_UNASSIGNED_MODEL_KEY,
): string | null {
  return modelKey === fallbackModelKey ? null : modelKey;
}

export function collectRaftBaseCirclesByModel(
  state: RaftFootprintSource,
  options: CollectRaftBaseCirclesOptions = {},
): Map<string, SupportBaseCircle[]> {
  const byModel = new Map<string, SupportBaseCircle[]>();
  const excludedModelIdSet = toExcludedModelIdSet(options.excludedModelIds);
  const fallbackModelKey = options.fallbackModelKey ?? RAFT_UNASSIGNED_MODEL_KEY;

  const pushCircle = (modelId: string | null | undefined, circle: SupportBaseCircle) => {
    if (!shouldIncludeModel(modelId, options, excludedModelIdSet)) return;

    const modelKey = toRaftModelKey(modelId, fallbackModelKey);
    const circles = byModel.get(modelKey);
    if (circles) {
      circles.push(circle);
      return;
    }

    byModel.set(modelKey, [circle]);
  };

  // Every plate-rooted support's base is a `Roots` record in this one
  // collection, a kickstand's included, so one walk covers all of them.
  for (const root of Object.values(state.roots ?? {})) {
    pushCircle(root.modelId, {
      x: root.transform.pos.x,
      y: root.transform.pos.y,
      r: root.diameter / 2,
    });
  }

  // A type that carries its base as geometry on the entity is not in that
  // collection, and the fields to read are declared rather than named here.
  for (const { collectionKey, posField, radiusField } of INLINE_ROOT_TYPES) {
    const collection = state[collectionKey] as unknown as
      Record<string, Record<string, unknown>> | undefined;
    for (const entity of Object.values(collection ?? {})) {
      const pos = entity[posField] as { x: number; y: number } | undefined;
      const radius = entity[radiusField] as number | undefined;
      if (!pos || typeof radius !== 'number') continue;
      pushCircle(entity.modelId as string | null | undefined, {
        x: pos.x,
        y: pos.y,
        r: radius / 2,
      });
    }
  }

  return byModel;
}

/**
 * The collections the raft footprint reads, in a stable order.
 *
 * A caller caching footprint geometry uses this as its identity: it changes when
 * a contributing collection changes, and not when an unrelated type is edited.
 */
export function raftFootprintSourceRefs(state: RaftFootprintSource): readonly unknown[] {
  return [
    state.roots,
    ...INLINE_ROOT_TYPES.map(({ collectionKey }) => state[collectionKey]),
  ];
}

/** Whether two source ref sets are the same collections, by identity. */
export function sameRaftFootprintSource(
  a: readonly unknown[] | undefined,
  b: readonly unknown[],
): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((ref, i) => ref === b[i]);
}