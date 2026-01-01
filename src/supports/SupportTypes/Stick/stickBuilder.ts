import * as THREE from 'three';
import { Joint, Segment, Stick, Vec3 } from '../../types';
import type { ContactCone, SupportTipProfile } from '../../SupportPrimitives/ContactCone/types';
import { getSocketPosition } from '../../SupportPrimitives/ContactCone/contactConeUtils';
import { calculateDiskThickness } from '../../SupportPrimitives/ContactDisk/contactDiskUtils';
import { getSettings } from '../../Settings';
import { getJointDiameter } from '../../constants';

function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

export interface StickBuildInput {
    modelId: string;
    aPos: Vec3;
    aNormal: Vec3;
    bPos: Vec3;
    bNormal: Vec3;
}

export interface StickBuildResult {
    stick: Stick;
}

export function buildStick(input: StickBuildInput): StickBuildResult {
    const { modelId, aPos, aNormal, bPos, bNormal } = input;

    const settings = getSettings();

    const tipProfile: SupportTipProfile = {
        type: 'disk',
        contactDiameterMm: settings.tip.contactDiameterMm,
        bodyDiameterMm: settings.tip.bodyDiameterMm,
        lengthMm: settings.tip.lengthMm,
        penetrationMm: settings.tip.penetrationMm,
        diskThicknessMm: settings.tip.diskThicknessMm ?? 0.1,
        maxStandoffMm: settings.tip.maxStandoffMm ?? 1.5,
        standoffAngleThreshold: settings.tip.standoffAngleThreshold ?? Math.PI / 4,
    };

    // Stick rule: use regular support shaft diameter logic
    const shaftDiameter = settings.shaft.diameterMm;
    const jointDiameter = getJointDiameter(shaftDiameter);

    const diskThicknessA = tipProfile.type === 'disk'
        ? calculateDiskThickness(aNormal, aNormal, tipProfile)
        : 0;

    const coneStartA = {
        x: aPos.x + aNormal.x * diskThicknessA,
        y: aPos.y + aNormal.y * diskThicknessA,
        z: aPos.z + aNormal.z * diskThicknessA,
    };

    const socketA = getSocketPosition(coneStartA, aNormal, tipProfile);

    const diskThicknessB = tipProfile.type === 'disk'
        ? calculateDiskThickness(bNormal, bNormal, tipProfile)
        : 0;

    const coneStartB = {
        x: bPos.x + bNormal.x * diskThicknessB,
        y: bPos.y + bNormal.y * diskThicknessB,
        z: bPos.z + bNormal.z * diskThicknessB,
    };

    const socketB = getSocketPosition(coneStartB, bNormal, tipProfile);

    const socketJointA: Joint = {
        id: uuid(),
        pos: socketA,
        diameter: jointDiameter,
    };

    const socketJointB: Joint = {
        id: uuid(),
        pos: socketB,
        diameter: jointDiameter,
    };

    const segment: Segment = {
        id: uuid(),
        diameter: shaftDiameter,
        bottomJoint: socketJointA,
        topJoint: socketJointB,
    };

    const contactConeA: ContactCone = {
        id: uuid(),
        pos: aPos,
        normal: aNormal,
        surfaceNormal: aNormal,
        profile: tipProfile,
        socketJointId: socketJointA.id,
    };

    const contactConeB: ContactCone = {
        id: uuid(),
        pos: bPos,
        normal: bNormal,
        surfaceNormal: bNormal,
        profile: tipProfile,
        socketJointId: socketJointB.id,
    };

    // Normalize ordering so the ID/joint ordering is deterministic across equivalent inputs.
    const a = new THREE.Vector3(aPos.x, aPos.y, aPos.z);
    const b = new THREE.Vector3(bPos.x, bPos.y, bPos.z);
    const swap = a.z > b.z || (a.z === b.z && (a.y > b.y || (a.y === b.y && a.x > b.x)));

    const stickId = uuid();
    const stick: Stick = {
        id: stickId,
        modelId,
        segments: [segment],
        contactConeA: swap ? contactConeB : contactConeA,
        contactConeB: swap ? contactConeA : contactConeB,
    };

    return { stick };
}
