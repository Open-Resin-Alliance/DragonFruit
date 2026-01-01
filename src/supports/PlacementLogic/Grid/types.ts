import type { Branch, Knot, SupportState, Vec3 } from '../../types';
import type { SupportData } from '../../rendering/SupportBuilder';
import type { SupportSettings } from '../../Settings/types';
import type { TrunkBuildResult } from '../../SupportTypes/Trunk/trunkBuilder';
import type * as THREE from 'three';

export type GridNodeKey = string;

export type GridPlacementRejectReason =
    | 'KNOT_ABOVE_TIP'
    | 'NO_HOST_SEGMENT'
    | 'MODEL_MISMATCH'
    | 'NO_VALID_ATTACHMENT'
    | 'COLLISION_WITH_MODEL';

export type GridPlacementDecision =
    | {
        kind: 'place_trunk';
        trunkBuild: TrunkBuildResult;
        nodeKey: GridNodeKey;
    }
    | {
        kind: 'replace_trunk';
        nodeKey: GridNodeKey;
        hostTrunkId: string;
        trunkBuild: TrunkBuildResult;
        promoteKnot: Knot;
        promoteBranch: Branch;
        oldTrunkKnot: Knot | null;
        oldTrunkBranch: Branch | null;
    }
    | {
        kind: 'place_branch';
        nodeKey: GridNodeKey;
        hostTrunkId: string;
        knot: Knot;
        branch: Branch;
        supportData: SupportData;
    }
    | {
        kind: 'reject';
        nodeKey: GridNodeKey;
        reason: GridPlacementRejectReason;
    };

export interface DecideGridPlacementArgs {
    settings: SupportSettings;
    snapshot: SupportState;
    candidate: TrunkBuildResult;
    tipPos: Vec3;
    tipNormal: Vec3;
    modelId: string;
    mesh?: THREE.Mesh;
}
