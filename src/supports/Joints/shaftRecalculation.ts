/**
 * Shaft Recalculation Utilities
 * 
 * Functions for recalculating shaft segment directions and rotations
 * when joints are moved. Ensures shafts remain connected to joints.
 * 
 * CRITICAL INVARIANT: Shafts ALWAYS remain connected to joints.
 * Tip and base positions NEVER move when moving joints.
 */

import { Vec3 } from '../types';
import {
  SupportJoint,
  ShaftSegment,
  ShaftRecalculationParams,
  ShaftRecalculationResult,
} from './types';
import {
  subtractVectors,
  normalizeVector,
  calculateDistance,
} from './geometry';

/**
 * Finds the segments adjacent to a moved joint.
 * 
 * @param movedJointId - ID of the joint that was moved
 * @param allJoints - All joints in the support (sorted by order)
 * @param tipPosition - Tip position (fixed)
 * @param basePosition - Base position (fixed)
 * @returns Object containing lower and upper segment info
 */
export function findAdjacentSegments(
  movedJointId: string,
  allJoints: SupportJoint[],
  tipPosition: Vec3,
  basePosition: Vec3
): {
  lowerSegment: { start: Vec3; end: Vec3; index: number } | null;
  upperSegment: { start: Vec3; end: Vec3; index: number } | null;
  jointIndex: number;
} {
  const sortedJoints = [...allJoints].sort((a, b) => a.order - b.order);
  const jointIndex = sortedJoints.findIndex(j => j.id === movedJointId);
  
  if (jointIndex === -1) {
    return { lowerSegment: null, upperSegment: null, jointIndex: -1 };
  }
  
  const movedJoint = sortedJoints[jointIndex];
  
  // Lower segment (below the moved joint)
  const lowerSegment = jointIndex > 0
    ? {
        start: sortedJoints[jointIndex - 1].position,
        end: movedJoint.position,
        index: jointIndex,
      }
    : {
        start: basePosition,
        end: movedJoint.position,
        index: 0,
      };
  
  // Upper segment (above the moved joint)
  const upperSegment = jointIndex < sortedJoints.length - 1
    ? {
        start: movedJoint.position,
        end: sortedJoints[jointIndex + 1].position,
        index: jointIndex + 1,
      }
    : {
        start: movedJoint.position,
        end: tipPosition,
        index: sortedJoints.length,
      };
  
  return { lowerSegment, upperSegment, jointIndex };
}

/**
 * Recalculates shaft segments when a joint is moved.
 * Updates the directions and rotations of adjacent segments.
 * 
 * CRITICAL: This function preserves tip and base positions.
 * Only the joint position changes, segments adjust their angles.
 * 
 * @param params - Recalculation parameters
 * @returns Result with updated segments
 */
export function recalculateShaftSegments(
  params: ShaftRecalculationParams
): ShaftRecalculationResult {
  const { movedJointId, newPosition, allJoints, tipPosition, basePosition } = params;
  
  // Find adjacent segments
  const { lowerSegment, upperSegment, jointIndex } = findAdjacentSegments(
    movedJointId,
    allJoints,
    tipPosition,
    basePosition
  );
  
  if (jointIndex === -1) {
    return {
      updatedSegments: [],
      success: false,
      errorMessage: 'Joint not found',
    };
  }
  
  const updatedSegments: ShaftSegment[] = [];
  
  // Recalculate lower segment (from previous joint/base to moved joint)
  if (lowerSegment) {
    const lowerDirection = subtractVectors(newPosition, lowerSegment.start);
    const lowerLength = calculateDistance(lowerSegment.start, newPosition);
    
    updatedSegments.push({
      id: `segment-${params.supportId}-${lowerSegment.index}`,
      startPosition: lowerSegment.start,
      endPosition: newPosition,
      diameterMm: 1.0, // Will be set from support settings
      shape: 'cylinder',
      startJointId: jointIndex > 0 ? allJoints[jointIndex - 1].id : null,
      endJointId: movedJointId,
      order: lowerSegment.index,
    });
  }
  
  // Recalculate upper segment (from moved joint to next joint/tip)
  if (upperSegment) {
    const upperDirection = subtractVectors(upperSegment.end, newPosition);
    const upperLength = calculateDistance(newPosition, upperSegment.end);
    
    updatedSegments.push({
      id: `segment-${params.supportId}-${upperSegment.index}`,
      startPosition: newPosition,
      endPosition: upperSegment.end,
      diameterMm: 1.0, // Will be set from support settings
      shape: 'cylinder',
      startJointId: movedJointId,
      endJointId: jointIndex < allJoints.length - 1 ? allJoints[jointIndex + 1].id : null,
      order: upperSegment.index,
    });
  }
  
  return {
    updatedSegments,
    success: true,
  };
}

