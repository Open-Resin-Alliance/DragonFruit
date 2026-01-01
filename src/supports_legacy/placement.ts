import * as THREE from 'three';
import { SupportInstance, SupportSettings, Vec3 } from './types';
import { generateSupportId } from './state';

/**
 * Given a raycast hit on the mesh, compute tip and base positions for a new support.
 * 
 * @param hit - THREE.Intersection from raycaster
 * @param settings - Current support settings profile
 * @param plateZ - Z coordinate of the build plate (default 0)
 * @returns SupportInstance or null if placement is invalid
 */
export function createSupportFromRaycast(
  hit: THREE.Intersection,
  settings: SupportSettings,
  plateZ: number = 0
): SupportInstance | null {
  // Tip: where the raycast hit the mesh (already in world space)
  const tip = {
    x: hit.point.x,
    y: hit.point.y,
    z: hit.point.z,
  };

  // console.log('[placement] Tip world position:', tip);
  // console.log('[placement] Plate Z:', plateZ);

  // Tip normal: perpendicular to the polygon (face normal)
  // R3F provides the normal in world space via hit.normal, or we can transform hit.face.normal
  let tipNormal: { x: number; y: number; z: number };
  
  if (hit.normal) {
    // Use the world-space normal provided by R3F
    tipNormal = {
      x: hit.normal.x,
      y: hit.normal.y,
      z: hit.normal.z,
    };
  } else if (hit.face) {
    // Transform face normal from local to world space
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
    const worldNormal = hit.face.normal.clone().applyMatrix3(normalMatrix).normalize();
    tipNormal = {
      x: worldNormal.x,
      y: worldNormal.y,
      z: worldNormal.z,
    };
  } else {
    // Fallback
    tipNormal = { x: 0, y: 0, z: 1 };
  }

  // console.log('[placement] Tip normal (world space):', tipNormal);

  // Support axis: We want to go from tip toward plate (downward in Z)
  // The tip normal points OUT from the surface. We want the support to extend
  // in the opposite direction (into the model and down to the plate).
  // So we use -tipNormal as the support direction.
  const supportDir = new THREE.Vector3(-tipNormal.x, -tipNormal.y, -tipNormal.z).normalize();
  
  // console.log('[placement] Support direction:', supportDir);

  // However, we need to ensure the support goes DOWNWARD (toward lower Z).
  // If supportDir.z is positive (going up), we need to flip it.
  // Actually, let's just project straight down to the plate for simplicity.
  // We'll use a vertical line from the tip down to Z=plateZ.
  
  // Simple approach: drop straight down from tip to plate
  if (tip.z <= plateZ) {
    console.warn('[Support Placement] Tip is at or below plate, cannot place support.');
    return null;
  }

  // Calculate tipEnd (where the tip cone ends and shaft begins)
  // The shaft should go from tipEnd down to top of base raft, not to plate
  const tipLength = settings.tip.lengthMm;
  const baseHeight = settings.base.heightMm;
  const tipDir = new THREE.Vector3(tipNormal.x, tipNormal.y, tipNormal.z).normalize();
  const tipEnd = {
    x: tip.x + tipDir.x * tipLength,
    y: tip.y + tipDir.y * tipLength,
    z: tip.z + tipDir.z * tipLength,
  };
  
  // Base is directly below the tip joint (tipEnd) on the plate at initial placement
  // This anchors the base under the shaft (not the tip point). Later edits do not move base XY.
  const base = {
    x: tipEnd.x,
    y: tipEnd.y,
    z: plateZ,
  };

  // Base normal: plate normal (pointing up)
  const baseNormal = { x: 0, y: 0, z: 1 };

  // Check minimum length
  const length = tip.z - plateZ; // Vertical distance
  const minLength = 1.0; // Minimum 1mm
  if (length < minLength) {
    console.warn('[Support Placement] Support too short, skipping. Length:', length);
    return null;
  }
  
  // console.log('[placement] Support length:', length, 'mm');
  
  // Calculate where the shaft ends (top of the base raft)
  const shaftEnd = {
    x: tipEnd.x,
    y: tipEnd.y,
    z: plateZ + baseHeight,
  };

  // Create support instance
  const instance: SupportInstance = {
    id: generateSupportId(),
    objectIdTip: hit.object.userData?.id || null,
    tip,
    tipNormal,
    base,
    baseNormal,
    settings: JSON.parse(JSON.stringify(settings)), // Deep copy
  };

  // Create joints: ALWAYS include tip joint + additional joints from settings
  // The tip joint is mandatory and positioned exactly at tipEnd (base of tip cone)
  const additionalJointCount = settings.jointDefaults?.defaultJointCount ?? 0;
  const totalJointCount = 1 + additionalJointCount; // Tip joint + additional
  
  console.log('[Support Placement] jointDefaults:', settings.jointDefaults);
  console.log('[Support Placement] Additional joints:', additionalJointCount, 'Total joints:', totalJointCount);
  
  const joints: Vec3[] = [];
  
  // 1. Tip joint: ALWAYS at tipEnd (base of tip cone)
  joints.push({
    x: tipEnd.x,
    y: tipEnd.y,
    z: tipEnd.z,
  });
  
  // 2. Additional joints: distributed evenly along the remaining shaft (tipEnd to shaftEnd)
  if (additionalJointCount > 0) {
    const shaftVector = {
      x: shaftEnd.x - tipEnd.x,
      y: shaftEnd.y - tipEnd.y,
      z: shaftEnd.z - tipEnd.z,
    };
    
    for (let i = 0; i < additionalJointCount; i++) {
      const t = (i + 1) / (additionalJointCount + 1);
      joints.push({
        x: tipEnd.x + shaftVector.x * t,
        y: tipEnd.y + shaftVector.y * t,
        z: tipEnd.z + shaftVector.z * t,
      });
    }
  }
  
  // Joint diameter should be shaft diameter + 0.1mm for proper visual connection
  const shaftDiameter = settings.mid.diameterMm;
  const jointDiameter = shaftDiameter + 0.1;
  
  instance.joints = joints.map((position, index) => ({
    id: `${instance.id}-joint-${index}-${Date.now()}`,
    position,
    ballDiameterMm: jointDiameter,
    order: index,
    isTipJoint: index === 0, // Mark the first joint as the tip joint
    updatedAt: Date.now(),
  }));
  
  console.log(`[Support Placement] Created ${totalJointCount} joints (1 tip @ tipEnd + ${additionalJointCount} additional) for support ${instance.id}:`, instance.joints);

  return instance;
}
