/**
 * The support store sliced by model, built once per collection change.
 *
 * A support write replaces only the entities it touched — the store carries
 * every other collection and entity through by reference. So "did this model's
 * supports change?" is answerable by comparing its entity references, and a
 * consumer that caches per model (the out-of-bounds walk, the proxy layout) can
 * rebuild only the model that moved instead of the whole plate.
 *
 * The slice is also what makes those walks linear: asking "which of this
 * model's supports exist?" used to mean scanning every collection per model.
 */
import { hostKnotFieldsFor, SUPPORT_COLLECTION_KEYS, SUPPORT_TYPES } from '@/supports/supportTypeRegistry';

export const SUPPORT_MODEL_NONE_KEY = '__none__';

export type SupportEntityRecord = Record<string, unknown>;

export type SupportModelIndex = {
  /** Every model key present, in collection order. */
  modelKeys: string[];
  /** Every entity the model owns, in a stable order — the change fingerprint. */
  byModel: Map<string, SupportEntityRecord[]>;
  /** Entities per type collection, per model key. */
  entitiesByTypeByModel: Map<string, Map<string, SupportEntityRecord[]>>;
  rootsByModel: Map<string, SupportEntityRecord[]>;
  /** The knots the model's supports hang from, through each type's `hostedBy`. */
  knotsByModel: Map<string, SupportEntityRecord[]>;
};

export const EMPTY_SUPPORT_ENTITIES: SupportEntityRecord[] = [];
export const EMPTY_SUPPORT_MODELS: Set<string> = new Set<string>();

function modelKeyOf(entity: SupportEntityRecord): string {
  const modelId = entity.modelId;
  return typeof modelId === 'string' && modelId ? modelId : SUPPORT_MODEL_NONE_KEY;
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

export function buildSupportModelIndex(state: {
  roots?: Record<string, SupportEntityRecord>;
  knots?: Record<string, SupportEntityRecord>;
} & Record<string, unknown>): SupportModelIndex {
  const modelKeys: string[] = [];
  const seen = new Set<string>();
  const byModel = new Map<string, SupportEntityRecord[]>();
  const entitiesByTypeByModel = new Map<string, Map<string, SupportEntityRecord[]>>();
  const rootsByModel = new Map<string, SupportEntityRecord[]>();
  const knotIdsByModel = new Map<string, Set<string>>();

  const track = (modelKey: string, entity: SupportEntityRecord) => {
    if (!seen.has(modelKey)) { seen.add(modelKey); modelKeys.push(modelKey); }
    pushTo(byModel, modelKey, entity);
  };

  for (const root of Object.values(state.roots ?? {})) {
    const modelKey = modelKeyOf(root);
    pushTo(rootsByModel, modelKey, root);
    track(modelKey, root);
  }

  for (const descriptor of SUPPORT_TYPES) {
    const collection = state[descriptor.location.key] as Record<string, SupportEntityRecord> | undefined;
    if (!collection) continue;
    const knotFields = hostKnotFieldsFor(descriptor.id);
    const byModelForType = new Map<string, SupportEntityRecord[]>();
    for (const entity of Object.values(collection)) {
      const modelKey = modelKeyOf(entity);
      pushTo(byModelForType, modelKey, entity);
      track(modelKey, entity);
      if (knotFields.length === 0) continue;
      let knotIds = knotIdsByModel.get(modelKey);
      if (!knotIds) { knotIds = new Set<string>(); knotIdsByModel.set(modelKey, knotIds); }
      for (const field of knotFields) {
        const knotId = entity[field];
        if (typeof knotId === 'string') knotIds.add(knotId);
      }
    }
    entitiesByTypeByModel.set(descriptor.location.key, byModelForType);
  }

  const knotsByModel = new Map<string, SupportEntityRecord[]>();
  for (const [modelKey, knotIds] of knotIdsByModel) {
    const knots: SupportEntityRecord[] = [];
    for (const knotId of knotIds) {
      const knot = state.knots?.[knotId];
      if (knot) knots.push(knot);
    }
    if (knots.length > 0) knotsByModel.set(modelKey, knots);
  }

  return { modelKeys, byModel, entitiesByTypeByModel, rootsByModel, knotsByModel };
}

/** Models whose entity references differ between two indexes. */
export function changedSupportModels(
  previous: SupportModelIndex | null,
  next: SupportModelIndex,
): Set<string> {
  const changed = new Set<string>();
  if (!previous) {
    for (const modelKey of next.modelKeys) changed.add(modelKey);
    return changed;
  }
  for (const modelKey of next.modelKeys) {
    const nextEntities = next.byModel.get(modelKey);
    const previousEntities = previous.byModel.get(modelKey);
    if (nextEntities === previousEntities) continue;
    if (!previousEntities || previousEntities.length !== (nextEntities?.length ?? 0)) {
      changed.add(modelKey);
      continue;
    }
    for (let i = 0; i < nextEntities!.length; i += 1) {
      if (previousEntities[i] !== nextEntities![i]) { changed.add(modelKey); break; }
    }
  }
  return changed;
}

let indexCache: {
  refs: readonly unknown[];
  index: SupportModelIndex;
} | null = null;

/**
 * The index for the current collections, built once per state change and shared
 * by every consumer that runs in the same commit.
 */
export function getSupportModelIndex(
  state: { roots?: Record<string, SupportEntityRecord>; knots?: Record<string, SupportEntityRecord> } & Record<string, unknown>,
): SupportModelIndex {
  const refs = SUPPORT_COLLECTION_KEYS.map((key) => (state as Record<string, unknown>)[key]);
  const cached = indexCache;
  if (cached && cached.refs.length === refs.length && cached.refs.every((ref, i) => ref === refs[i])) {
    return cached.index;
  }
  const index = buildSupportModelIndex(state);
  indexCache = { refs, index };
  return index;
}
