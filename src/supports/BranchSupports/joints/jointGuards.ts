// Guard utilities to ensure branch-owned joints never modify trunk geometry
export function isBranchOwnedJoint(j: { isBranchBaseJoint?: boolean; ownerSupportId?: string }): boolean {
  return !!j && j.isBranchBaseJoint === true && typeof j.ownerSupportId === 'string';
}
