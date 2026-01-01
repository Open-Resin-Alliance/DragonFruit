import type { SupportInstance, Vec3 } from '@/supports_legacy/types';
import { BRANCH_SNAP_DISTANCE_MM } from '../constants';

function distance(a: Vec3, b: Vec3) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx*dx + dy*dy + dz*dz);
}

function projectPointOntoSegment(p: Vec3, a: Vec3, b: Vec3) {
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const ap = { x: p.x - a.x, y: p.y - a.y, z: p.z - a.z };
  const abLen2 = ab.x*ab.x + ab.y*ab.y + ab.z*ab.z || 1e-6;
  const t = Math.max(0, Math.min(1, (ab.x*ap.x + ab.y*ap.y + ab.z*ap.z) / abLen2));
  const closest = { x: a.x + ab.x * t, y: a.y + ab.y * t, z: a.z + ab.z * t };
  return { closest, t };
}

function isTrunk(s: SupportInstance): boolean {
  // Heuristic: rooted to plate (near z=0), or explicitly objectIdBase references plate (null check not reliable here)
  return (s.base?.z ?? 0) <= 0.15 && !s.parentBaseId;
}

function isBranch(s: SupportInstance): boolean {
  return !!s.parentBaseId;
}

function shouldUpdateBest(
  newDist: number,
  newPos: Vec3,
  bestDist: number,
  bestDepth: number,
  snapThreshold: number,
  cameraPos?: Vec3
): boolean {
  // Must be within snap threshold
  if (newDist > snapThreshold) return false;
  
  // If no camera position, use simple distance comparison
  if (!cameraPos) {
    return newDist < bestDist;
  }
  
  // Calculate depth (distance from camera)
  const newDepth = distance(newPos, cameraPos);
  
  // If this is significantly closer to camera (>1mm), prefer it even if slightly farther from mouse
  const depthDiff = bestDepth - newDepth;
  if (depthDiff > 1.0) {
    // New position is significantly closer to camera
    return true;
  }
  
  // If depths are similar, prefer closer to mouse
  if (Math.abs(depthDiff) <= 1.0) {
    return newDist < bestDist;
  }
  
  // New position is farther from camera
  return false;
}

export function snapToTrunk(
  mouse: Vec3,
  supports: SupportInstance[],
  snapDistanceMm: number = BRANCH_SNAP_DISTANCE_MM,
  cameraPosition?: Vec3
): { trunkId: string; position: Vec3 } | null {
  let best: { trunkId: string; position: Vec3 } | null = null;
  let bestDist = Infinity;
  let bestDepth = Infinity; // Distance from camera (closer = better)
  let candidateCount = 0;
  
  for (const s of supports) {
    if (!isTrunk(s) && !isBranch(s)) continue;
    candidateCount++;
    
    // Calculate actual shaft endpoints based on joints
    const joints = s.joints || [];
    const baseHeight = s.settings?.base?.heightMm ?? 1.0;
    
    // For branches: limit snapping to tip joint → branch joint only
    // For trunks: snap to full shaft from tip joint → base top
    let shaftStart: Vec3;
    let shaftEnd: Vec3;
    
    if (isBranch(s)) {
      // For branches: check all segments from tip joint through to branch joint
      const sortedJoints = [...joints].sort((a, b) => a.order - b.order);
      const branchJointIndex = sortedJoints.findIndex(j => j.type === 'branch');
      
      if (branchJointIndex === -1) {
        // No branch joint found, skip
        continue;
      }
      
      // Check all segments up to and including the branch joint
      for (let i = 0; i < branchJointIndex; i++) {
        const segStart = sortedJoints[i].position;
        const segEnd = sortedJoints[i + 1].position;
        
        const { closest, t } = projectPointOntoSegment(mouse, segStart, segEnd);
        const d = distance(mouse, closest);
        
        if (shouldUpdateBest(d, closest, bestDist, bestDepth, snapDistanceMm, cameraPosition)) {
          bestDist = d;
          bestDepth = cameraPosition ? distance(closest, cameraPosition) : Infinity;
          best = { trunkId: s.id, position: closest };
        }
      }
    } else {
      // For trunks: build shaft segments through all joints
      if (joints.length > 0) {
        // Build segments: first joint → joint2 → joint3 → ... → last joint
        const sortedJoints = [...joints].sort((a, b) => a.order - b.order);
        
        // Check all segments between consecutive joints
        for (let i = 0; i < sortedJoints.length - 1; i++) {
          const segStart = sortedJoints[i].position;
          const segEnd = sortedJoints[i + 1].position;
          
          const { closest, t } = projectPointOntoSegment(mouse, segStart, segEnd);
          const d = distance(mouse, closest);
          
          if (shouldUpdateBest(d, closest, bestDist, bestDepth, snapDistanceMm, cameraPosition)) {
            bestDist = d;
            bestDepth = cameraPosition ? distance(closest, cameraPosition) : Infinity;
            best = { trunkId: s.id, position: closest };
          }
        }
        
        // Also check segment from last joint to base (if not a branch joint)
        const lastJoint = sortedJoints[sortedJoints.length - 1];
        const isLastJointBranch = lastJoint.type === 'branch';
        
        if (!isLastJointBranch) {
          const segStart = lastJoint.position;
          const segEnd = {
            x: s.base.x,
            y: s.base.y,
            z: s.base.z + baseHeight,
          };
          
          const { closest, t } = projectPointOntoSegment(mouse, segStart, segEnd);
          const d = distance(mouse, closest);
          
          if (shouldUpdateBest(d, closest, bestDist, bestDepth, snapDistanceMm, cameraPosition)) {
            bestDist = d;
            bestDepth = cameraPosition ? distance(closest, cameraPosition) : Infinity;
            best = { trunkId: s.id, position: closest };
          }
        }
      } else {
        // No joints: single segment from tip socket to base top
        const tipLength = s.settings?.tip?.lengthMm ?? 2.0;
        const tipNormal = s.tipNormal ?? { x: 0, y: 0, z: 1 };
        const segStart = {
          x: s.tip.x + tipNormal.x * tipLength,
          y: s.tip.y + tipNormal.y * tipLength,
          z: s.tip.z + tipNormal.z * tipLength,
        };
        const segEnd = {
          x: s.base.x,
          y: s.base.y,
          z: s.base.z + baseHeight,
        };
        
        const { closest, t } = projectPointOntoSegment(mouse, segStart, segEnd);
        const d = distance(mouse, closest);
        
        if (shouldUpdateBest(d, closest, bestDist, bestDepth, snapDistanceMm, cameraPosition)) {
          bestDist = d;
          bestDepth = cameraPosition ? distance(closest, cameraPosition) : Infinity;
          best = { trunkId: s.id, position: closest };
        }
      }
    }
  }
  
  // Removed debug logging to reduce console spam
  // if (candidateCount === 0) {
  //   console.warn('[BranchSnap] No trunk/branch candidates found in supports list');
  // } else if (!best) {
  //   console.log(`[BranchSnap] Checked ${candidateCount} supports, none within ${snapDistanceMm}mm`);
  // } else {
  //   console.log(`[BranchSnap] Snapped to ${best.trunkId} at distance ${bestDist.toFixed(2)}mm`);
  // }
  
  return best;
}
