export type BranchPlacementStage = 'idle' | 'tipPlaced' | 'baseFollow' | 'snapped' | 'finalize';

export interface BranchPlacementState {
  stage: BranchPlacementStage;
  contact?: { x: number; y: number; z: number };
  contactNormal?: { x: number; y: number; z: number };
  snap?: { trunkId: string; position: { x: number; y: number; z: number } } | null;
}

export interface BranchOwnedJointFlags {
  ownerSupportId: string; // branch id
  isBranchBaseJoint: boolean; // true for the joint created at base snap
}
