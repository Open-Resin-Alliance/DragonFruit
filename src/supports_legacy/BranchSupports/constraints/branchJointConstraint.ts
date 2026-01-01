/**
 * Branch Joint Constraint
 * 
 * Constrains branch joint movement to slide only along the parent support's shaft.
 */

import * as THREE from 'three';
import { Vec3, SupportInstance } from '@/supports_legacy/types';
import { SupportJoint } from '@/supports_legacy/Joints/types';

/**
 * Projects a position onto the nearest point on a parent support's shaft.
 * Used to constrain branch joint movement to the parent shaft.
 * 
 * @param desiredPosition - The position the user is trying to move to
 * @param branchJoint - The branch joint being moved
 * @param parentSupport - The parent support the joint is locked to
 * @returns Constrained position on the parent shaft
 */
export function constrainBranchJointToShaft(
  desiredPosition: Vec3,
  branchJoint: SupportJoint,
  parentSupport: SupportInstance
): Vec3 {
  // Get parent support shaft endpoints
  const parentTip = parentSupport.tip;
  const parentBase = parentSupport.base;
  
  // Calculate parent shaft endpoints (accounting for tip cone and base)
  const tipLength = parentSupport.settings.tip.lengthMm;
  const baseHeight = parentSupport.settings.base.heightMm;
  
  // Tip normal direction
  const tipNormal = parentSupport.tipNormal;
  const tipDir = new THREE.Vector3(tipNormal.x, tipNormal.y, tipNormal.z).normalize();
  
  // Shaft starts at tip socket (end of tip cone)
  const shaftStart = new THREE.Vector3(
    parentTip.x + tipDir.x * tipLength,
    parentTip.y + tipDir.y * tipLength,
    parentTip.z + tipDir.z * tipLength
  );
  
  // Shaft end depends on parent type
  let shaftEnd: THREE.Vector3;
  const isBranchParent = !!parentSupport.parentBaseId;
  
  if (isBranchParent) {
    // For branch parents: shaft ends at their branch joint
    const parentBranchJoint = parentSupport.joints?.find(j => j.type === 'branch');
    if (parentBranchJoint) {
      shaftEnd = new THREE.Vector3(
        parentBranchJoint.position.x,
        parentBranchJoint.position.y,
        parentBranchJoint.position.z
      );
    } else {
      // Fallback: use base if no branch joint found
      shaftEnd = new THREE.Vector3(parentBase.x, parentBase.y, parentBase.z);
    }
  } else {
    // For trunk parents: shaft ends at top of base
    shaftEnd = new THREE.Vector3(
      parentBase.x,
      parentBase.y,
      parentBase.z + baseHeight
    );
  }
  
  // If parent has joints, we need to project onto the shaft segments
  const parentJoints = parentSupport.joints || [];
  
  if (parentJoints.length === 0) {
    // No joints: single segment from shaftStart to shaftEnd
    return projectPointOntoSegment(desiredPosition, shaftStart, shaftEnd);
  }
  
  // With joints: find the closest point across all segments
  const sortedJoints = [...parentJoints].sort((a, b) => a.order - b.order);
  
  // Build segment list: shaftStart -> joint0 -> joint1 -> ... -> shaftEnd
  const segments: Array<{ start: THREE.Vector3; end: THREE.Vector3 }> = [];
  
  // First segment: shaftStart to first joint
  segments.push({
    start: shaftStart,
    end: new THREE.Vector3(sortedJoints[0].position.x, sortedJoints[0].position.y, sortedJoints[0].position.z),
  });
  
  // Middle segments: between joints
  for (let i = 0; i < sortedJoints.length - 1; i++) {
    segments.push({
      start: new THREE.Vector3(sortedJoints[i].position.x, sortedJoints[i].position.y, sortedJoints[i].position.z),
      end: new THREE.Vector3(sortedJoints[i + 1].position.x, sortedJoints[i + 1].position.y, sortedJoints[i + 1].position.z),
    });
  }
  
  // Last segment: last joint to shaftEnd
  // BUT: if last joint is a branch joint, don't add this segment (shaft ends at branch joint)
  const lastJoint = sortedJoints[sortedJoints.length - 1];
  const lastJointIsBranch = lastJoint.type === 'branch';
  
  if (!lastJointIsBranch) {
    segments.push({
      start: new THREE.Vector3(
        sortedJoints[sortedJoints.length - 1].position.x,
        sortedJoints[sortedJoints.length - 1].position.y,
        sortedJoints[sortedJoints.length - 1].position.z
      ),
      end: shaftEnd,
    });
  }
  
  // Find closest point across all segments
  let closestPoint = shaftStart;
  let minDistance = Infinity;
  
  const desired = new THREE.Vector3(desiredPosition.x, desiredPosition.y, desiredPosition.z);
  
  for (const segment of segments) {
    const projected = projectPointOntoSegment(desiredPosition, segment.start, segment.end);
    const projectedVec = new THREE.Vector3(projected.x, projected.y, projected.z);
    const distance = desired.distanceTo(projectedVec);
    
    if (distance < minDistance) {
      minDistance = distance;
      closestPoint = projectedVec;
    }
  }
  
  return {
    x: closestPoint.x,
    y: closestPoint.y,
    z: closestPoint.z,
  };
}

/**
 * Projects a point onto a line segment, clamping to the segment endpoints.
 */
function projectPointOntoSegment(
  point: Vec3,
  segmentStart: THREE.Vector3,
  segmentEnd: THREE.Vector3
): Vec3 {
  const p = new THREE.Vector3(point.x, point.y, point.z);
  const a = segmentStart;
  const b = segmentEnd;
  
  const ab = new THREE.Vector3().subVectors(b, a);
  const ap = new THREE.Vector3().subVectors(p, a);
  
  const abLengthSq = ab.lengthSq();
  
  if (abLengthSq === 0) {
    // Degenerate segment (start == end)
    return { x: a.x, y: a.y, z: a.z };
  }
  
  // Project point onto line, get parameter t
  const t = ap.dot(ab) / abLengthSq;
  
  // Clamp t to [0, 1] to stay on segment
  const tClamped = Math.max(0, Math.min(1, t));
  
  // Calculate projected point
  const projected = new THREE.Vector3().addVectors(
    a,
    ab.multiplyScalar(tClamped)
  );
  
  return {
    x: projected.x,
    y: projected.y,
    z: projected.z,
  };
}
