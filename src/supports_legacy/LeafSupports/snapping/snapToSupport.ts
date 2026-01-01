import type { SupportInstance, Vec3 } from '@/supports_legacy/types';
import type { SupportJoint } from '@/supports_legacy/Joints/types';
import { LEAF_SNAP_DISTANCE } from '../constants';

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

/**
 * Snaps to any support shaft (trunk or branch).
 * Returns the snap position, normal, and support ID.
 */
export function snapToSupport(
  mouse: Vec3,
  supports: SupportInstance[],
  snapDistanceMm: number = LEAF_SNAP_DISTANCE,
  cameraPosition?: Vec3
): { supportId: string; position: Vec3; normal: Vec3 } | null {
  let best: { supportId: string; position: Vec3; normal: Vec3 } | null = null;
  let bestDist = Infinity;
  let bestDepth = Infinity;
  
  for (const s of supports) {
    const joints = (s.joints || []) as SupportJoint[];
    const baseHeight = s.settings?.base?.heightMm ?? 1.0;
    
    // Build shaft segments for all supports (trunk and branch)
    if (joints.length > 0) {
      const sortedJoints = [...joints].sort((a, b) => a.order - b.order);
      
      // Check all segments between consecutive joints
      for (let i = 0; i < sortedJoints.length - 1; i++) {
        const segStart = sortedJoints[i].position;
        const segEnd = sortedJoints[i + 1].position;
        
        const { closest, t } = projectPointOntoSegment(mouse, segStart, segEnd);
        const d = distance(mouse, closest);
        
        if (shouldUpdateBest(d, closest, bestDist, bestDepth, snapDistanceMm, cameraPosition)) {
          // Calculate normal (perpendicular to shaft segment)
          const segDir = {
            x: segEnd.x - segStart.x,
            y: segEnd.y - segStart.y,
            z: segEnd.z - segStart.z,
          };
          const segLen = Math.sqrt(segDir.x*segDir.x + segDir.y*segDir.y + segDir.z*segDir.z) || 1e-6;
          const segDirNorm = { x: segDir.x / segLen, y: segDir.y / segLen, z: segDir.z / segLen };
          
          // Normal points from shaft toward mouse
          const toMouse = {
            x: mouse.x - closest.x,
            y: mouse.y - closest.y,
            z: mouse.z - closest.z,
          };
          const toMouseLen = Math.sqrt(toMouse.x*toMouse.x + toMouse.y*toMouse.y + toMouse.z*toMouse.z) || 1e-6;
          const normal = { x: toMouse.x / toMouseLen, y: toMouse.y / toMouseLen, z: toMouse.z / toMouseLen };
          
          bestDist = d;
          bestDepth = cameraPosition ? distance(closest, cameraPosition) : Infinity;
          best = { supportId: s.id, position: closest, normal };
        }
      }
      
      // Also check segment from last joint to base (if not a branch joint)
      const lastJoint = sortedJoints[sortedJoints.length - 1];
      const isLastJointBranch = lastJoint.type === 'branch' || false;
      
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
          // Calculate normal
          const segDir = {
            x: segEnd.x - segStart.x,
            y: segEnd.y - segStart.y,
            z: segEnd.z - segStart.z,
          };
          const segLen = Math.sqrt(segDir.x*segDir.x + segDir.y*segDir.y + segDir.z*segDir.z) || 1e-6;
          
          const toMouse = {
            x: mouse.x - closest.x,
            y: mouse.y - closest.y,
            z: mouse.z - closest.z,
          };
          const toMouseLen = Math.sqrt(toMouse.x*toMouse.x + toMouse.y*toMouse.y + toMouse.z*toMouse.z) || 1e-6;
          const normal = { x: toMouse.x / toMouseLen, y: toMouse.y / toMouseLen, z: toMouse.z / toMouseLen };
          
          bestDist = d;
          bestDepth = cameraPosition ? distance(closest, cameraPosition) : Infinity;
          best = { supportId: s.id, position: closest, normal };
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
        // Calculate normal
        const toMouse = {
          x: mouse.x - closest.x,
          y: mouse.y - closest.y,
          z: mouse.z - closest.z,
        };
        const toMouseLen = Math.sqrt(toMouse.x*toMouse.x + toMouse.y*toMouse.y + toMouse.z*toMouse.z) || 1e-6;
        const normal = { x: toMouse.x / toMouseLen, y: toMouse.y / toMouseLen, z: toMouse.z / toMouseLen };
        
        bestDist = d;
        bestDepth = cameraPosition ? distance(closest, cameraPosition) : Infinity;
        best = { supportId: s.id, position: closest, normal };
      }
    }
  }
  
  return best;
}
