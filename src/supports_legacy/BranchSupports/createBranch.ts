import { SupportInstance, SupportSettings } from '@/supports_legacy/types';
import { generateSupportId } from '@/supports_legacy/state';
import * as THREE from 'three';

export interface CreateBranchArgs {
    tip: { x: number; y: number; z: number };
    tipNormal: { x: number; y: number; z: number };
    base: { x: number; y: number; z: number };
    trunkId: string;
    settings: SupportSettings;
    parentShaftDiameter?: number;
}

/**
 * Creates a new branch support instance with standard joint structure:
 * - Tip Joint (at socket face)
 * - Mid Joint (halfway)
 * - Branch Joint (at base, locked to trunk)
 */
export function createBranch({
    tip,
    tipNormal,
    base,
    trunkId,
    settings,
    parentShaftDiameter
}: CreateBranchArgs): SupportInstance {
    const tipLength = settings.tip.lengthMm;

    // Base normal points from base toward tip (along shaft direction)
    const shaftDir = {
        x: tip.x - base.x,
        y: tip.y - base.y,
        z: tip.z - base.z,
    };
    const shaftLen = Math.sqrt(shaftDir.x * shaftDir.x + shaftDir.y * shaftDir.y + shaftDir.z * shaftDir.z) || 1;
    const baseNormal = {
        x: shaftDir.x / shaftLen,
        y: shaftDir.y / shaftLen,
        z: shaftDir.z / shaftLen,
    };

    // Calculate tipEnd (base of contact cone where shaft starts)
    const tipEndPos = {
        x: tip.x + tipNormal.x * tipLength,
        y: tip.y + tipNormal.y * tipLength,
        z: tip.z + tipNormal.z * tipLength,
    };

    // Create tip joint at tipEnd (base of contact cone) - standard joint
    const shaftDiameter = settings.mid.diameterMm;
    const jointDiameter = shaftDiameter + 0.1;
    const tipJoint = {
        id: `${generateSupportId()}-joint-0-${Date.now()}`,
        position: tipEndPos,
        ballDiameterMm: jointDiameter,
        order: 0,
        isTipJoint: true,
        type: 'standard' as const,
        updatedAt: Date.now(),
    };

    // Determine branch joint diameter
    const branchJointDiameter = (parentShaftDiameter || shaftDiameter) + 0.1;

    // Create middle joint on shaft (halfway between tip joint and branch joint)
    const midPosition = {
        x: (tipEndPos.x + base.x) / 2,
        y: (tipEndPos.y + base.y) / 2,
        z: (tipEndPos.z + base.z) / 2,
    };
    const midJoint = {
        id: `${generateSupportId()}-joint-1-${Date.now()}`,
        position: midPosition,
        ballDiameterMm: jointDiameter,
        order: 1,
        isTipJoint: false,
        type: 'standard' as const,
        updatedAt: Date.now(),
    };

    // Create branch joint at base (locked to parent support shaft) - yellow, larger
    const branchJoint = {
        id: `${generateSupportId()}-joint-2-${Date.now()}`,
        position: base,
        ballDiameterMm: branchJointDiameter,
        order: 2,
        isTipJoint: false,
        type: 'branch' as const,
        lockedToSupportId: trunkId,
        updatedAt: Date.now(),
    };

    // Create branch support instance
    return {
        id: generateSupportId(),
        objectIdTip: null, // Branch tip touches model
        objectIdBase: null, // Branch base attaches to support (not plate)
        tip,
        tipNormal,
        base,
        baseNormal,
        gridNodeIndex: null,
        isBaseTip: false,
        isInFill: false,
        isVisible: true,
        collisionIsAccepted: false,
        isCollidingWithObject: false,
        parentBaseId: trunkId, // Reference to parent support
        parentTipId: null,
        parentIds: [trunkId],
        group: null,
        tags: ['branch'],
        updatedAt: Date.now(),
        type: 1,
        settings,
        joints: [tipJoint, midJoint, branchJoint], // Tip joint + middle joint + branch joint at base
    };
}

/**
 * Helper to regenerate joints for an existing branch support.
 * Preserves the ID of the existing tip joint if possible.
 */
export function regenerateBranchJoints(
    currentSupport: SupportInstance,
    newBase: { x: number; y: number; z: number },
    trunkId: string,
    parentShaftDiameter?: number
) {
    const settings = currentSupport.settings;
    const tip = currentSupport.tip;
    const tipNormal = currentSupport.tipNormal;
    const tipLength = settings.tip.lengthMm;

    // Reuse logic from createBranch but we only need the joints
    // And we want to preserve IDs if possible

    // Calculate tipEnd
    const tipEndPos = {
        x: tip.x + tipNormal.x * tipLength,
        y: tip.y + tipNormal.y * tipLength,
        z: tip.z + tipNormal.z * tipLength,
    };

    const shaftDiameter = settings.mid.diameterMm;
    const jointDiameter = shaftDiameter + 0.1;

    // Find existing tip joint to preserve ID
    const existingTipJoint = currentSupport.joints?.find(j => j.isTipJoint);

    const tipJoint = {
        id: existingTipJoint?.id || `${generateSupportId()}-joint-0-${Date.now()}`,
        position: tipEndPos,
        ballDiameterMm: existingTipJoint?.ballDiameterMm || jointDiameter,
        order: 0,
        isTipJoint: true,
        type: 'standard' as const,
        updatedAt: Date.now(),
    };

    const branchJointDiameter = (parentShaftDiameter || shaftDiameter) + 0.1;

    const midPosition = {
        x: (tipEndPos.x + newBase.x) / 2,
        y: (tipEndPos.y + newBase.y) / 2,
        z: (tipEndPos.z + newBase.z) / 2,
    };

    const midJoint = {
        id: `${generateSupportId()}-joint-1-${Date.now()}`,
        position: midPosition,
        ballDiameterMm: jointDiameter,
        order: 1,
        isTipJoint: false,
        type: 'standard' as const,
        updatedAt: Date.now(),
    };

    const branchJoint = {
        id: `${generateSupportId()}-joint-2-${Date.now()}`,
        position: newBase,
        ballDiameterMm: branchJointDiameter,
        order: 2,
        isTipJoint: false,
        type: 'branch' as const,
        lockedToSupportId: trunkId,
        updatedAt: Date.now(),
    };

    return [tipJoint, midJoint, branchJoint];
}
