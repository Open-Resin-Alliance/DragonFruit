import type { SupportState, Vec3 } from '../../types';
import type { SupportData } from '../../rendering/SupportBuilder';
import type { SupportSettings } from '../../Settings/types';
import type { TrunkBuildResult } from '../../SupportTypes/Trunk/trunkBuilder';
import type { PlacedSupport } from '../../supportTypeRegistry';
import type * as THREE from 'three';

export type GridNodeKey = string;

export type GridPlacementRejectReason =
    | 'KNOT_ABOVE_TIP'
    | 'STUMP_BELOW_ROOT'
    | 'NO_HOST_SEGMENT'
    | 'MODEL_MISMATCH'
    | 'NO_VALID_ATTACHMENT'
    | 'COLLISION_WITH_MODEL';

export type GridPlacementDecision =
    | {
        /** A support is placed on this contact, in the registry's generic shape. */
        kind: 'place';
        /** The grid node it landed on, for logging. Empty when the build never
         * consults the grid (a type's own override). */
        nodeKey: GridNodeKey;
        placed: PlacedSupport;
        /** Preview and validation state, whatever built the support. */
        supportData?: SupportData;
    }
    | {
        kind: 'reject';
        nodeKey: GridNodeKey;
        reason: GridPlacementRejectReason;
        trunkBuild?: TrunkBuildResult;
        /** Optional ghost preview for rejections that already built geometry
         * (e.g. anchors). Carries the reject reason as `error` so the hover
         * tooltip renders. */
        supportData?: SupportData;
    };

export interface DecideGridPlacementArgs {
    settings: SupportSettings;
    snapshot: SupportState;
    candidate: TrunkBuildResult;
    tipPos: Vec3;
    tipNormal: Vec3;
    modelId: string;
    mesh?: THREE.Mesh;
    /** When true, skip expensive click-time-only checks (e.g. full segment raycasts). */
    isPreview?: boolean;
}
