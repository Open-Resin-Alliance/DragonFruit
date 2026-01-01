/**
 * Joint Validation Utilities
 * 
 * Functions for validating joint placements, movements, and constraints.
 * Ensures joints are placed correctly and don't violate physical constraints.
 */

import { Vec3 } from '../types';
import {
  SupportJoint,
  JointValidationResult,
  AngleConstraintResult,
  JointCreationConfig,
} from './types';
import { calculateDistance, calculateAngleBetweenVectors } from './geometry';

/**
 * Default configuration for joint creation and validation
 */
export const DEFAULT_JOINT_CONFIG: JointCreationConfig = {
  defaultJointCount: 1,
  minSpacingMm: 2.0,
  maxJointCount: 10,
  snapDistanceMm: 5.0,
  snapBreakThresholdMm: 0.5,
};

/**
 * Validates that a new joint has sufficient spacing from existing joints.
 * 
 * @param newPosition - Position of the new joint
 * @param existingJoints - Array of existing joints in the support
 * @param minSpacingMm - Minimum required spacing in millimeters
 * @returns Validation result with error message if invalid
 */
export function validateJointSpacing(
  newPosition: Vec3,
  existingJoints: SupportJoint[],
  minSpacingMm: number = DEFAULT_JOINT_CONFIG.minSpacingMm
): JointValidationResult {
  for (const joint of existingJoints) {
    const distance = calculateDistance(newPosition, joint.position);
    
    if (distance < minSpacingMm) {
      return {
        isValid: false,
        errorMessage: `Joint must be at least ${minSpacingMm.toFixed(1)}mm from existing joints. Current distance: ${distance.toFixed(2)}mm`,
      };
    }
  }
  
  return { isValid: true };
}

/**
 * Validates that a joint position is within the bounds of a shaft segment.
 * 
 * @param jointPosition - Position of the joint to validate
 * @param segmentStart - Start position of the shaft segment
 * @param segmentEnd - End position of the shaft segment
 * @param tolerance - Tolerance for floating point comparison (mm)
 * @returns Validation result with error message if invalid
 */
export function validateJointBounds(
  jointPosition: Vec3,
  segmentStart: Vec3,
  segmentEnd: Vec3,
  tolerance: number = 0.01
): JointValidationResult {
  // Calculate the parameter t along the segment (0 = start, 1 = end)
  const segmentVector = {
    x: segmentEnd.x - segmentStart.x,
    y: segmentEnd.y - segmentStart.y,
    z: segmentEnd.z - segmentStart.z,
  };
  
  const jointVector = {
    x: jointPosition.x - segmentStart.x,
    y: jointPosition.y - segmentStart.y,
    z: jointPosition.z - segmentStart.z,
  };
  
  const segmentLengthSq = 
    segmentVector.x * segmentVector.x +
    segmentVector.y * segmentVector.y +
    segmentVector.z * segmentVector.z;
  
  if (segmentLengthSq < tolerance * tolerance) {
    return {
      isValid: false,
      errorMessage: 'Shaft segment is too short for joint placement',
    };
  }
  
  const t = (
    jointVector.x * segmentVector.x +
    jointVector.y * segmentVector.y +
    jointVector.z * segmentVector.z
  ) / segmentLengthSq;
  
  // Check if t is within [0, 1] with tolerance
  if (t < -tolerance || t > 1 + tolerance) {
    return {
      isValid: false,
      errorMessage: 'Joint must be placed within the shaft segment bounds',
    };
  }
  
  // Warn if very close to endpoints
  if (t < 0.1 || t > 0.9) {
    return {
      isValid: true,
      warningMessage: 'Joint is very close to segment endpoint. Consider adjusting position.',
    };
  }
  
  return { isValid: true };
}

/**
 * Validates that the total number of joints doesn't exceed the maximum.
 * 
 * @param currentJointCount - Current number of joints in the support
 * @param maxJointCount - Maximum allowed joints
 * @returns Validation result with error message if invalid
 */
export function validateJointCount(
  currentJointCount: number,
  maxJointCount: number = DEFAULT_JOINT_CONFIG.maxJointCount
): JointValidationResult {
  if (currentJointCount >= maxJointCount) {
    return {
      isValid: false,
      errorMessage: `Maximum joint count (${maxJointCount}) reached`,
    };
  }
  
  return { isValid: true };
}

/**
 * Validates the angle between two shaft segments at a joint.
 * Prevents joints from creating angles that are too sharp.
 * 
 * @param segmentA - Direction vector of first segment
 * @param segmentB - Direction vector of second segment
 * @param maxAngleDeg - Maximum allowed angle in degrees
 * @returns Angle constraint validation result
 */
export function validateJointAngle(
  segmentA: Vec3,
  segmentB: Vec3,
  maxAngleDeg: number
): AngleConstraintResult {
  const angleDeg = calculateAngleBetweenVectors(segmentA, segmentB);
  
  if (angleDeg > maxAngleDeg) {
    return {
      isValid: false,
      angleDeg,
      maxAngleDeg,
      errorMessage: `Joint angle (${angleDeg.toFixed(1)}°) exceeds maximum (${maxAngleDeg}°)`,
    };
  }
  
  // Warn if angle is getting close to maximum
  if (angleDeg > maxAngleDeg * 0.9) {
    return {
      isValid: true,
      angleDeg,
      maxAngleDeg,
      errorMessage: `Joint angle (${angleDeg.toFixed(1)}°) is close to maximum (${maxAngleDeg}°)`,
    };
  }
  
  return {
    isValid: true,
    angleDeg,
    maxAngleDeg,
  };
}

