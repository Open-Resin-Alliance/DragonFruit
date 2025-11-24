/**
 * Joint Factory Functions
 * 
 * Functions for creating and initializing joint objects.
 * Provides defaults and ensures consistent joint creation.
 */

import { Vec3, SupportInstance, SupportSettings } from '../types';
import { SupportJoint } from './types';
import { distributePointsAlongSegment } from './geometry';

/**
 * Generates a unique ID for a joint.
 * 
 * @param supportId - ID of the parent support
 * @param order - Order of the joint in the chain
 * @returns Unique joint ID
 */
export function generateJointId(supportId: string, order: number): string {
  return `${supportId}-joint-${order}-${Date.now()}`;
}

/**
 * Creates a new joint with default values.
 * 
 * @param params - Partial joint parameters
 * @returns Complete joint object
 */
export function createJoint(params: {
  position: Vec3;
  ballDiameterMm: number;
  order: number;
  id?: string;
  rotation?: Vec3;
  parentSegmentId?: string;
  childSegmentId?: string;
}): SupportJoint {
  return {
    id: params.id || generateJointId('temp', params.order),
    position: params.position,
    rotation: params.rotation,
    ballDiameterMm: params.ballDiameterMm,
    parentSegmentId: params.parentSegmentId,
    childSegmentId: params.childSegmentId,
    order: params.order,
    updatedAt: Date.now(),
  };
}

/**
 * Creates default joints for a new support based on settings.
 * Distributes joints evenly along the shaft from base to tip.
 * 
 * @param support - Support instance
 * @param settings - Support settings (contains defaultJointCount)
 * @returns Array of joints
 */
export function createDefaultJoints(
  support: SupportInstance,
  settings: SupportSettings
): SupportJoint[] {
  const jointCount = settings.jointDefaults?.defaultJointCount ?? 0;
  
  if (jointCount <= 0) {
    return [];
  }
  
  // Distribute joint positions evenly along the shaft
  const positions = distributePointsAlongSegment(
    support.base,
    support.tip,
    jointCount
  );
  
  // Create joint objects
  const joints: SupportJoint[] = positions.map((position, index) => {
    return createJoint({
      id: generateJointId(support.id, index),
      position,
      ballDiameterMm: settings.jointDefaults?.ballDiameterMm ?? 1.5,
      order: index,
    });
  });
  
  return joints;
}

/**
 * Creates a deep copy of a joint.
 * 
 * @param joint - Joint to clone
 * @returns Cloned joint
 */
export function cloneJoint(joint: SupportJoint): SupportJoint {
  return {
    id: joint.id,
    position: { ...joint.position },
    rotation: joint.rotation ? { ...joint.rotation } : undefined,
    ballDiameterMm: joint.ballDiameterMm,
    parentSegmentId: joint.parentSegmentId,
    childSegmentId: joint.childSegmentId,
    order: joint.order,
    updatedAt: Date.now(),
  };
}

/**
 * Updates a joint's position.
 * 
 * @param joint - Joint to update
 * @param newPosition - New position
 * @returns Updated joint
 */
export function updateJointPosition(
  joint: SupportJoint,
  newPosition: Vec3
): SupportJoint {
  return {
    ...joint,
    position: newPosition,
    updatedAt: Date.now(),
  };
}

/**
 * Updates a joint's ball diameter.
 * 
 * @param joint - Joint to update
 * @param newDiameter - New diameter in millimeters
 * @returns Updated joint
 */
export function updateJointDiameter(
  joint: SupportJoint,
  newDiameter: number
): SupportJoint {
  return {
    ...joint,
    ballDiameterMm: newDiameter,
    updatedAt: Date.now(),
  };
}

/**
 * Creates joints from serialized data (for loading from file).
 * 
 * @param data - Array of joint data objects
 * @returns Array of joint objects
 */
export function deserializeJoints(data: any[]): SupportJoint[] {
  if (!Array.isArray(data)) {
    return [];
  }
  
  return data.map((item, index) => ({
    id: item.id || generateJointId('loaded', index),
    position: item.position || { x: 0, y: 0, z: 0 },
    rotation: item.rotation,
    ballDiameterMm: item.ballDiameterMm || 1.5,
    parentSegmentId: item.parentSegmentId,
    childSegmentId: item.childSegmentId,
    order: item.order ?? index,
    updatedAt: item.updatedAt || Date.now(),
  }));
}

/**
 * Serializes joints for saving to file.
 * 
 * @param joints - Array of joints
 * @returns Serializable array
 */
export function serializeJoints(joints: SupportJoint[]): any[] {
  return joints.map(joint => ({
    id: joint.id,
    position: joint.position,
    rotation: joint.rotation,
    ballDiameterMm: joint.ballDiameterMm,
    parentSegmentId: joint.parentSegmentId,
    childSegmentId: joint.childSegmentId,
    order: joint.order,
    updatedAt: joint.updatedAt,
  }));
}
