/**
 * Leaf Support Types
 * 
 * Leaves are minimal contact-cone-only supports that connect a parent support to the model.
 * They have no shaft, joints, or base - just the contact cone with two faces:
 * - Contact face (small end): touches the model
 * - Socket face (large end): snaps to parent support
 */

import { Vec3 } from '../types';

export interface LeafPlacementState {
  isActive: boolean;
  contactPoint: Vec3 | null;      // First click: contact face on model
  contactNormal: Vec3 | null;     // Normal at contact point
  socketPoint: Vec3 | null;       // Second click: socket face position
  socketNormal: Vec3 | null;      // Normal at socket point
  parentSupportId: string | null; // Support that the socket snaps to
  snapPoint: Vec3 | null;         // Actual snap position on parent
  snapNormal: Vec3 | null;        // Normal at snap position
}

export interface LeafPreviewData {
  contactPoint: Vec3;
  contactNormal: Vec3;
  socketPoint: Vec3;
  socketNormal: Vec3;
  parentSupportId: string | null;
}
