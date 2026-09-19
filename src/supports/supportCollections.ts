import { MODEL_ID_COLLECTION_KEYS, type SupportCollectionKey } from './supportTypeRegistry';
import type { DragonfruitImportFormat, SupportState } from './types';

/**
 * Keys of `SupportState` holding modelId-bearing support entities. Excludes
 * `knots`, which are attachments and carry no modelId.
 */
export const SUPPORT_ENTITY_COLLECTIONS = MODEL_ID_COLLECTION_KEYS;

export type SupportEntityCollectionKey = SupportCollectionKey;

/** Narrower than SupportState so these work on a partial import payload too. */
export type SupportEntityCollections = Pick<SupportState, SupportEntityCollectionKey>;

/** Minimum shape a support entity must have to take part in these walks. */
export interface SupportEntityLike {
    id: string;
    modelId?: string;
}

/**
 * Apply `mapEntity` to every entity in every collection, copy-on-write. Returns
 * the original when nothing changed; `mapEntity` signals no change by returning
 * the entity by reference.
 */
export function mapSupportEntities<T extends SupportEntityCollections>(
    collections: T,
    mapEntity: <E extends SupportEntityLike>(entity: E, collection: SupportEntityCollectionKey) => E,
): { collections: T; changed: boolean } {
    let changed = false;
    let next: T = collections;

    for (const key of SUPPORT_ENTITY_COLLECTIONS) {
        const record = collections[key] as Record<string, SupportEntityLike> | undefined;
        if (!record) continue;

        let nextRecord: Record<string, SupportEntityLike> | null = null;
        for (const entity of Object.values(record)) {
            const mapped = mapEntity(entity, key);
            if (mapped === entity) continue;

            if (!nextRecord) nextRecord = { ...record };
            nextRecord[entity.id] = mapped;
        }

        if (nextRecord) {
            if (!changed) {
                next = { ...collections };
                changed = true;
            }
            (next as Record<string, unknown>)[key] = nextRecord;
        }
    }

    return { collections: next, changed };
}


/**
 * Apply `mapEntity` to every support entity in an import payload, which stores
 * its collections as arrays. Optional collections stay `undefined` rather than
 * `[]`. Kickstands nest at `kickstands[].kickstand` and are not covered here.
 */
export function mapImportPayloadEntities<T extends Partial<Record<SupportEntityCollectionKey, unknown>>>(
    payload: T,
    mapEntity: <E extends SupportEntityLike>(entity: E, collection: SupportEntityCollectionKey) => E,
): T {
    const next = { ...payload };
    for (const key of SUPPORT_ENTITY_COLLECTIONS) {
        const list = payload[key] as SupportEntityLike[] | undefined;
        if (!list) continue;
        (next as Record<string, unknown>)[key] = list.map((entity) => mapEntity(entity, key));
    }
    return next;
}

/** The payload's collection part: every `DragonfruitImportFormat` key but `version` and `meta`. */
export type ImportPayloadCollections = Pick<DragonfruitImportFormat, SupportCollectionKey>;

/**
 * The payload's collections in the order `DragonfruitImportFormat` declares
 * them. Written out because the order is part of the wire format, which the
 * export goldens compare byte-for-byte. Membership is guarded by
 * `registryIsSingleSourceOfTruth.test.ts`.
 */
export const IMPORT_PAYLOAD_COLLECTION_ORDER: readonly SupportCollectionKey[] = [
    'roots',
    'trunks',
    'branches',
    'leaves',
    'twigs',
    'sticks',
    'braces',
    'stumps',
    'knots',
    'kickstands',
];

/**
 * The wire format's collections, read out of any registry-keyed source as
 * arrays. The format stores arrays; the store holds id-keyed records.
 */
export function importPayloadCollections(source: Partial<Record<SupportCollectionKey, unknown>>): ImportPayloadCollections {
    const collections = {} as Record<SupportCollectionKey, unknown[]>;
    for (const key of IMPORT_PAYLOAD_COLLECTION_ORDER) {
        const value = (source as Record<string, unknown>)[key];
        collections[key] = Array.isArray(value) ? value : Object.values((value ?? {}) as Record<string, unknown>);
    }
    return collections as ImportPayloadCollections;
}
