import { SUPPORT_TYPES } from './supportTypeRegistry';

/**
 * Rewrite a support payload written under a type's former names into the shape
 * the store reads today. Without this pass those entities load into no
 * collection and are dropped with no error. The old spellings are declared on
 * each descriptor as `renamedFrom`.
 */

/** A payload keyed by support collection, as the wire format writes it. */
type SupportPayload = Record<string, unknown>;

/** Every descriptor's former collection key, mapped to the key in use now. */
const COLLECTION_KEY_MIGRATIONS: readonly { from: string; to: string }[] =
    SUPPORT_TYPES.flatMap((descriptor) => (
        (descriptor.renamedFrom?.collectionKeys ?? []).map((from) => ({
            from,
            to: descriptor.location.key,
        }))
    ));

/** Every former type id, mapped to the id in use now. */
const TYPE_ID_MIGRATIONS: readonly { from: string; to: string }[] =
    SUPPORT_TYPES.flatMap((descriptor) => (
        (descriptor.renamedFrom?.ids ?? []).map((from) => ({ from, to: descriptor.id }))
    ));

/** The current id for a possibly-former one. */
function currentTypeId(typeId: unknown): string | undefined {
    if (typeof typeId !== 'string') return undefined;
    return TYPE_ID_MIGRATIONS.find((m) => m.from === typeId)?.to;
}

/**
 * Migrate a support payload. Idempotent; an already-current payload is returned
 * by identity, and the input is never mutated.
 */
export function migrateLegacySupportPayload<T>(payload: T): T {
    if (!payload || typeof payload !== 'object') return payload;
    const source = payload as SupportPayload;

    // Nothing to do unless a former collection key is present, or some entity
    // still carries a former type id.
    const hasFormerKey = COLLECTION_KEY_MIGRATIONS.some(({ from }) => from in source);
    const hasFormerStamp = !hasFormerKey && SUPPORT_TYPES.some((descriptor) => {
        const entities = source[descriptor.location.key];
        return Array.isArray(entities) && entities.some((entity) => {
            const record = entity as { typeId?: unknown; origin?: unknown } | null;
            return currentTypeId(record?.typeId) || currentTypeId(record?.origin);
        });
    });
    if (!hasFormerKey && !hasFormerStamp) return payload;

    const migrated: SupportPayload = { ...source };

    for (const { from, to } of COLLECTION_KEY_MIGRATIONS) {
        if (!(from in migrated)) continue;
        const legacy = migrated[from];
        // A payload carrying both keys has stale residue under the former one.
        if (!(to in migrated)) migrated[to] = legacy;
        delete migrated[from];
    }

    for (const descriptor of SUPPORT_TYPES) {
        const entities = migrated[descriptor.location.key];
        if (!Array.isArray(entities)) continue;
        if (!entities.some((entity) => {
            const record = entity as { typeId?: unknown; origin?: unknown } | null;
            return currentTypeId(record?.typeId) || currentTypeId(record?.origin);
        })) continue;
        migrated[descriptor.location.key] = entities.map((entity) => {
            const record = entity as { typeId?: unknown; origin?: unknown } | null;
            const to = currentTypeId(record?.typeId);
            // `origin` is a separate vocabulary that can carry the same former
            // name, so it migrates separately.
            const originTo = currentTypeId(record?.origin);
            if (!to && !originTo) return entity;
            return {
                ...(entity as object),
                ...(to ? { typeId: to } : {}),
                ...(originTo ? { origin: originTo } : {}),
            };
        });
    }

    return migrated as T;
}
