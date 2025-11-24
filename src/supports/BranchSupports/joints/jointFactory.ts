import type { BranchOwnedJointFlags } from '../types';

export function createBranchOwnedJoint(params: { ownerSupportId: string; position: { x: number; y: number; z: number }; ballDiameterMm: number; order: number; }): BranchOwnedJointFlags & { id: string; position: { x: number; y: number; z: number }; ballDiameterMm: number; order: number; } {
  return {
    id: `bj-${Math.random().toString(36).slice(2, 9)}`,
    position: params.position,
    ballDiameterMm: params.ballDiameterMm,
    order: params.order,
    ownerSupportId: params.ownerSupportId,
    isBranchBaseJoint: true,
  };
}
