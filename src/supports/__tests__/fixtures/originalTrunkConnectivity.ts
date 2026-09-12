/**
 * The pre-worklist `collectConnectedToTrunk`, verbatim, so the replacement can
 * be compared against it. It grew the branch tree with a `while (grew)`
 * fixpoint that rescanned every knot per branch per round.
 */

import type { SupportState, Trunk } from '../../types';

export function originalCollectConnectedToTrunk(snapshot: SupportState, trunk: Trunk): {
    trunkHostedKnotIds: Set<string>;
    connectedBranchIds: Set<string>;
    connectedLeafIds: Set<string>;
    connectedBraceIds: Set<string>;
    connectedKnotIds: Set<string>;
} {
    const trunkSegmentIds = new Set(trunk.segments.map((s) => s.id));

    const trunkHostedKnotIds = new Set<string>();
    for (const knot of Object.values(snapshot.knots)) {
        if (trunkSegmentIds.has(knot.parentShaftId)) trunkHostedKnotIds.add(knot.id);
    }

    const branchIds = new Set<string>();
    const knotIds = new Set<string>(Array.from(trunkHostedKnotIds));

    for (const b of Object.values(snapshot.branches)) {
        if (b.parentKnotId && trunkHostedKnotIds.has(b.parentKnotId)) {
            branchIds.add(b.id);
        }
    }

    // Grow the set to include the full downstream branch tree.
    let grew = true;
    while (grew) {
        grew = false;

        for (const bId of Array.from(branchIds)) {
            const b = snapshot.branches[bId];
            if (!b) continue;

            if (b.parentKnotId) {
                knotIds.add(b.parentKnotId);
            }

            for (const seg of b.segments) {
                for (const knot of Object.values(snapshot.knots)) {
                    if (knot.parentShaftId === seg.id) {
                        knotIds.add(knot.id);
                    }
                }
            }
        }

        for (const b of Object.values(snapshot.branches)) {
            if (branchIds.has(b.id)) continue;
            if (b.parentKnotId && knotIds.has(b.parentKnotId)) {
                branchIds.add(b.id);
                grew = true;
            }
        }
    }

    const leafIds = new Set<string>();
    for (const leaf of Object.values(snapshot.leaves)) {
        if (leaf.parentKnotId && knotIds.has(leaf.parentKnotId)) {
            leafIds.add(leaf.id);
        }
    }

    const braceIds = new Set<string>();
    for (const brace of Object.values(snapshot.braces)) {
        if ((brace.startKnotId && knotIds.has(brace.startKnotId)) || (brace.endKnotId && knotIds.has(brace.endKnotId))) {
            braceIds.add(brace.id);
        }
    }

    return {
        trunkHostedKnotIds,
        connectedBranchIds: branchIds,
        connectedLeafIds: leafIds,
        connectedBraceIds: braceIds,
        connectedKnotIds: knotIds,
    };
}

