import { SupportInstance, SupportSettings } from '@/supports_legacy/types';
import { generateSupportId } from '@/supports_legacy/state';

export interface CreateLeafArgs {
  contactPoint: { x: number; y: number; z: number };
  contactNormal: { x: number; y: number; z: number };
  socketPoint: { x: number; y: number; z: number };
  socketNormal: { x: number; y: number; z: number };
  parentSupportId: string;
  settings: SupportSettings;
}

/**
 * Creates a new leaf support instance.
 * A leaf is just a contact cone with no shaft, joints, or base.
 * - Contact face (small end): touches the model
 * - Socket face (large end): snaps to parent support
 */
export function createLeaf({
  contactPoint,
  contactNormal,
  socketPoint,
  socketNormal,
  parentSupportId,
  settings,
}: CreateLeafArgs): SupportInstance {
  // Leaf uses the tip profile for the contact cone geometry
  // The "tip" is the contact face (small end) on the model
  // The "base" is the socket face (large end) on the parent support
  
  // Base normal points from socket toward contact (along cone axis)
  const coneDir = {
    x: contactPoint.x - socketPoint.x,
    y: contactPoint.y - socketPoint.y,
    z: contactPoint.z - socketPoint.z,
  };
  const coneLen = Math.sqrt(coneDir.x * coneDir.x + coneDir.y * coneDir.y + coneDir.z * coneDir.z) || 1;
  const baseNormal = {
    x: coneDir.x / coneLen,
    y: coneDir.y / coneLen,
    z: coneDir.z / coneLen,
  };

  // Calculate joint diameter (shaft diameter + 0.1mm for proper visual connection)
  const shaftDiameter = settings.mid.diameterMm;
  const jointDiameter = shaftDiameter + 0.1;

  // Create the leaf joint at the socket point (large end)
  // This joint snaps to the parent support and can slide along its shaft
  const leafJoint = {
    id: `${generateSupportId()}-joint-leaf-${Date.now()}`,
    position: socketPoint,
    ballDiameterMm: jointDiameter,
    order: 0,
    isTipJoint: false,
    type: 'leaf' as const, // New joint type for leaf supports
    lockedToSupportId: parentSupportId, // Locked to parent support
    updatedAt: Date.now(),
  };

  // Create leaf support instance
  return {
    id: generateSupportId(),
    objectIdTip: null, // Leaf tip touches model
    objectIdBase: null, // Leaf base attaches to support (not plate)
    tip: contactPoint,
    tipNormal: contactNormal,
    base: socketPoint,
    baseNormal,
    gridNodeIndex: null,
    isBaseTip: false,
    isInFill: false,
    isVisible: true,
    collisionIsAccepted: false,
    isCollidingWithObject: false,
    parentBaseId: parentSupportId, // Reference to parent support
    parentTipId: null,
    parentIds: [parentSupportId],
    group: null,
    tags: ['leaf'],
    updatedAt: Date.now(),
    type: 2, // Type 2 for leaf supports (type 1 is branch)
    settings,
    joints: [leafJoint], // Single leaf joint at socket end
  };
}
