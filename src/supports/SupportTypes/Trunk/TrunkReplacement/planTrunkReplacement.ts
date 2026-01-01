import type { Brace, Branch, Knot, Leaf, SupportState, Trunk } from '../../../types';
import type {
    PlanTrunkReplacementArgs,
    TrunkReplacementCandidate,
    TrunkReplacementPlan,
    TrunkReplacementPlannerResult,
} from './types';

function getBranchContactZ(branch: Branch): number {
    return branch.contactCone?.pos.z ?? Number.NEGATIVE_INFINITY;
}

function collectConnectedToTrunk(snapshot: SupportState, trunk: Trunk): {
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

function selectHighestContactBranch(snapshot: SupportState, branchIds: Set<string>): TrunkReplacementCandidate | null {
    let best: TrunkReplacementCandidate | null = null;

    for (const id of Array.from(branchIds)) {
        const branch = snapshot.branches[id];
        if (!branch) continue;

        const z = getBranchContactZ(branch);
        if (!Number.isFinite(z)) continue;

        if (!best) {
            best = { kind: 'branch', branchId: id, contactZ: z };
            continue;
        }

        const dz = z - best.contactZ;
        if (dz > 0.000001) {
            best = { kind: 'branch', branchId: id, contactZ: z };
            continue;
        }

        if (Math.abs(dz) <= 0.000001 && id < best.branchId) {
            best = { kind: 'branch', branchId: id, contactZ: z };
        }
    }

    return best;
}

export function planTrunkReplacement(args: PlanTrunkReplacementArgs): TrunkReplacementPlannerResult | null {
    const { snapshot, trunkIdToRemove, mode, nodeKey, promoteBranchId } = args;

    const trunk = snapshot.trunks[trunkIdToRemove];
    if (!trunk) return null;

    const root = snapshot.roots[trunk.rootId] ?? null;

    const connected = collectConnectedToTrunk(snapshot, trunk);

    const directChildBranchIds: string[] = [];
    for (const b of Object.values(snapshot.branches)) {
        if (b.parentKnotId && connected.trunkHostedKnotIds.has(b.parentKnotId)) {
            directChildBranchIds.push(b.id);
        }
    }

    let candidate: TrunkReplacementCandidate | null = null;

    if (mode === 'grid_promote_candidate_to_trunk') {
        if (!promoteBranchId) return null;
        const branch = snapshot.branches[promoteBranchId];
        if (!branch) return null;
        candidate = {
            kind: 'branch',
            branchId: promoteBranchId,
            contactZ: getBranchContactZ(branch),
        };
    } else {
        if (mode === 'delete_trunk_promote_next_highest') {
            candidate = selectHighestContactBranch(snapshot, new Set(directChildBranchIds));
        } else {
            candidate = selectHighestContactBranch(snapshot, connected.connectedBranchIds);
        }
    }

    let plan: TrunkReplacementPlan | null = null;
    if (candidate?.kind === 'branch') {
        const trunkHostedKnotIds = Array.from(connected.trunkHostedKnotIds).sort();

        const connectedBranchIds = Array.from(connected.connectedBranchIds).sort();
        const connectedLeafIds = Array.from(connected.connectedLeafIds).sort();
        const connectedBraceIds = Array.from(connected.connectedBraceIds).sort();
        const connectedKnotIds = Array.from(connected.connectedKnotIds).sort();

        const branchesToRehost = directChildBranchIds
            .filter((id) => id !== candidate.branchId)
            .sort();

        const leavesToRehost: string[] = [];
        for (const leaf of Object.values(snapshot.leaves)) {
            if (leaf.parentKnotId && connected.trunkHostedKnotIds.has(leaf.parentKnotId)) {
                leavesToRehost.push(leaf.id);
            }
        }
        leavesToRehost.sort();

        const bracesToRemove: string[] = [];
        for (const brace of Object.values(snapshot.braces)) {
            if (
                (brace.startKnotId && connected.trunkHostedKnotIds.has(brace.startKnotId)) ||
                (brace.endKnotId && connected.trunkHostedKnotIds.has(brace.endKnotId))
            ) {
                bracesToRemove.push(brace.id);
            }
        }
        bracesToRemove.sort();

        plan = {
            meta: {
                mode,
                modelId: trunk.modelId,
                nodeKey,
            },
            trunkToRemoveId: trunkIdToRemove,
            candidate,
            trunkRemovedSnapshot: trunk,
            rootRemovedSnapshot: root,
            trunkHostedKnotIds,
            connectedBranchIds,
            connectedLeafIds,
            connectedBraceIds,
            connectedKnotIds,
            knotsToRemove: trunkHostedKnotIds,
            branchesToRehost,
            leavesToRehost,
            bracesToRemove,
        };
    }

    const branches: Branch[] = Array.from(connected.connectedBranchIds)
        .map((id) => snapshot.branches[id])
        .filter(Boolean);

    const leaves: Leaf[] = Array.from(connected.connectedLeafIds)
        .map((id) => snapshot.leaves[id])
        .filter(Boolean);

    const braces: Brace[] = Array.from(connected.connectedBraceIds)
        .map((id) => snapshot.braces[id])
        .filter(Boolean);

    const knots: Knot[] = Array.from(connected.connectedKnotIds)
        .map((id) => snapshot.knots[id])
        .filter(Boolean);

    const result: TrunkReplacementPlannerResult = {
        meta: {
            mode,
            modelId: trunk.modelId,
            nodeKey,
        },
        trunkToRemoveId: trunkIdToRemove,
        trunkRemovedSnapshot: trunk,
        rootRemovedSnapshot: root,
        connectedBranches: branches,
        connectedLeaves: leaves,
        connectedBraces: braces,
        connectedKnots: knots,
        trunkHostedKnotIds: Array.from(connected.trunkHostedKnotIds),
        candidate,
        plan,
    };

    return result;
}
