import {
    SUPPORT_GRAPH_NODES,
    SUPPORT_TYPES,
    SUPPORT_COLLECTION_KEYS,
    getSupportTypeDescriptor,
    type SupportCollectionKey,
    type SupportEndpointKind,
    type SupportTypeId,
} from './supportTypeRegistry';
import { collectCascade, groupByCollection } from './supportCascade';
import { modelIdOfParentShaft } from './PlacementLogic/SupportModelLinker';
import type { SupportState } from './types';

/**
 * What the debug overlay knows about one support.
 *
 * Everything here is read off the registry rather than named per type: which
 * collection an entity lives in, which fields point at other entities, and
 * what would go with it if it were removed. A ninth type is described by
 * declaring it.
 */

type InspectorState = Pick<SupportState, SupportCollectionKey>;

/** One edge out of an entity, resolved to what it points at. */
export interface SupportLink {
    /** The declared field holding the id. */
    field: string;
    /** Which collection the target lives in, or `segment` for a shaft link. */
    to: string;
    /** `owns` means it goes when this does; `hostedBy` means this hangs off it. */
    ownership: string;
    id: string;
    /** False when the id points at nothing -- a dangling reference. */
    resolved: boolean;
}

export interface SupportInspection {
    id: string;
    typeId: SupportTypeId;
    /** The type's display name, e.g. "Trunk". */
    label: string;
    collection: SupportCollectionKey;
    modelId?: string;
    /** Segment count, for a type with a shaft. */
    segmentCount: number;
    /** Where the entity's contacts sit, by declared field. */
    contacts: { field: string; kind: SupportEndpointKind; present: boolean }[];
    /** What this entity points at. */
    links: SupportLink[];
    /** What points at this entity, by collection. */
    dependents: { collection: SupportCollectionKey; id: string }[];
    /** Everything removing this would take, excluding the entity itself. */
    cascadeCount: number;
    /** Any declared field whose id resolves to nothing. */
    danglingLinks: SupportLink[];
}

/** Which collection an id lives in, or null when it is not a support. */
export function collectionOfEntity(
    state: InspectorState,
    id: string,
): SupportCollectionKey | null {
    for (const key of SUPPORT_COLLECTION_KEYS) {
        const record = state[key] as unknown as Record<string, unknown> | undefined;
        if (record?.[id]) return key;
    }
    return null;
}

/** The declared links out of one entity, resolved against the state. */
function linksOf(state: InspectorState, collection: SupportCollectionKey, id: string): SupportLink[] {
    const node = SUPPORT_GRAPH_NODES.find((n) => n.key === collection);
    const entity = (state[collection] as unknown as Record<string, unknown>)[id] as
        Record<string, unknown> | undefined;
    if (!node || !entity) return [];

    const links: SupportLink[] = [];
    for (const edge of node.edges) {
        const value = entity[edge.field];
        if (typeof value !== 'string' || !value) continue;

        // A `segment` edge names a segment, which no collection is keyed by;
        // it resolves through the shaft that owns it.
        const resolved = edge.to === 'segment'
            ? modelIdOfParentShaft(state as InspectorState, value) !== null
            : !!(state[edge.to as SupportCollectionKey] as unknown as Record<string, unknown> | undefined)?.[value];

        links.push({ field: edge.field, to: edge.to, ownership: edge.ownership, id: value, resolved });
    }
    return links;
}

/** Everything whose declared edges point at this entity. */
function dependentsOf(
    state: InspectorState,
    collection: SupportCollectionKey,
    id: string,
): { collection: SupportCollectionKey; id: string }[] {
    const found: { collection: SupportCollectionKey; id: string }[] = [];

    // A knot names a segment rather than the shaft, so the shaft's own segment
    // ids stand in for it.
    const ownSegmentIds = new Set(
        ((state[collection] as unknown as Record<string, { segments?: { id: string }[] }>)[id]?.segments ?? [])
            .map((segment) => segment.id),
    );

    for (const node of SUPPORT_GRAPH_NODES) {
        const record = state[node.key] as unknown as Record<string, Record<string, unknown>> | undefined;
        if (!record) continue;

        for (const [otherId, entity] of Object.entries(record)) {
            if (otherId === id) continue;
            for (const edge of node.edges) {
                const value = entity[edge.field];
                if (typeof value !== 'string') continue;
                if (value === id || (edge.to === 'segment' && ownSegmentIds.has(value))) {
                    found.push({ collection: node.key, id: otherId });
                    break;
                }
            }
        }
    }
    return found;
}

