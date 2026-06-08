import type { SupportBaseCircle } from './RaftTypes';
import type { Anchor, Roots } from '@/supports/types';

export const RAFT_UNASSIGNED_MODEL_KEY = '__raft_unassigned__';

type RootLike = Pick<Roots, 'modelId' | 'diameter' | 'transform'>;
type AnchorLike = Pick<Anchor, 'modelId' | 'rootBaseDiameter' | 'rootPos'>;

type CollectRaftBaseCirclesInput = {
  roots?: Iterable<RootLike>;
  anchors?: Iterable<AnchorLike>;
  kickstandRoots?: Iterable<RootLike>;
};

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
  input: CollectRaftBaseCirclesInput,
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

  for (const root of input.roots ?? []) {
    pushCircle(root.modelId, {
      x: root.transform.pos.x,
      y: root.transform.pos.y,
      r: root.diameter / 2,
    });
  }

  for (const anchor of input.anchors ?? []) {
    pushCircle(anchor.modelId, {
      x: anchor.rootPos.x,
      y: anchor.rootPos.y,
      r: anchor.rootBaseDiameter / 2,
    });
  }

  for (const root of input.kickstandRoots ?? []) {
    pushCircle(root.modelId, {
      x: root.transform.pos.x,
      y: root.transform.pos.y,
      r: root.diameter / 2,
    });
  }

  return byModel;
}