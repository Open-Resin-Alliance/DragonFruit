/**
 * Joints System - Main Export File
 * 
 * Centralized exports for the joints system.
 * Import from this file to access all joint-related functionality.
 * 
 * @example
 * import { createJoint, validateJointPlacement, splitShaftAtJoint } from '@/supports/Joints';
 */

// ============================================================================
// Types
// ============================================================================

export type {
  SupportJoint,
  ShaftSegment,
  JointCreationConfig,
  JointCreationState,
  JointSelectionState,
  JointValidationResult,
  AngleConstraintResult,
  ShaftSplitParams,
  ShaftSplitResult,
  ShaftRecalculationParams,
  ShaftRecalculationResult,
} from './types';

// ============================================================================
// Geometry Utilities
// ============================================================================

export {
  calculateDistance,
  calculateDistanceSquared,
  vectorLength,
  normalizeVector,
  dotProduct,
  crossProduct,
  calculateAngleBetweenVectors,
  projectPointOntoSegment,
  interpolatePoint,
  subtractVectors,
  addVectors,
  scaleVector,
  calculateDirection,
  arePointsEqual,
  calculateMidpoint,
  distributePointsAlongSegment,
} from './geometry';

// ============================================================================
// Validation
// ============================================================================

export {
  DEFAULT_JOINT_CONFIG,
  validateJointSpacing,
  validateJointBounds,
  validateJointCount,
  validateJointAngle,
  validateJointDiameter,
  validateJointPlacement,
  validateJointMovement,
} from './validation';

// ============================================================================
// Factory Functions
// ============================================================================

export {
  generateJointId,
  createJoint,
  createDefaultJoints,
  cloneJoint,
  updateJointPosition,
  updateJointDiameter,
  deserializeJoints,
  serializeJoints,
} from './factory';

// ============================================================================
// Shaft Splitting
// ============================================================================

export {
  findTargetShaftSegment,
  calculateSplitPoint,
  splitShaftAtJoint,
  removeJointFromChain,
  getShaftSegments,
} from './shaftSplitting';

// ============================================================================
// Shaft Recalculation
// ============================================================================

export {
  findAdjacentSegments,
  recalculateShaftSegments,
  calculateSegmentRotation,
  updateSegmentsAfterJointMove,
  validateShaftInvariants,
  calculateTotalShaftLength,
} from './shaftRecalculation';

// ============================================================================
// Raycasting
// ============================================================================

export type {
  ShaftRaycastHit,
  JointRaycastHit,
} from './raycasting';

export {
  raycastToShafts,
  raycastToJoints,
  isPointNearShaft,
  isPointInJoint,
  findSupportsNearPoint,
  findClosestJoint,
  calculateSnapPosition,
  shouldBreakSnap,
} from './raycasting';
