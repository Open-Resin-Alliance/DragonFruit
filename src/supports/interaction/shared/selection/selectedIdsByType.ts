import {
    getSupportTypeDescriptor,
    parsePrefixedSegmentId,
    SUPPORT_TYPES,
    type SupportTypeDescriptor,
    type SupportTypeId,
} from '../../../supportTypeRegistry';
import type { ResolvedSelectionState } from './selectionTypes';

/**
 * Which entities of each type the current selection covers.
 *
 * Eight memos differing only in the collection they read and which extras they
 * add. Every difference is declared: the collection by `location.key`, the knot
 * fan-out by the `hostedBy knots` edges, the segment prefix by
 * `segmentSelectionPrefix`.
 */

/**
 * `ResolvedSelectionState` narrowed to what this derivation needs: ids as a
 * set, and the detail threshold already applied.
 */
export interface SelectionInputs {
    selectedSupportIdSet: ReadonlySet<string>;
    /** The lone support a selection resolves to, primitives included. */
    singleSelectedSupportId: string | null;
    /** Whether a multi-selection is small enough to resolve per entity. */
    useMultiSelectionDetail: boolean;
    selectedCategory: ResolvedSelectionState['selectedCategory'];
    selectedId: ResolvedSelectionState['selectedId'];
}

/** Reads a collection by key; the caller decides which store answers. */
export type CollectionLookup = (key: string) => Record<string, unknown> | undefined;

/** Entity ids hanging off a knot, per type. */
export type KnotIndex = ReadonlyMap<SupportTypeId, ReadonlyMap<string, readonly string[]>>;

/** The `hostedBy knots` fields a type hangs from, in declared order. */
export function knotFields(descriptor: SupportTypeDescriptor): readonly string[] {
    return descriptor.edges
        .filter((edge) => edge.to === 'knots' && edge.ownership === 'hostedBy')
        .map((edge) => edge.field);
}

/**
 * Entities indexed by every knot they hang from.
 *
 * A brace lands under both its end knots because it declares two knot edges,
 * not because braces are special-cased.
 */
export function buildKnotIndex(collections: CollectionLookup): KnotIndex {
    const index = new Map<SupportTypeId, Map<string, string[]>>();

    for (const descriptor of SUPPORT_TYPES) {
        const fields = knotFields(descriptor);
        if (fields.length === 0) continue;

        const byKnot = new Map<string, string[]>();
        for (const entity of Object.values(collections(descriptor.location.key) ?? {})) {
            const record = entity as Record<string, unknown>;
            const id = record.id as string;
            for (const field of fields) {
                const knotId = record[field];
                if (typeof knotId !== 'string') continue;
                const list = byKnot.get(knotId);
                if (list) list.push(id);
                else byKnot.set(knotId, [id]);
            }
        }
        index.set(descriptor.id, byKnot);
    }

    return index;
}

/** Selected ids of one type: multi-selection, single selection, then extras. */
export function selectedIdsForType(
    typeId: SupportTypeId,
    selection: SelectionInputs,
    collections: CollectionLookup,
    knotIndex: KnotIndex,
): Set<string> {
    const descriptor = getSupportTypeDescriptor(typeId);
    const selected = new Set<string>();
    const entities = collections(descriptor.location.key) ?? {};

    if (selection.useMultiSelectionDetail) {
        for (const supportId of selection.selectedSupportIdSet) {
            if (entities[supportId]) selected.add(supportId);
        }
    }

    const single = selection.singleSelectedSupportId;
    if (single && entities[single]) selected.add(single);

    // Selecting a knot selects what hangs from it.
    if (selection.selectedCategory === 'knot' && selection.selectedId) {
        for (const id of knotIndex.get(descriptor.id)?.get(selection.selectedId) ?? []) {
            selected.add(id);
        }
    }

    // A type whose segments are selected under a prefix resolves back to itself.
    if (selection.selectedCategory === 'segment' && selection.selectedId) {
        const prefixed = parsePrefixedSegmentId(selection.selectedId);
        if (prefixed?.typeId === descriptor.id) selected.add(prefixed.entityId);
    }

    return selected;
}
