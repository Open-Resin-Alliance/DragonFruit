/**
 * Shaft Splitting Utilities
 * 
 * Functions for splitting support shafts when adding new joints.
 * Handles the logic of inserting joints into existing shaft segments.
 */

import { Vec3, SupportInstance } from '../types';
import {
  SupportJoint,
  ShaftSegment,
  ShaftSplitParams,
  ShaftSplitResult,
} from './types';
import { interpolatePoint, calculateDistance } from './geometry';
import { createJoint } from './factory';

/**
 * Finds the shaft segment that contains a given position.
 * 
 * @param support - Support instance
 * @param position - Position to check
 * @param tolerance - Distance tolerance for matching (mm)
 * @returns Index of the segment, or -1 if not found
 */
export function findTargetShaftSegment(
  support: SupportInstance,
  position: Vec3,
  tolerance: number = 0.1
): number {
  const joints = support.joints || [];
  
  // Build segment list: base → joint1 → joint2 → ... → tip
  const segments: { start: Vec3; end: Vec3 }[] = [];
  
  if (joints.length === 0) {
    // Single segment from base to tip
    segments.push({ start: support.base, end: support.tip });
  } else {
    // Sort joints by order
    const sortedJoints = [...joints].sort((a, b) => a.order - b.order);
    
    // Base to first joint
    segments.push({ start: support.base, end: sortedJoints[0].position });
    
    // Between joints
    for (let i = 0; i < sortedJoints.length - 1; i++) {
      segments.push({
        start: sortedJoints[i].position,
        end: sortedJoints[i + 1].position,
      });
    }
    
    // Last joint to tip
    segments.push({
      start: sortedJoints[sortedJoints.length - 1].position,
      end: support.tip,
    });
  }
  
  // Find which segment the position is closest to
  let closestSegmentIndex = -1;
  let minDistance = Infinity;
  
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const distance = distanceToSegment(position, segment.start, segment.end);
    
    if (distance < minDistance) {
      minDistance = distance;
      closestSegmentIndex = i;
    }
  }
  
  // Only return if within tolerance
  if (minDistance <= tolerance) {
    return closestSegmentIndex;
  }
  
  return -1;
}

/**
 * Calculates the distance from a point to a line segment.
 * 
 * @param point - Point to measure from
 * @param segmentStart - Start of segment
 * @param segmentEnd - End of segment
 * @returns Minimum distance to segment
 */
function distanceToSegment(point: Vec3, segmentStart: Vec3, segmentEnd: Vec3): number {
  const segmentVector = {
    x: segmentEnd.x - segmentStart.x,
    y: segmentEnd.y - segmentStart.y,
    z: segmentEnd.z - segmentStart.z,
  };
  
  const pointVector = {
    x: point.x - segmentStart.x,
    y: point.y - segmentStart.y,
    z: point.z - segmentStart.z,
  };
  
  const segmentLengthSq =
    segmentVector.x * segmentVector.x +
    segmentVector.y * segmentVector.y +
    segmentVector.z * segmentVector.z;
  
  if (segmentLengthSq < 1e-10) {
    return calculateDistance(point, segmentStart);
  }
  
  let t = (
    pointVector.x * segmentVector.x +
    pointVector.y * segmentVector.y +
    pointVector.z * segmentVector.z
  ) / segmentLengthSq;
  
  t = Math.max(0, Math.min(1, t));
  
  const closestPoint = {
    x: segmentStart.x + t * segmentVector.x,
    y: segmentStart.y + t * segmentVector.y,
    z: segmentStart.z + t * segmentVector.z,
  };
  
  return calculateDistance(point, closestPoint);
}

/**
 * Calculates the exact split point along a segment given a parameter t.
 * 
 * @param segmentStart - Start of the segment
 * @param segmentEnd - End of the segment
 * @param t - Parameter (0-1) along the segment
 * @returns 3D position at parameter t
 */
export function calculateSplitPoint(
  segmentStart: Vec3,
  segmentEnd: Vec3,
  t: number
): Vec3 {
  return interpolatePoint(segmentStart, segmentEnd, t);
}

/**
 * Splits a shaft segment by inserting a new joint.
 * Creates a new joint and updates the joint chain.
 * 
 * @param params - Shaft split parameters
 * @param support - Current support instance
 * @returns Result containing new joint and updated joints array
 */
export function splitShaftAtJoint(
  params: ShaftSplitParams,
  support: SupportInstance
): ShaftSplitResult {
  const existingJoints = support.joints || [];
  
  // Determine segment start and end positions
  const { segmentStart, segmentEnd } = getSegmentPositions(
    support,
    existingJoints,
    params.segmentIndex
  );
  
  // Create the new joint
  const newJoint = createJoint({
    position: params.jointPosition,
    ballDiameterMm: params.ballDiameterMm,
    order: params.segmentIndex, // Will be adjusted when inserting
  });
  
  // Insert the new joint into the chain at the correct position
  const updatedJoints = insertJointIntoChain(
    existingJoints,
    newJoint,
    params.segmentIndex
  );
  
  // Create segment representations (for return value)
  const lowerSegment: ShaftSegment = {
    id: `segment-${params.supportId}-${params.segmentIndex}`,
    startPosition: segmentStart,
    endPosition: params.jointPosition,
    diameterMm: support.settings.mid.diameterMm,
    shape: support.settings.mid.shape,
    startJointId: params.segmentIndex > 0 ? updatedJoints[params.segmentIndex - 1].id : null,
    endJointId: newJoint.id,
    order: params.segmentIndex,
  };
  
  const upperSegment: ShaftSegment = {
    id: `segment-${params.supportId}-${params.segmentIndex + 1}`,
    startPosition: params.jointPosition,
    endPosition: segmentEnd,
    diameterMm: support.settings.mid.diameterMm,
    shape: support.settings.mid.shape,
    startJointId: newJoint.id,
    endJointId: params.segmentIndex < existingJoints.length 
      ? updatedJoints[params.segmentIndex + 1].id 
      : null,
    order: params.segmentIndex + 1,
  };
  
  return {
    newJoint,
    lowerSegment,
    upperSegment,
    updatedJoints,
  };
}

