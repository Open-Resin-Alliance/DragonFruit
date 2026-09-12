import { getSupportTypeDescriptor, type SupportTypeId } from '../supportTypeRegistry';
import type { SupportState } from '../types';

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
