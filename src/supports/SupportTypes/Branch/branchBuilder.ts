import * as THREE from 'three';
import { Branch, Joint, Knot, Segment, Vec3 } from '../../types';
import type { ContactCone, SupportTipProfile } from '../../SupportPrimitives/ContactCone/types';
import { getSocketPosition } from '../../SupportPrimitives/ContactCone/contactConeUtils';
import { calculateDiskThickness } from '../../SupportPrimitives/ContactDisk/contactDiskUtils';
import type { SupportData } from '../../rendering/SupportBuilder';
import { getSettings } from '../../Settings';
import { getJointDiameter } from '../../constants';
import { resolveConeAxisPolicy } from '../../PlacementLogic/ConeAxisPolicy';
import { encodeSupportSettingsHex } from '../../Settings/supportSettingsCodec';

function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

export interface BranchBuildInput {
    tipPos: Vec3;
    tipNormal: Vec3;
    modelId: string;
    parentKnot: Knot;
}

export interface BranchBuildResult {
    branch: Branch;
    supportData: SupportData;
}

/**
 * Builds a branch with 2 segments and a middle joint (like trunks):
 * - Starts at the parent knot position
 * - Bottom segment: knot -> middle joint
 * - Top segment: middle joint -> socket joint
 * - Contact cone at the tip
 */
export function buildBranchData(input: BranchBuildInput): BranchBuildResult {
    const { tipPos, tipNormal, modelId, parentKnot } = input;

    const settings = getSettings();
    const settingsCodeHex = encodeSupportSettingsHex(settings);
    const coneAngleMode = settings.tip.coneAngleMode ?? 'normal';
    const adaptiveConeAngleOffsetDeg = settings.tip.adaptiveConeAngleOffsetDeg ?? 30;

    const { coneAxis } = resolveConeAxisPolicy({
        surfaceNormal: tipNormal,
        coneAngleMode,
        adaptiveConeAngleOffsetDeg,
    });

    const effectiveConeAxis = coneAxis ?? tipNormal;
    const tipProfile: SupportTipProfile = {
        type: 'disk',
        contactDiameterMm: settings.tip.contactDiameterMm,
        bodyDiameterMm: settings.tip.bodyDiameterMm,
        lengthMm: settings.tip.lengthMm,
        penetrationMm: settings.tip.penetrationMm,
        diskThicknessMm: 0.1,
        maxStandoffMm: 1.5,
        standoffAngleThreshold: Math.PI / 4,
    };

    const shaftDiameter = settings.shaft.diameterMm;
    const jointDiameter = getJointDiameter(shaftDiameter);

    // Calculate disk offset and socket position (matches renderer logic)
    const diskThickness = tipProfile.type === 'disk'
        ? calculateDiskThickness(tipNormal, effectiveConeAxis, tipProfile)
        : 0;

    const coneStartPos = {
        x: tipPos.x + tipNormal.x * diskThickness,
        y: tipPos.y + tipNormal.y * diskThickness,
        z: tipPos.z + tipNormal.z * diskThickness,
    };

    const socketPos = getSocketPosition(coneStartPos, effectiveConeAxis, tipProfile);
    const socketJoint: Joint = {
        id: uuid(),
        pos: socketPos,
        diameter: jointDiameter,
    };

    // Calculate middle joint position (halfway between knot and socket)
    const knotPos = parentKnot.pos;
    const middleJointPos: Vec3 = {
        x: (knotPos.x + socketPos.x) / 2,
        y: (knotPos.y + socketPos.y) / 2,
        z: (knotPos.z + socketPos.z) / 2,
    };

    const middleJoint: Joint = {
        id: uuid(),
        pos: middleJointPos,
        diameter: jointDiameter,
    };

    // Bottom segment: knot -> middle joint
    const bottomSegment: Segment = {
        id: uuid(),
        diameter: shaftDiameter,
        topJoint: middleJoint,
        bottomJoint: undefined, // Connects to knot
    };

    // Top segment: middle joint -> socket joint
    const topSegment: Segment = {
        id: uuid(),
        diameter: shaftDiameter,
        topJoint: socketJoint,
        bottomJoint: middleJoint,
    };

    const contactCone: ContactCone = {
        id: uuid(),
        pos: tipPos,
        normal: effectiveConeAxis,
        surfaceNormal: tipNormal,
        profile: tipProfile,
        socketJointId: socketJoint.id,
    };

    const branchId = uuid();
    const branch: Branch = {
        id: branchId,
        modelId,
        settingsCodeHex,
        parentKnotId: parentKnot.id,
        segments: [bottomSegment, topSegment],
        contactCone,
    };

    const supportData: SupportData = {
        id: branchId,
        startPos: parentKnot.pos,
        knot: parentKnot,
        segments: [bottomSegment, topSegment],
        contactCone,
    };

    return { branch, supportData };
}
