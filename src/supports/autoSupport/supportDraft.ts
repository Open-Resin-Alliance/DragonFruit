import { getSupportTypeDescriptor, type PlacementPrimitives, type SupportEntityFor, type SupportTypeId } from '../supportTypeRegistry';
import type { Knot, Roots, SupportState } from '../types';

/**
 * Immutable draft mutations for the auto-support PLAN phase.
 *
 * The auto pipeline must compute the whole placement against a LOCAL draft
 * state (no store commits, no notify()) so the run is one atomic commit and
 * the computation can later move into a worker. These mirror the entity-add
 * arm of the store's `addSupportEntity` (state.ts), minus the settings-code-hex
 * cache and the `notify()` side effects.
 *
 * The placement phase only ever ADDS entities (the one replacement case uses
 * `applyTrunkReplacement` via a store swap), so these two cover every mutation
 * the plan phase needs.
 */

/**
 * Add one support entity to a draft, stamped with its type.
 *
 * The plan phase commits with a single `setSnapshot`, so an entity entering
 * the draft unstamped reaches the store unstamped.
 */
export function draftAddEntity(
    draft: SupportState,
    typeId: SupportTypeId,
    entity: { id: string },
): SupportState {
    const key = getSupportTypeDescriptor(typeId).location.key;
    return {
        ...draft,
        [key]: { ...draft[key], [entity.id]: { ...entity, typeId } },
    };
}

/** Primitives are not support types and carry no `typeId`. */
export function draftAddPrimitive<K extends 'roots' | 'knots'>(
    draft: SupportState,
    key: K,
    primitive: { id: string },
): SupportState {
    return { ...draft, [key]: { ...draft[key], [primitive.id]: primitive } };
}

/**
 * Commit one placed support: the entity plus every primitive its declared
 * `edges` point at.
 *
 * `location.key` is the collection the entity joins, and each `edges` entry
 * names a field holding a primitive's id and the collection it lives in.
 * `supplied` is keyed by edge field, matching the declaration.
 */
export function draftCommitSupport(
    draft: SupportState,
    typeId: SupportTypeId,
    entity: SupportEntityFor<typeof typeId>,
    supplied: PlacementPrimitives = {},
): SupportState {
    let next = draftAddEntity(draft, typeId, entity);
    for (const edge of getSupportTypeDescriptor(typeId).edges) {
        // A `segment` edge names part of the entity, not a collection member.
        // Only roots and knots are collections a placement can carry in.
        if (edge.to !== 'roots' && edge.to !== 'knots') continue;
        const primitive = supplied[edge.field];
        if (!primitive) continue;
        // The declared edge says which collection this belongs to. The cast is
        // unavoidable: a value keyed by edge field cannot carry its collection.
        if (edge.to === 'roots') next = draftAddPrimitive(next, 'roots', primitive as Roots);
        else next = draftAddPrimitive(next, 'knots', primitive as Knot);
    }
    return next;
}
