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
 * A draft the run owns outright is marked by `createOwnedDraft`. Its
 * collections are copied once, on their first write, and mutated in place
 * afterwards: copying a 600-entry collection for every placement was two
 * thirds of an auto-support run's time, and the copies bought nothing because
 * the run is the only holder of the draft.
 */

const OWNED_DRAFT = Symbol('dragonfruitOwnedSupportDraft');

/** Collections this draft may mutate directly; they are its own copies. */
type OwnedCollections = Set<string>;

/**
 * A draft the plan owns outright, safe to mutate in place.
 *
 * The spread reads the source's collection views once, so the new state has
 * its own top level; each collection is still the source's object until the
 * first write copies it. Never hand the source to anything else afterwards.
 */
export function createOwnedDraft(source: SupportState): SupportState {
    const draft = { ...source } as SupportState;
    Object.defineProperty(draft, OWNED_DRAFT, {
        value: new Set<string>() as OwnedCollections,
        enumerable: false,
        configurable: true,
    });
    return draft;
}

/**
 * The draft's own object for `key`, copied the first time it is written.
 * Returns null for an immutable draft, whose callers fall back to spreading.
 */
function writableCollection(draft: SupportState, key: string): Record<string, unknown> | null {
    const owned = (draft as SupportState & { [OWNED_DRAFT]?: OwnedCollections })[OWNED_DRAFT];
    if (!owned) return null;
    if (owned.has(key)) return (draft as unknown as Record<string, Record<string, unknown>>)[key];
    const copy = { ...((draft as unknown as Record<string, Record<string, unknown> | undefined>)[key] ?? {}) };
    Object.defineProperty(draft, key, { configurable: true, enumerable: true, value: copy, writable: true });
    owned.add(key);
    return copy;
}

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
    const collection = writableCollection(draft, key);
    if (!collection) return { ...draft, [key]: { ...draft[key], [entity.id]: { ...entity, typeId } } };
    collection[entity.id] = { ...entity, typeId };
    return draft;
}

/** Primitives are not support types and carry no `typeId`. */
export function draftAddPrimitive<K extends 'roots' | 'knots'>(
    draft: SupportState,
    key: K,
    primitive: { id: string },
): SupportState {
    const collection = writableCollection(draft, key);
    if (!collection) return { ...draft, [key]: { ...draft[key], [primitive.id]: primitive } };
    collection[primitive.id] = primitive;
    return draft;
}

/**
 * Remove one entity from a draft. The owned path mutates; an immutable draft
 * gets the same copy-on-write its adders do.
 */
export function draftRemoveEntity(
    draft: SupportState,
    typeId: SupportTypeId,
    id: string,
): SupportState {
    const key = getSupportTypeDescriptor(typeId).location.key;
    const collection = writableCollection(draft, key);
    if (collection) {
        delete collection[id];
        return draft;
    }
    const copy = { ...(draft[key] as unknown as Record<string, unknown>) };
    delete copy[id];
    return { ...draft, [key]: copy };
}

/** Remove one root or knot from a draft. */
export function draftRemovePrimitive<K extends 'roots' | 'knots'>(
    draft: SupportState,
    key: K,
    id: string,
): SupportState {
    const collection = writableCollection(draft, key);
    if (collection) {
        delete collection[id];
        return draft;
    }
    const copy = { ...draft[key] };
    delete (copy as Record<string, unknown>)[id];
    return { ...draft, [key]: copy };
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
