import type { DragonfruitImportFormat, Segment, SupportState } from '../types';
import { collectCascade, groupByCollection, type EntityRef } from '../supportCascade';
import { migrateLegacySupportPayload } from '../importMigrations';
import { IMPORT_PAYLOAD_COLLECTION_ORDER } from '../supportCollections';
import { collectOwnedRootIds, MODEL_ID_COLLECTION_KEYS, SUPPORT_COLLECTION_KEYS, SUPPORT_TYPES, type SupportCollectionKey } from '../supportTypeRegistry';

/**
  * The relationship between supports and models: query a model's supports, and
  * remove them when it is deleted. Every walk reads MODEL_ID_COLLECTION_KEYS.
  */

/** Ids of a model's supports, one array per modelId-bearing collection. */
export type ModelSupportIds = Record<SupportCollectionKey, string[]>;

function emptyModelSupportIds(): ModelSupportIds {
    const result = {} as ModelSupportIds;
    for (const key of MODEL_ID_COLLECTION_KEYS) result[key] = [];
    return result;
}

/** Finds all support entity ids associated with a given model id. */
export function getSupportsForModel(
    state: Pick<SupportState, SupportCollectionKey>,
    modelId: string,
): ModelSupportIds {
    const result = emptyModelSupportIds();

    for (const key of MODEL_ID_COLLECTION_KEYS) {
        const record = state[key] as Record<string, { modelId?: string }> | undefined;
        if (!record) continue;
        for (const [id, entity] of Object.entries(record)) {
            if (entity.modelId === modelId) result[key].push(id);
        }
    }

    return result;
}

/**
 * Where a removal of `modelIds` starts: every entity that carries one of them.
 * `collectCascade` takes it from there, which is also what reaches a dependent
 * of another model hanging off one of them.
 *
 * A root is a seed only when nothing owns it. An owned root follows its owner,
 * whatever model it is stamped with: seeding it would pull it out from under a
 * trunk that stays.
 */
export function modelCascadeSeeds({ collections, modelIds }: {
    collections: Pick<SupportState, SupportCollectionKey>;
    modelIds: Iterable<string>;
}): EntityRef[] {
    const targets = new Set(modelIds);
    const ownedRootIds = collectOwnedRootIds(collections);
    const seeds: EntityRef[] = [];
    for (const collection of MODEL_ID_COLLECTION_KEYS) {
        const record = collections[collection] as Record<string, { id: string; modelId?: string }>;
        for (const entity of Object.values(record)) {
            if (entity.modelId === undefined || !targets.has(entity.modelId)) continue;
            if (collection === 'roots' && ownedRootIds.has(entity.id)) continue;
            seeds.push({ collection, id: entity.id });
        }
    }
    return seeds;
}

/**
 * The file's arrays as the id-keyed records a cascade walks. A kickstand is
 * unwrapped here: the file holds it with its root and host knot inside, a
 * CLI-written one has them nowhere else, and the wrapper wins as it does in
 * `loadFromImportFormat`. The records have no prototype because the ids come
 * from a file, and `__proto__` is not a key on a plain object. A null entry is
 * skipped: this rule does not repair a file, it only leaves it no worse.
 */
function payloadCascadeRecords(payload: DragonfruitImportFormat): Pick<SupportState, SupportCollectionKey> {
    const records: Record<string, Record<string, unknown>> = {};
    for (const key of SUPPORT_COLLECTION_KEYS) records[key] = Object.create(null) as Record<string, unknown>;

    for (const key of IMPORT_PAYLOAD_COLLECTION_ORDER) {
        if (key === 'kickstands') continue;
        const list = payload[key as keyof DragonfruitImportFormat] as ({ id: string } | null)[] | undefined;
        for (const entity of list ?? []) {
            if (entity) records[key][entity.id] = entity;
        }
    }
    for (const build of payload.kickstands ?? []) {
        if (!build?.kickstand) continue;
        records.kickstands[build.kickstand.id] = build.kickstand;
        if (build.root) records.roots[build.root.id] = build.root;
        if (build.hostKnot) records.knots[build.hostKnot.id] = build.hostKnot;
    }
    return records as unknown as Pick<SupportState, SupportCollectionKey>;
}

/**
 * `removeSupportEntitiesForModels` for a support payload: the same seeds and
 * the same cascade over the file's arrays, for callers with no store. A payload
 * under former collection names is read as the store would read it. `removed`
 * counts every entity that went, primitives included.
 */
export function withoutModelSupports({ payload, modelIds }: {
    payload: DragonfruitImportFormat;
    modelIds: Iterable<string>;
}): { payload: DragonfruitImportFormat; removed: number } {
    const current = migrateLegacySupportPayload(payload);
    const collections = payloadCascadeRecords(current);
    const seeds = modelCascadeSeeds({ collections, modelIds });
    if (seeds.length === 0) return { payload, removed: 0 };

    const doomed = collectCascade(collections, seeds);
    const doomedByCollection = groupByCollection(doomed);
    const next = { ...current } as unknown as Record<string, ({ id: string } | null)[] | undefined>;
    for (const [key, ids] of doomedByCollection) {
        if (key === 'kickstands') continue;
        next[key] = next[key]?.filter((entity) => !entity || !ids.has(entity.id));
    }

    const result = next as unknown as DragonfruitImportFormat;
    const doomedKickstands = doomedByCollection.get('kickstands' as SupportCollectionKey);
    if (current.kickstands && doomedKickstands) {
        result.kickstands = current.kickstands.filter((build) => !doomedKickstands.has(build?.kickstand?.id));
    }
    return { payload: result, removed: doomed.size };
}

/**
 * Which model a knot's parent shaft belongs to.
 *
 * `parentShaftId` names a SEGMENT on a shafted type -- that is what every knot
 * on a real shaft carries. A type with no segments hangs its knots off a
 * synthetic id built from its declared `segmentSelectionPrefix` instead, and
 * that names the entity.
 */
export function modelIdOfParentShaft(
    state: Pick<SupportState, SupportCollectionKey>,
    parentShaftId: string,
): string | null {
    for (const descriptor of SUPPORT_TYPES) {
        const record = state[descriptor.location.key as SupportCollectionKey] as
            Record<string, { modelId?: string; segments?: Segment[] }> | undefined;
        if (!record) continue;

        // A declared prefix means the id that follows names the entity.
        const prefix = descriptor.segmentSelectionPrefix;
        if (prefix && parentShaftId.startsWith(prefix)) {
            const modelId = record[parentShaftId.slice(prefix.length)]?.modelId;
            if (modelId) return modelId;
            continue;
        }

        // Otherwise it names one of the entity's segments. The bare entity id
        // is accepted too: older snapshots and previews use it.
        const direct = record[parentShaftId]?.modelId;
        if (direct) return direct;

        if (!descriptor.hasSegments) continue;
        for (const entity of Object.values(record)) {
            if (!entity.segments?.some((segment) => segment.id === parentShaftId)) continue;
            return entity.modelId ?? null;
        }
    }
    return null;
}