/**
 * Calculates the rotation quaternion needed to align a cylinder
 * from one point to another in 3D space.
 * 
 * @param start - Start position
 * @param end - End position
 * @returns Rotation in Euler angles (radians) for Three.js
 */
export function calculateSegmentRotation(
  start: Vec3,
  end: Vec3
): { x: number; y: number; z: number } {
  // Calculate direction vector
  const direction = normalizeVector(subtractVectors(end, start));
  
  // Default cylinder in Three.js points along Y-axis
  // We need to rotate it to point along our direction vector
  
  // Calculate rotation angles
  const length = Math.sqrt(direction.x * direction.x + direction.z * direction.z);
  
  // Rotation around Z-axis (yaw)
  const yaw = Math.atan2(direction.x, direction.z);
  
  // Rotation around X-axis (pitch)
  const pitch = Math.atan2(length, direction.y) - Math.PI / 2;
  
  return {
    x: pitch,
    y: yaw,
    z: 0,
  };
}

/**
 * Updates all segments in a support after a joint movement.
 * Only updates the segments adjacent to the moved joint.
 * 
 * @param supportId - ID of the support
 * @param movedJointId - ID of the moved joint
 * @param newPosition - New position of the joint
 * @param allJoints - All joints in the support
 * @param allSegments - All current segments
 * @param tipPosition - Tip position (fixed)
 * @param basePosition - Base position (fixed)
 * @returns Updated segments array
 */
export function updateSegmentsAfterJointMove(
  supportId: string,
  movedJointId: string,
  newPosition: Vec3,
  allJoints: SupportJoint[],
  allSegments: ShaftSegment[],
  tipPosition: Vec3,
  basePosition: Vec3
): ShaftSegment[] {
  const result = recalculateShaftSegments({
    supportId,
    movedJointId,
    newPosition,
    allJoints,
    tipPosition,
    basePosition,
  });
  
  if (!result.success) {
    console.error('Failed to recalculate segments:', result.errorMessage);
    return allSegments;
  }
  
  // Create a map of updated segments by order
  const updatedMap = new Map<number, ShaftSegment>();
  result.updatedSegments.forEach(seg => {
    updatedMap.set(seg.order, seg);
  });
  
  // Replace only the affected segments
  return allSegments.map(seg => {
    const updated = updatedMap.get(seg.order);
    return updated || seg;
  });
}

/**
 * Validates that shaft recalculation preserves critical invariants.
 * 
 * @param originalTip - Original tip position
 * @param originalBase - Original base position
 * @param updatedSegments - Segments after recalculation
 * @param tolerance - Tolerance for floating point comparison (mm)
 * @returns True if invariants are preserved
 */
export function validateShaftInvariants(
  originalTip: Vec3,
  originalBase: Vec3,
  updatedSegments: ShaftSegment[],
  tolerance: number = 0.001
): { isValid: boolean; errorMessage?: string } {
  if (updatedSegments.length === 0) {
    return { isValid: true };
  }
  
  // Sort segments by order
  const sortedSegments = [...updatedSegments].sort((a, b) => a.order - b.order);
  
  // First segment should start at base
  const firstSegment = sortedSegments[0];
  const baseDistance = calculateDistance(firstSegment.startPosition, originalBase);
  if (baseDistance > tolerance) {
    return {
      isValid: false,
      errorMessage: `Base position moved by ${baseDistance.toFixed(4)}mm`,
    };
  }
  
  // Last segment should end at tip
  const lastSegment = sortedSegments[sortedSegments.length - 1];
  const tipDistance = calculateDistance(lastSegment.endPosition, originalTip);
  if (tipDistance > tolerance) {
    return {
      isValid: false,
      errorMessage: `Tip position moved by ${tipDistance.toFixed(4)}mm`,
    };
  }
  
  // Segments should be connected (end of one = start of next)
  for (let i = 0; i < sortedSegments.length - 1; i++) {
    const currentEnd = sortedSegments[i].endPosition;
    const nextStart = sortedSegments[i + 1].startPosition;
    const gap = calculateDistance(currentEnd, nextStart);
    
    if (gap > tolerance) {
      return {
        isValid: false,
        errorMessage: `Gap of ${gap.toFixed(4)}mm between segments ${i} and ${i + 1}`,
      };
    }
  }
  
  return { isValid: true };
}

/**
 * Calculates the total length of all shaft segments.
 * 
 * @param segments - Array of shaft segments
 * @returns Total length in millimeters
 */
export function calculateTotalShaftLength(segments: ShaftSegment[]): number {
  return segments.reduce((total, segment) => {
    return total + calculateDistance(segment.startPosition, segment.endPosition);
  }, 0);
}
