/**
 * Update Branch Joints on Parent Movement
 * 
 * When a parent support's joints are moved, all branch joints locked to that support
 * need to be re-projected onto the new shaft geometry to maintain connection.
 */

import { SupportInstance, Vec3 } from '@/supports_legacy/types';
import { constrainBranchJointToShaft } from './branchJointConstraint';

/**
 * Finds all branch supports attached to a parent support and updates their branch joints
 * to remain locked to the parent's shaft after the parent has been modified.
 * RECURSIVE: Also updates children of children, etc.
 * 
 * @param parentSupportId - ID of the parent support that was modified
 * @param allSupports - All supports in the scene
 * @param visited - Set of support IDs already processed (to prevent infinite loops)
 * @returns Array of updates to apply: { supportId, jointId, newPosition }
 */
export function updateBranchJointsForParent(
  parentSupportId: string,
  allSupports: SupportInstance[],
  visited: Set<string> = new Set()
): Array<{ supportId: string; jointId: string; newPosition: Vec3 }> {
  const updates: Array<{ supportId: string; jointId: string; newPosition: Vec3 }> = [];
  
  // Prevent infinite loops
  if (visited.has(parentSupportId)) {
    return updates;
  }
  visited.add(parentSupportId);
  
  // Find the parent support
  const parentSupport = allSupports.find(s => s.id === parentSupportId);
  if (!parentSupport) {
    return updates;
  }
  
  // Find all branch supports that reference this parent
  const branchSupports = allSupports.filter(s => s.parentBaseId === parentSupportId);
  
  for (const branchSupport of branchSupports) {
    // Find the branch or leaf joint (type === 'branch' or 'leaf' and locked to parent)
    const lockedJoint = branchSupport.joints?.find(
      j => ((j as any).type === 'branch' || (j as any).type === 'leaf') && (j as any).lockedToSupportId === parentSupportId
    );
    
    if (lockedJoint) {
      // Re-project the locked joint onto the parent's new shaft geometry
      const currentPosition = lockedJoint.position;
      const newPosition = constrainBranchJointToShaft(
        currentPosition,
        lockedJoint,
        parentSupport
      );
      
      // Only add update if position actually changed
      const dx = newPosition.x - currentPosition.x;
      const dy = newPosition.y - currentPosition.y;
      const dz = newPosition.z - currentPosition.z;
      const distanceMoved = Math.sqrt(dx * dx + dy * dy + dz * dz);
      
      if (distanceMoved > 0.001) { // 1 micron threshold
        updates.push({
          supportId: branchSupport.id,
          jointId: lockedJoint.id,
          newPosition,
        });
        
        // RECURSIVE: Update children of this branch support
        const childUpdates = updateBranchJointsForParent(branchSupport.id, allSupports, visited);
        updates.push(...childUpdates);
      }
    }
  }
  
  return updates;
}
