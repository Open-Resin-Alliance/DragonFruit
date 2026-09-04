import type { SupportState, Roots, Trunk, Knot, Branch, Leaf, Anchor, Stick, Twig } from '../types';

/**
 * Immutable draft mutations for the auto-support PLAN phase.
 *
 * The auto pipeline must compute the whole placement against a LOCAL draft
 * state (no store commits, no notify()) so the run is one atomic commit and
 * the computation can later move into a worker. These mirror the entity-add
 * arms of the store's `addRoot`/`addTrunk`/… functions (state.ts), minus the
 * settings-code-hex cache and the `notify()` side effects.
 *
 * The placement phase only ever ADDS entities (the one replacement case uses
 * `applyTrunkReplacement` via a store swap), so these eight covers all
 * mutations the plan phase needs.
 */

export function draftAddRoot(draft: SupportState, root: Roots): SupportState {
    return { ...draft, roots: { ...draft.roots, [root.id]: root } };
}

export function draftAddTrunk(draft: SupportState, trunk: Trunk): SupportState {
    return { ...draft, trunks: { ...draft.trunks, [trunk.id]: trunk } };
}

export function draftAddKnot(draft: SupportState, knot: Knot): SupportState {
    return { ...draft, knots: { ...draft.knots, [knot.id]: knot } };
}

export function draftAddBranch(draft: SupportState, branch: Branch): SupportState {
    return { ...draft, branches: { ...draft.branches, [branch.id]: branch } };
}

export function draftAddLeaf(draft: SupportState, leaf: Leaf): SupportState {
    return { ...draft, leaves: { ...draft.leaves, [leaf.id]: leaf } };
}

export function draftAddAnchor(draft: SupportState, anchor: Anchor): SupportState {
    return { ...draft, anchors: { ...draft.anchors, [anchor.id]: anchor } };
}

export function draftAddStick(draft: SupportState, stick: Stick): SupportState {
    return { ...draft, sticks: { ...draft.sticks, [stick.id]: stick } };
}

export function draftAddTwig(draft: SupportState, twig: Twig): SupportState {
    return { ...draft, twigs: { ...draft.twigs, [twig.id]: twig } };
}
