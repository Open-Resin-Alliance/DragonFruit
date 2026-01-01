import type { Brace, Branch, Knot, Leaf, Roots, SupportState, Trunk } from '../../../types';

export type TrunkReplacementMode =
    | 'grid_promote_candidate_to_trunk'
    | 'delete_trunk_promote_next_highest';

export interface TrunkReplacementPlanMeta {
    mode: TrunkReplacementMode;
    modelId: string;
    nodeKey?: string;
}

export interface TrunkReplacementPlan {
    meta: TrunkReplacementPlanMeta;

    trunkToRemoveId: string;

    candidate: TrunkReplacementCandidate;

    trunkRemovedSnapshot: Trunk;
    rootRemovedSnapshot: Roots | null;

    trunkHostedKnotIds: string[];

    connectedBranchIds: string[];
    connectedLeafIds: string[];
    connectedBraceIds: string[];
    connectedKnotIds: string[];

    knotsToRemove: string[];

    branchesToRehost: string[];
    leavesToRehost: string[];

    bracesToRemove: string[];

    trunkToAdd?: Trunk;
    rootToAdd?: Roots;

    branchesToAdd?: Branch[];
    leavesToAdd?: Leaf[];
    bracesToAdd?: Brace[];
    knotsToAdd?: Knot[];
}

export type TrunkReplacementCandidate =
    | {
        kind: 'branch';
        branchId: string;
        contactZ: number;
    };

export interface TrunkReplacementPlannerResult {
    meta: TrunkReplacementPlanMeta;
    trunkToRemoveId: string;
    trunkRemovedSnapshot: Trunk;
    rootRemovedSnapshot: Roots | null;
    connectedBranches: Branch[];
    connectedLeaves: Leaf[];
    connectedBraces: Brace[];
    connectedKnots: Knot[];
    trunkHostedKnotIds: string[];
    candidate: TrunkReplacementCandidate | null;
    plan: TrunkReplacementPlan | null;
}

export interface PlanTrunkReplacementArgs {
    snapshot: SupportState;
    trunkIdToRemove: string;
    mode: TrunkReplacementMode;
    nodeKey?: string;
    promoteBranchId?: string;
}
