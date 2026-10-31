import type { Segment, SupportState } from '../types';
import { MODEL_ID_COLLECTION_KEYS, SUPPORT_TYPES, type SupportCollectionKey } from '../supportTypeRegistry';

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


