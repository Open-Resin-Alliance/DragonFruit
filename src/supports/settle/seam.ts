import type { SupportState } from '../types';
import type { SupportTypeId } from '../supportTypeRegistry';

/**
 * Where a type registers what it recomputes after its own entity is written,
 * beyond the knots `applySupportEntityUpdate` already repositions. The cascades
 * that need a particular order register here.
 */
export interface SupportSettleContext {
    /** This type's collection already replaced; every other one as it was. */
    next: SupportState;
}

/** The collections to write on top of the entity's own, or null for none. */
export type SupportSettleHook = (context: SupportSettleContext) => Partial<SupportState> | null;

const SETTLE_HOOKS = new Map<SupportTypeId, SupportSettleHook>();

/** Called from a type's own folder when its cascade differs from the generic one. */
export function registerSupportSettle(typeId: SupportTypeId, hook: SupportSettleHook): void {
    SETTLE_HOOKS.set(typeId, hook);
}

/** This type's settle hook, or null when its folder registered none. */
export function supportSettleFor(typeId: SupportTypeId): SupportSettleHook | null {
    return SETTLE_HOOKS.get(typeId) ?? null;
}

/** Types whose folder registered a settle hook, for the completeness test. */
export function typesWithSettleHook(): readonly SupportTypeId[] {
    return [...SETTLE_HOOKS.keys()];
}
