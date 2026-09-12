import type { Segment, SupportState } from '../types';
import { getSnapshot, setSnapshot } from '../state';
import { getSupportTypeDescriptor, MODEL_ID_COLLECTION_KEYS, parseKnotHostId, SUPPORT_TYPES, type SupportCollectionKey } from '../supportTypeRegistry';

/**
  * The relationship between supports and models: query a model's supports, and
  * remove them when it is deleted. Both walks read MODEL_ID_COLLECTION_KEYS.
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

/** Segment ids owned by the entities being removed, for cascading knot removal. */
function collectRemovedSegmentIds(
    state: Pick<SupportState, SupportCollectionKey>,
    removing: ModelSupportIds,
): Set<string> {
    const segmentIds = new Set<string>();

    for (const key of MODEL_ID_COLLECTION_KEYS) {
        const record = state[key] as Record<string, { segments?: Segment[] }> | undefined;
        if (!record) continue;
        for (const id of removing[key]) {
            for (const segment of record[id]?.segments ?? []) segmentIds.add(segment.id);
        }
    }

    // A type with no `segments` hangs its knots off a synthetic shaft id, built
    // from the prefix it declares.
    for (const descriptor of SUPPORT_TYPES) {
        const prefix = descriptor.segmentSelectionPrefix;
        if (!prefix) continue;
        for (const id of removing[descriptor.location.key as SupportCollectionKey] ?? []) {
            segmentIds.add(`${prefix}${id}`);
        }
    }

    return segmentIds;
}

/**
 * Removes every support belonging to `modelId`.
 *
 * @returns entities removed, excluding roots -- they cascade from shaft removals
 * rather than counting as removals themselves.
 */
export function deleteSupportsForModel(state: SupportState, modelId: string): number {
    const removing = getSupportsForModel(state, modelId);

    const hasAnything = MODEL_ID_COLLECTION_KEYS.some((key) => removing[key].length > 0);
    if (!hasAnything) return 0;

    const removingSets = {} as Record<SupportCollectionKey, Set<string>>;
    for (const key of MODEL_ID_COLLECTION_KEYS) removingSets[key] = new Set(removing[key]);

    const segmentsToRemove = collectRemovedSegmentIds(state, removing);

    // A kickstand owns its root and host knot, so both go with it.
    const knotsToRemove = new Set<string>();
    for (const kickstandId of removing.kickstands) {
        const kickstand = state.kickstands[kickstandId];
        if (!kickstand) continue;
        removingSets.roots.add(kickstand.rootId);
        knotsToRemove.add(kickstand.hostKnotId);
    }

    for (const [knotId, knot] of Object.entries(state.knots)) {
        const parentShaftId = knot.parentShaftId;
        const removeByShaft = segmentsToRemove.has(parentShaftId);
        // A knot riding a pseudo-shaft goes when its host does. Derived, so a
        // third pseudo-shaft type is covered without another `||`.
        const host = parseKnotHostId(parentShaftId);
        const hostCollection = host
            ? removingSets[getSupportTypeDescriptor(host.typeId).location.key]
            : undefined;
        const removeByHost = !!host && !!hostCollection?.has(host.entityId);
        if (removeByShaft || removeByHost) {
            knotsToRemove.add(knotId);
        }
    }

    const filterRecord = <T>(record: Record<string, T>, shouldRemove: (id: string) => boolean): Record<string, T> => {
        const next: Record<string, T> = {};
        for (const [id, value] of Object.entries(record)) {
            if (shouldRemove(id)) continue;
            next[id] = value;
        }
        return next;
    };

    const nextState: SupportState = {
        ...state,
        knots: filterRecord(state.knots, (id) => knotsToRemove.has(id)),
        selectedId: null,
        selectedCategory: null,
        hoveredId: null,
    };

    for (const key of MODEL_ID_COLLECTION_KEYS) {
        (nextState as unknown as Record<string, unknown>)[key] = filterRecord(
            state[key] as Record<string, unknown>,
            (id) => removingSets[key].has(id),
        );
    }

    setSnapshot(nextState);

    let removedCount = 0;
    for (const key of MODEL_ID_COLLECTION_KEYS) {
        if (key === 'roots') continue;
        removedCount += removing[key].length;
    }

    return removedCount;
}

