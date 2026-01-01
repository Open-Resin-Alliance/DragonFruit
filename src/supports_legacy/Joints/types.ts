/**
 * Joint System Types
 * 
 * Defines the data structures for multi-segment supports with ball joints.
 * Supports variable joint count (0 to N joints per support).
 */

import { Vec3 } from '../types';

/**
 * Type of joint - determines behavior and constraints
 * - standard: Regular joint on trunk/branch shaft
 * - branch: Joint that connects branch to parent support (can slide along parent shaft)
 * - leaf: Joint that connects leaf to parent support (can slide along parent shaft)
 */
export type JointType = 'standard' | 'branch' | 'leaf' | 'user';

/**
 * Represents a single ball joint in a support structure.
 * Joints connect shaft segments and allow for articulation.
 */
export interface SupportJoint {
  /** Unique identifier for this joint */
  id: string;
  
  /** 3D position of the joint center in world space */
  position: Vec3;
  
  /** Optional rotation (may be used for non-spherical joints in future) */
  rotation?: Vec3;
  
  /** Diameter of the spherical ball joint in millimeters */
  ballDiameterMm: number;
  
  /** ID of the shaft segment below this joint (toward base) */
  parentSegmentId?: string;
  
  /** ID of the shaft segment above this joint (toward tip) */
  childSegmentId?: string;
  
  /** Position in the joint chain (0 = closest to base, N-1 = closest to tip) */
  order: number;
  
  /** Flag indicating if this is the mandatory tip joint (always at base of tip cone) */
  isTipJoint?: boolean;
  
  /** Type of joint - determines movement constraints and rendering */
  type?: JointType;
  
  /** For branch joints: ID of the parent support this joint is locked to */
  lockedToSupportId?: string;
  
  /** Timestamp of last modification */
  updatedAt?: number;
}

/**
 * Represents a shaft segment between two points (joints, base, or tip).
 * Each support with N joints has N+1 segments.
 */
export interface ShaftSegment {
  /** Unique identifier for this segment */
  id: string;
  
  /** Start position (base or previous joint) */
  startPosition: Vec3;
  
  /** End position (next joint or tip) */
  endPosition: Vec3;
  
  /** Diameter of this shaft segment in millimeters */
  diameterMm: number;
  
  /** Shape of the segment */
  shape: 'cylinder' | 'cone' | 'cube';
  
  /** ID of the joint at the start (null if this is the base segment) */
  startJointId: string | null;
  
  /** ID of the joint at the end (null if this is the tip segment) */
  endJointId: string | null;
  
  /** Order in the segment chain (0 = base segment) */
  order: number;
}

/**
 * Configuration for joint creation and behavior
 */
export interface JointCreationConfig {
  /** Default number of joints for new supports */
  defaultJointCount: number;
  
  /** Minimum spacing between joints in millimeters */
  minSpacingMm: number;
  
  /** Maximum number of joints allowed per support */
  maxJointCount: number;
  
  /** Distance threshold for magnetic snapping in millimeters */
  snapDistanceMm: number;
  
  /** Movement threshold to break away from snap in millimeters */
  snapBreakThresholdMm: number;
}

/**
 * State for interactive joint creation mode
 */
export interface JointCreationState {
  /** Whether joint creation mode is active (J key held) */
  isActive: boolean;
  
  /** Position of the preview sphere (null if not hovering over shaft) */
  previewPosition: Vec3 | null;
  
  /** ID of the support being targeted for joint creation */
  targetSupportId: string | null;
  
  /** Index of the shaft segment being targeted */
  targetSegmentIndex: number | null;
  
  /** Parameter t (0-1) along the shaft segment for placement */
  segmentParameter: number | null;
}

/**
 * State for joint selection and transformation
 */
export interface JointSelectionState {
  /** ID of the selected joint (null if none selected) */
  selectedJointId: string | null;
  
  /** ID of the support containing the selected joint */
  selectedSupportId: string | null;
  
  /** Whether the gizmo is currently being dragged */
  isDragging: boolean;
  
  /** Original position before drag started (for undo) */
  originalPosition: Vec3 | null;
  
  /** Original ball diameter before scaling (for undo) */
  originalDiameter: number | null;
}

/**
 * Result of a joint placement validation
 */
export interface JointValidationResult {
  /** Whether the placement is valid */
  isValid: boolean;
  
  /** Error message if invalid */
  errorMessage?: string;
  
  /** Warning message (placement is valid but not ideal) */
  warningMessage?: string;
}

/**
 * Parameters for shaft splitting operation
 */
export interface ShaftSplitParams {
  /** ID of the support being modified */
  supportId: string;
  
  /** Index of the segment to split */
  segmentIndex: number;
  
  /** Position along the segment (0-1) where the joint will be placed */
  splitParameter: number;
  
  /** Position in 3D space for the new joint */
  jointPosition: Vec3;
  
  /** Diameter for the new joint ball */
  ballDiameterMm: number;
}

/**
 * Result of a shaft splitting operation
 */
export interface ShaftSplitResult {
  /** The newly created joint */
  newJoint: SupportJoint;
  
  /** Updated segment before the joint */
  lowerSegment: ShaftSegment;
  
  /** New segment after the joint */
  upperSegment: ShaftSegment;
  
  /** All joints in the updated chain */
  updatedJoints: SupportJoint[];
}

/**
 * Parameters for shaft recalculation after joint movement
 */
export interface ShaftRecalculationParams {
  /** ID of the support being modified */
  supportId: string;
  
  /** ID of the joint that was moved */
  movedJointId: string;
  
  /** New position of the moved joint */
  newPosition: Vec3;
  
  /** All joints in the support (for finding adjacent segments) */
  allJoints: SupportJoint[];
  
  /** Tip position (fixed, never moves) */
  tipPosition: Vec3;
  
  /** Base position (fixed, never moves) */
  basePosition: Vec3;
}

/**
 * Result of shaft recalculation
 */
export interface ShaftRecalculationResult {
  /** Updated segments with new directions and rotations */
  updatedSegments: ShaftSegment[];
  
  /** Whether the recalculation was successful */
  success: boolean;
  
  /** Error message if recalculation failed */
  errorMessage?: string;
}

/**
 * Constraint validation for joint angles
 */
export interface AngleConstraintResult {
  /** Whether the angle is within constraints */
  isValid: boolean;
  
  /** Actual angle in degrees */
  angleDeg: number;
  
  /** Maximum allowed angle in degrees */
  maxAngleDeg: number;
  
  /** Error message if constraint violated */
  errorMessage?: string;
}