/**
 * The support an id belongs to. A pick can land on a joint or a segment,
 * neither of which is keyed by a collection, so both resolve to their owner.
 */
export function ownerOfPickedId(
    state: InspectorState,
    id: string,
): { id: string; via: 'entity' | 'segment' | 'joint' } | null {
    if (collectionOfEntity(state, id)) return { id, via: 'entity' };

    for (const descriptor of SUPPORT_TYPES) {
        if (!descriptor.hasSegments) continue;
        const record = state[descriptor.location.key as SupportCollectionKey] as unknown as
            Record<string, { id: string; segments?: {
                id: string;
                topJoint?: { id: string } | null;
                bottomJoint?: { id: string } | null;
            }[] }>;
        if (!record) continue;

        for (const entity of Object.values(record)) {
            for (const segment of entity.segments ?? []) {
                if (segment.id === id) return { id: entity.id, via: 'segment' };
                if (segment.topJoint?.id === id || segment.bottomJoint?.id === id) {
                    return { id: entity.id, via: 'joint' };
                }
            }
        }
    }
    return null;
}

/** Everything the overlay can say about one support, or null if unknown. */
export function inspectSupport(state: InspectorState, id: string): SupportInspection | null {
    const collection = collectionOfEntity(state, id);
    if (!collection) return null;

    const descriptor = SUPPORT_TYPES.find((d) => d.location.key === collection);
    const entity = (state[collection] as unknown as Record<string, Record<string, unknown>>)[id];

    // A primitive (root, knot) has a collection but no type descriptor.
    if (!descriptor) {
        return {
            id,
            typeId: collection as unknown as SupportTypeId,
            label: collection,
            collection,
            modelId: entity.modelId as string | undefined,
            segmentCount: 0,
            contacts: [],
            links: linksOf(state, collection, id),
            dependents: dependentsOf(state, collection, id),
            cascadeCount: Math.max(0, collectCascade(state, [{ collection, id }]).size - 1),
            danglingLinks: linksOf(state, collection, id).filter((link) => !link.resolved),
        };
    }

    const links = linksOf(state, collection, id);
    const contacts = (['lower', 'upper'] as const)
        .map((end) => {
            const endpoint = descriptor[end];
            return endpoint.field
                ? { field: endpoint.field, kind: endpoint.kind, present: !!entity[endpoint.field] }
                : null;
        })
        .filter((contact): contact is { field: string; kind: SupportEndpointKind; present: boolean } => !!contact);

    return {
        id,
        typeId: descriptor.id,
        label: getSupportTypeDescriptor(descriptor.id).singular,
        collection,
        modelId: entity.modelId as string | undefined,
        segmentCount: ((entity.segments as unknown[] | undefined) ?? []).length,
        contacts,
        links,
        dependents: dependentsOf(state, collection, id),
        cascadeCount: Math.max(0, collectCascade(state, [{ collection, id }]).size - 1),
        danglingLinks: links.filter((link) => !link.resolved),
    };
}

/**
 * The selected support and everything connected to it, as JSON.
 *
 * The set is the cascade -- what removing this support would take -- so the
 * dump is exactly the group that stands or falls together. Entities are
 * emitted whole rather than summarised: the point is to paste the real data
 * into a bug report.
 */
export function dumpSupportGroup(state: InspectorState, id: string): string | null {
    const collection = collectionOfEntity(state, id);
    if (!collection) return null;

    const grouped = groupByCollection(collectCascade(state, [{ collection, id }]));
    const entities: Record<string, Record<string, unknown>> = {};
    let total = 0;

    for (const [key, ids] of grouped) {
        const record = state[key] as unknown as Record<string, unknown> | undefined;
        if (!record) continue;

        const bucket: Record<string, unknown> = {};
        for (const entityId of [...ids].sort()) {
            if (!(entityId in record)) continue;
            bucket[entityId] = record[entityId];
            total += 1;
        }
        if (Object.keys(bucket).length > 0) entities[key] = bucket;
    }

    return JSON.stringify({
        capturedAt: new Date().toISOString(),
        root: { id, collection },
        inspection: inspectSupport(state, id),
        entityCount: total,
        entities,
    }, null, 2);
}