/**
 * Validates joint ball diameter is within acceptable range.
 * 
 * @param diameterMm - Diameter to validate
 * @param minDiameter - Minimum allowed diameter (default 0.5mm)
 * @param maxDiameter - Maximum allowed diameter (default 5.0mm)
 * @returns Validation result
 */
export function validateJointDiameter(
  diameterMm: number,
  minDiameter: number = 0.5,
  maxDiameter: number = 5.0
): JointValidationResult {
  if (diameterMm < minDiameter) {
    return {
      isValid: false,
      errorMessage: `Joint diameter (${diameterMm}mm) is below minimum (${minDiameter}mm)`,
    };
  }
  
  if (diameterMm > maxDiameter) {
    return {
      isValid: false,
      errorMessage: `Joint diameter (${diameterMm}mm) exceeds maximum (${maxDiameter}mm)`,
    };
  }
  
  return { isValid: true };
}

/**
 * Comprehensive validation for a new joint placement.
 * Checks spacing, bounds, count, and diameter.
 * 
 * @param newPosition - Position for the new joint
 * @param segmentStart - Start of the target shaft segment
 * @param segmentEnd - End of the target shaft segment
 * @param existingJoints - Existing joints in the support
 * @param ballDiameterMm - Diameter of the new joint ball
 * @param config - Joint creation configuration
 * @returns Comprehensive validation result
 */
export function validateJointPlacement(
  newPosition: Vec3,
  segmentStart: Vec3,
  segmentEnd: Vec3,
  existingJoints: SupportJoint[],
  ballDiameterMm: number,
  config: JointCreationConfig = DEFAULT_JOINT_CONFIG
): JointValidationResult {
  // Check joint count
  const countResult = validateJointCount(existingJoints.length, config.maxJointCount);
  if (!countResult.isValid) {
    return countResult;
  }
  
  // Check diameter
  const diameterResult = validateJointDiameter(ballDiameterMm);
  if (!diameterResult.isValid) {
    return diameterResult;
  }
  
  // Check bounds
  const boundsResult = validateJointBounds(newPosition, segmentStart, segmentEnd);
  if (!boundsResult.isValid) {
    return boundsResult;
  }
  
  // Check spacing
  const spacingResult = validateJointSpacing(newPosition, existingJoints, config.minSpacingMm);
  if (!spacingResult.isValid) {
    return spacingResult;
  }
  
  // Combine warnings
  const warnings = [boundsResult.warningMessage, spacingResult.warningMessage]
    .filter(Boolean)
    .join(' ');
  
  return {
    isValid: true,
    warningMessage: warnings || undefined,
  };
}

/**
 * Validates that a joint movement doesn't violate constraints.
 * 
 * @param jointId - ID of the joint being moved
 * @param newPosition - Proposed new position
 * @param allJoints - All joints in the support
 * @param tipPosition - Tip position (must remain fixed)
 * @param basePosition - Base position (must remain fixed)
 * @param maxAngleDeg - Maximum allowed angle between segments
 * @returns Validation result
 */
export function validateJointMovement(
  jointId: string,
  newPosition: Vec3,
  allJoints: SupportJoint[],
  tipPosition: Vec3,
  basePosition: Vec3,
  maxAngleDeg: number
): JointValidationResult {
  // Find the joint being moved
  const joint = allJoints.find(j => j.id === jointId);
  if (!joint) {
    return {
      isValid: false,
      errorMessage: 'Joint not found',
    };
  }
  
  // Sort joints by order
  const sortedJoints = [...allJoints].sort((a, b) => a.order - b.order);
  const jointIndex = sortedJoints.findIndex(j => j.id === jointId);
  
  // Get adjacent positions
  const prevPosition = jointIndex > 0 
    ? sortedJoints[jointIndex - 1].position 
    : basePosition;
  
  const nextPosition = jointIndex < sortedJoints.length - 1
    ? sortedJoints[jointIndex + 1].position
    : tipPosition;
  
  // Calculate segment directions
  const lowerSegment = {
    x: newPosition.x - prevPosition.x,
    y: newPosition.y - prevPosition.y,
    z: newPosition.z - prevPosition.z,
  };
  
  const upperSegment = {
    x: nextPosition.x - newPosition.x,
    y: nextPosition.y - newPosition.y,
    z: nextPosition.z - newPosition.z,
  };
  
  // Validate angle if there are segments on both sides
  if (jointIndex > 0 || jointIndex < sortedJoints.length - 1) {
    const angleResult = validateJointAngle(lowerSegment, upperSegment, maxAngleDeg);
    if (!angleResult.isValid) {
      return {
        isValid: false,
        errorMessage: angleResult.errorMessage,
      };
    }
  }
  
  // Check spacing from other joints (excluding the one being moved)
  const otherJoints = allJoints.filter(j => j.id !== jointId);
  const spacingResult = validateJointSpacing(newPosition, otherJoints);
  if (!spacingResult.isValid) {
    return spacingResult;
  }
  
  return { isValid: true };
}