/**
 * Gets the start and end positions of a segment by index.
 * 
 * @param support - Support instance
 * @param joints - Array of joints (sorted by order)
 * @param segmentIndex - Index of the segment
 * @returns Start and end positions
 */
function getSegmentPositions(
  support: SupportInstance,
  joints: SupportJoint[],
  segmentIndex: number
): { segmentStart: Vec3; segmentEnd: Vec3 } {
  const sortedJoints = [...joints].sort((a, b) => a.order - b.order);
  
  let segmentStart: Vec3;
  let segmentEnd: Vec3;
  
  if (sortedJoints.length === 0) {
    // No joints: base to tip
    segmentStart = support.base;
    segmentEnd = support.tip;
  } else if (segmentIndex === 0) {
    // First segment: base to first joint
    segmentStart = support.base;
    segmentEnd = sortedJoints[0].position;
  } else if (segmentIndex >= sortedJoints.length) {
    // Last segment: last joint to tip
    segmentStart = sortedJoints[sortedJoints.length - 1].position;
    segmentEnd = support.tip;
  } else {
    // Middle segment: joint to joint
    segmentStart = sortedJoints[segmentIndex - 1].position;
    segmentEnd = sortedJoints[segmentIndex].position;
  }
  
  return { segmentStart, segmentEnd };
}

/**
 * Inserts a new joint into the joint chain and updates order values.
 * 
 * @param existingJoints - Current joints array
 * @param newJoint - New joint to insert
 * @param insertAtIndex - Position to insert (segment index)
 * @returns Updated joints array with corrected order values
 */
function insertJointIntoChain(
  existingJoints: SupportJoint[],
  newJoint: SupportJoint,
  insertAtIndex: number
): SupportJoint[] {
  // Sort existing joints by order
  const sortedJoints = [...existingJoints].sort((a, b) => a.order - b.order);
  
  // Set the new joint's order
  newJoint.order = insertAtIndex;
  
  // Insert the new joint
  const updatedJoints = [...sortedJoints];
  updatedJoints.splice(insertAtIndex, 0, newJoint);
  
  // Reindex all joints to ensure correct order
  updatedJoints.forEach((joint, index) => {
    joint.order = index;
    joint.updatedAt = Date.now();
  });
  
  return updatedJoints;
}

/**
 * Removes a joint from the chain and merges the adjacent segments.
 * 
 * @param joints - Current joints array
 * @param jointId - ID of the joint to remove
 * @returns Updated joints array
 */
export function removeJointFromChain(
  joints: SupportJoint[],
  jointId: string
): SupportJoint[] {
  const filtered = joints.filter(j => j.id !== jointId);
  
  // Reindex remaining joints
  const sortedJoints = [...filtered].sort((a, b) => a.order - b.order);
  sortedJoints.forEach((joint, index) => {
    joint.order = index;
    joint.updatedAt = Date.now();
  });
  
  return sortedJoints;
}

/**
 * Gets all shaft segments for a support (for rendering).
 * 
 * @param support - Support instance
 * @returns Array of shaft segments
 */
export function getShaftSegments(support: SupportInstance): ShaftSegment[] {
  const joints = support.joints || [];
  const sortedJoints = [...joints].sort((a, b) => a.order - b.order);
  const segments: ShaftSegment[] = [];
  
  if (sortedJoints.length === 0) {
    // Single segment: base to tip
    segments.push({
      id: `segment-${support.id}-0`,
      startPosition: support.base,
      endPosition: support.tip,
      diameterMm: support.settings.mid.diameterMm,
      shape: support.settings.mid.shape,
      startJointId: null,
      endJointId: null,
      order: 0,
    });
  } else {
    // Base to first joint
    segments.push({
      id: `segment-${support.id}-0`,
      startPosition: support.base,
      endPosition: sortedJoints[0].position,
      diameterMm: support.settings.mid.diameterMm,
      shape: support.settings.mid.shape,
      startJointId: null,
      endJointId: sortedJoints[0].id,
      order: 0,
    });
    
    // Between joints
    for (let i = 0; i < sortedJoints.length - 1; i++) {
      segments.push({
        id: `segment-${support.id}-${i + 1}`,
        startPosition: sortedJoints[i].position,
        endPosition: sortedJoints[i + 1].position,
        diameterMm: support.settings.mid.diameterMm,
        shape: support.settings.mid.shape,
        startJointId: sortedJoints[i].id,
        endJointId: sortedJoints[i + 1].id,
        order: i + 1,
      });
    }
    
    // Last joint to tip
    segments.push({
      id: `segment-${support.id}-${sortedJoints.length}`,
      startPosition: sortedJoints[sortedJoints.length - 1].position,
      endPosition: support.tip,
      diameterMm: support.settings.mid.diameterMm,
      shape: support.settings.mid.shape,
      startJointId: sortedJoints[sortedJoints.length - 1].id,
      endJointId: null,
      order: sortedJoints.length,
    });
  }
  
  return segments;
}
