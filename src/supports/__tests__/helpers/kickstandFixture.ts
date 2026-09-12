import { getSnapshot, setSnapshot } from '../../state';
import type { Knot, Roots, SupportState } from '../../types';
import type { Kickstand } from '../../SupportTypes/Kickstand/types';

/**
 * The shape kickstand fixtures were written against, back when a per-type
 * store existed. Kickstands, their roots and their knots all live on
 * `SupportState`; these helpers keep the fixtures readable without a shim.
 */
export interface KickstandFixture {
    kickstands: Record<string, Kickstand>;
    roots: Record<string, Roots>;
    knots: Record<string, Knot>;
    selectedId: string | null;
}

/**
 * Write a kickstand fixture into the store. Roots and knots MERGE into the
 * shared collections rather than replacing them -- replacing would drop every
 * other type's.
 */
export function seedKickstands(fixture: Omit<KickstandFixture, 'selectedId'> & { selectedId?: string | null }): void {
    const state = getSnapshot();
    setSnapshot({
        ...state,
        kickstands: fixture.kickstands,
        roots: { ...state.roots, ...fixture.roots },
        knots: { ...state.knots, ...fixture.knots },
        ...(fixture.selectedId !== undefined ? { selectedId: fixture.selectedId } : {}),
    } as SupportState);
}

/** The kickstands in the store, with the roots and knots they claim. */
export function readKickstands(): KickstandFixture {
    const state = getSnapshot();
    const roots: Record<string, Roots> = {};
    const knots: Record<string, Knot> = {};

    for (const kickstand of Object.values(state.kickstands)) {
        const root = state.roots[kickstand.rootId];
        if (root) roots[root.id] = root;
        const hostKnot = state.knots[kickstand.hostKnotId];
        if (hostKnot) knots[hostKnot.id] = hostKnot;
    }

    return { kickstands: state.kickstands, roots, knots, selectedId: state.selectedId };
}
