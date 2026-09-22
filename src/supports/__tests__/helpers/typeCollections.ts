import type { SupportClipboardPayload } from '../../PlacementLogic/supportClipboard';
import {
    getSupportTypeDescriptor,
    SUPPORT_COLLECTION_KEYS,
    SUPPORT_TYPES,
    type SupportCollectionKey,
    type SupportEntityFor,
    type SupportTypeId,
} from '../../supportTypeRegistry';

/** Collection keys and entity walks, asked of the registry rather than spelled. */

/** The collection a type's entities live in. */
export function keyOf(typeId: SupportTypeId): SupportCollectionKey {
    return getSupportTypeDescriptor(typeId).location.key;
}

/** Every collection key, in registry order. */
export const ALL_COLLECTION_KEYS: readonly SupportCollectionKey[] = SUPPORT_COLLECTION_KEYS;

/** The type owning a collection, or null for the primitives (`roots`, `knots`). */
export function owningTypeId(key: SupportCollectionKey): SupportTypeId | null {
    return SUPPORT_TYPES.find((descriptor) => descriptor.location.key === key)?.id ?? null;
}

/**
 * An entity as a mixed walk sees it. A caller that knows the type should use
 * `SupportEntityFor<T>` instead.
 */
export interface WalkedEntity {
    id: string;
    modelId?: string;
    segments?: Array<{ id: string; bottomJoint?: { id?: string }; topJoint?: { id?: string } }>;
    [field: string]: unknown;
}

/** A collection's entities, whether the source holds an array or a record. */
export function entitiesIn<T = WalkedEntity>(source: object, key: SupportCollectionKey): T[] {
    const value = (source as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value as T[];
    return Object.values((value ?? {}) as Record<string, T>);
}

/** Every collection in `source` as `[key, entities]`. */
export function collectionEntries(source: object): Array<[SupportCollectionKey, WalkedEntity[]]> {
    return ALL_COLLECTION_KEYS.map((key) => [key, entitiesIn(source, key)] as [SupportCollectionKey, WalkedEntity[]]);
}

/**
 * A clipboard payload with every collection present and empty, to be filled with
 * `setCollection`.
 */
export function emptyPayload(): SupportClipboardPayload {
    const payload = { kickstandRoots: [], kickstandKnots: [] } as unknown as SupportClipboardPayload;
    for (const key of ALL_COLLECTION_KEYS) {
        (payload as Record<string, unknown>)[key] = [];
    }
    return payload;
}

/** Fill one collection of a payload, with the entities the type declares. */
export function setCollection<K extends SupportTypeId>(
    payload: SupportClipboardPayload,
    typeId: K,
    entities: Array<SupportEntityFor<K>>,
): void {
    (payload as Record<string, unknown>)[keyOf(typeId)] = entities;
}
