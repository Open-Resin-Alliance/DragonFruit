/**
 * Joint Raycasting Utilities
 * 
 * Functions for raycasting to detect joints and shafts for interactive editing.
 * Used for joint creation mode (hovering over shafts) and joint selection.
 */

import { Vec3, SupportInstance } from '../types';
import { SupportJoint, ShaftSegment } from './types';
import { projectPointOntoSegment, calculateDistance } from './geometry';
import { getShaftSegments } from './shaftSplitting';

/**
 * Result of a raycast to a shaft segment.
 */
export interface ShaftRaycastHit {
  /** ID of the support that was hit */
  supportId: string;
  
  /** Index of the shaft segment that was hit */
  segmentIndex: number;
  
  /** 3D position of the hit point on the shaft */
  hitPosition: Vec3;
  
  /** Parameter t (0-1) along the segment */
  segmentParameter: number;
  
  /** Distance from the ray origin to the hit point */
  distance: number;
  
  /** The shaft segment that was hit */
  segment: ShaftSegment;
}

/**
 * Result of a raycast to a joint sphere.
 */
export interface JointRaycastHit {
  /** ID of the support containing the joint */
  supportId: string;
  
  /** ID of the joint that was hit */
  jointId: string;
  
  /** The joint that was hit */
  joint: SupportJoint;
  
  /** Distance from the ray origin to the joint center */
  distance: number;
  
  /** 3D position of the joint center */
  hitPosition: Vec3;
}

/**
 * Performs a raycast from a 2D mouse position to detect shaft segments.
 * Used for joint creation mode preview.
 * 
 * @param mousePosition - 3D position in world space (from raycaster)
 * @param supports - Array of support instances to check
 * @param maxDistance - Maximum distance from shaft to consider a hit (mm)
 * @returns Closest shaft hit, or null if none found
 */
export function raycastToShafts(
  mousePosition: Vec3,
  supports: SupportInstance[],
  maxDistance: number = 5.0
): ShaftRaycastHit | null {
  let closestHit: ShaftRaycastHit | null = null;
  let minDistance = maxDistance;
  
  for (const support of supports) {
    const segments = getShaftSegments(support);
    
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      
      // Project mouse position onto the segment
      const { closestPoint, t } = projectPointOntoSegment(
        mousePosition,
        segment.startPosition,
        segment.endPosition
      );
      
      // Calculate distance from mouse to closest point on segment
      const distance = calculateDistance(mousePosition, closestPoint);
      
      // Check if this is the closest hit so far
      if (distance < minDistance) {
        minDistance = distance;
        closestHit = {
          supportId: support.id,
          segmentIndex: i,
          hitPosition: closestPoint,
          segmentParameter: t,
          distance,
          segment,
        };
      }
    }
  }
  
  return closestHit;
}

/**
 * Performs a raycast to detect joint spheres.
 * Used for joint selection.
 * 
 * @param mousePosition - 3D position in world space (from raycaster)
 * @param supports - Array of support instances to check
 * @param maxDistance - Maximum distance from joint center to consider a hit (mm)
 * @returns Closest joint hit, or null if none found
 */
export function raycastToJoints(
  mousePosition: Vec3,
  supports: SupportInstance[],
  maxDistance: number = 10.0
): JointRaycastHit | null {
  let closestHit: JointRaycastHit | null = null;
  let minDistance = maxDistance;
  
  for (const support of supports) {
    const joints = support.joints || [];
    
    for (const joint of joints) {
      // Calculate distance from mouse to joint center
      const distance = calculateDistance(mousePosition, joint.position);
      
      // Check if within joint radius (with some tolerance)
      const hitRadius = joint.ballDiameterMm / 2 + 1.0; // Add 1mm tolerance
      
      if (distance < hitRadius && distance < minDistance) {
        minDistance = distance;
        closestHit = {
          supportId: support.id,
          jointId: joint.id,
          joint,
          distance,
          hitPosition: joint.position,
        };
      }
    }
  }
  
  return closestHit;
}

/**
 * Checks if a point is near a shaft segment (for hover detection).
 * 
 * @param point - Point to check
 * @param segment - Shaft segment
 * @param threshold - Distance threshold (mm)
 * @returns True if point is within threshold distance of segment
 */
export function isPointNearShaft(
  point: Vec3,
  segment: ShaftSegment,
  threshold: number = 2.0
): boolean {
  const { closestPoint } = projectPointOntoSegment(
    point,
    segment.startPosition,
    segment.endPosition
  );
  
  const distance = calculateDistance(point, closestPoint);
  return distance <= threshold;
}

/**
 * Checks if a point is inside a joint sphere (for selection detection).
 * 
 * @param point - Point to check
 * @param joint - Joint to check against
 * @param tolerance - Additional tolerance beyond joint radius (mm)
 * @returns True if point is inside joint sphere
 */
export function isPointInJoint(
  point: Vec3,
  joint: SupportJoint,
  tolerance: number = 0.5
): boolean {
  const distance = calculateDistance(point, joint.position);
  const radius = joint.ballDiameterMm / 2 + tolerance;
  return distance <= radius;
}

/**
 * Finds all supports that have shafts near a given point.
 * Useful for multi-support hover detection.
 * 
 * @param point - Point to check
 * @param supports - Array of supports to check
 * @param threshold - Distance threshold (mm)
 * @returns Array of support IDs with nearby shafts
 */
export function findSupportsNearPoint(
  point: Vec3,
  supports: SupportInstance[],
  threshold: number = 5.0
): string[] {
  const nearbySupports: string[] = [];
  
  for (const support of supports) {
    const segments = getShaftSegments(support);
    
    for (const segment of segments) {
      if (isPointNearShaft(point, segment, threshold)) {
        nearbySupports.push(support.id);
        break; // Only add each support once
      }
    }
  }
  
  return nearbySupports;
}

/**
 * Finds the closest joint to a given point across all supports.
 * 
 * @param point - Point to check
 * @param supports - Array of supports to check
 * @returns Closest joint and its support ID, or null if no joints exist
 */
export function findClosestJoint(
  point: Vec3,
  supports: SupportInstance[]
): { supportId: string; joint: SupportJoint; distance: number } | null {
  let closestJoint: { supportId: string; joint: SupportJoint; distance: number } | null = null;
  let minDistance = Infinity;
  
  for (const support of supports) {
    const joints = support.joints || [];
    
    for (const joint of joints) {
      const distance = calculateDistance(point, joint.position);
      
      if (distance < minDistance) {
        minDistance = distance;
        closestJoint = {
          supportId: support.id,
          joint,
          distance,
        };
      }
    }
  }
  
  return closestJoint;
}

/**
 * Calculates the snap position on a shaft for magnetic snapping.
 * Returns the position only if within snap distance threshold.
 * 
 * @param mousePosition - Current mouse position in 3D space
 * @param segment - Shaft segment to snap to
 * @param snapDistance - Maximum distance for snapping (mm)
 * @returns Snap position, or null if too far
 */
export function calculateSnapPosition(
  mousePosition: Vec3,
  segment: ShaftSegment,
  snapDistance: number = 5.0
): { position: Vec3; parameter: number } | null {
  const { closestPoint, t } = projectPointOntoSegment(
    mousePosition,
    segment.startPosition,
    segment.endPosition
  );
  
  const distance = calculateDistance(mousePosition, closestPoint);
  
  if (distance <= snapDistance) {
    return {
      position: closestPoint,
      parameter: t,
    };
  }
  
  return null;
}

/**
 * Checks if mouse movement exceeds the snap break threshold.
 * Used to determine if the magnetic snap should be released.
 * 
 * @param currentPosition - Current mouse position
 * @param snapPosition - Position mouse is snapped to
 * @param breakThreshold - Distance threshold to break snap (mm)
 * @returns True if snap should be broken
 */
export function shouldBreakSnap(
  currentPosition: Vec3,
  snapPosition: Vec3,
  breakThreshold: number = 0.5
): boolean {
  const distance = calculateDistance(currentPosition, snapPosition);
  return distance > breakThreshold;
}
