import * as THREE from 'three';
import { ContactDisk, Joint, Segment, Twig, Vec3 } from '../../types';
import type { ContactDiskProfile } from '../../SupportPrimitives/ContactCone/types';
import { calculateDiskThickness } from '../../SupportPrimitives/ContactDisk/contactDiskUtils';
import { getSettings } from '../../Settings';
import { getJointDiameter } from '../../constants';

function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

export interface TwigBuildInput {
    modelId: string;
    aPos: Vec3;
    aNormal: Vec3;
    bPos: Vec3;
    bNormal: Vec3;
}

export interface TwigBuildResult {
    twig: Twig;
}

export function buildTwig(input: TwigBuildInput): TwigBuildResult {
    const { modelId, aPos, aNormal, bPos, bNormal } = input;

    const settings = getSettings();

    const diskProfile: ContactDiskProfile = {
        type: 'disk',
        diskThicknessMm: settings.tip.diskThicknessMm ?? 0.1,
        maxStandoffMm: settings.tip.maxStandoffMm ?? 1.5,
        standoffAngleThreshold: settings.tip.standoffAngleThreshold ?? Math.PI / 4,
    };

    // Twig rule: shaft diameter equals tip contact diameter (thin connector)
    const shaftDiameter = settings.tip.contactDiameterMm;
    const jointDiameter = getJointDiameter(shaftDiameter);

    const aVec = new THREE.Vector3(aPos.x, aPos.y, aPos.z);
    const bVec = new THREE.Vector3(bPos.x, bPos.y, bPos.z);

    let axisA = bVec.clone().sub(aVec);
    if (axisA.lengthSq() < 0.000001) axisA = new THREE.Vector3(0, 0, 1);
    axisA.normalize();
    const axisB = axisA.clone().multiplyScalar(-1);

    const diskThicknessA = calculateDiskThickness(aNormal, { x: axisA.x, y: axisA.y, z: axisA.z }, diskProfile);
    const diskThicknessB = calculateDiskThickness(bNormal, { x: axisB.x, y: axisB.y, z: axisB.z }, diskProfile);

    // Shaft connects to the center of the disk tip sphere at each end.
    const jointPosA: Vec3 = {
        x: aPos.x + aNormal.x * diskThicknessA,
        y: aPos.y + aNormal.y * diskThicknessA,
        z: aPos.z + aNormal.z * diskThicknessA,
    };

    const jointPosB: Vec3 = {
        x: bPos.x + bNormal.x * diskThicknessB,
        y: bPos.y + bNormal.y * diskThicknessB,
        z: bPos.z + bNormal.z * diskThicknessB,
    };

    const socketJointA: Joint = {
        id: uuid(),
        pos: jointPosA,
        diameter: jointDiameter,
    };

    const socketJointB: Joint = {
        id: uuid(),
        pos: jointPosB,
        diameter: jointDiameter,
    };

    const segment: Segment = {
        id: uuid(),
        diameter: shaftDiameter,
        bottomJoint: socketJointA,
        topJoint: socketJointB,
    };

    const contactDiskA: ContactDisk = {
        id: uuid(),
        pos: aPos,
        surfaceNormal: aNormal,
        profile: diskProfile,
        contactDiameterMm: settings.tip.contactDiameterMm,
        diskLengthOverride: undefined,
        coneAxis: { x: axisA.x, y: axisA.y, z: axisA.z },
    };

    const contactDiskB: ContactDisk = {
        id: uuid(),
        pos: bPos,
        surfaceNormal: bNormal,
        profile: diskProfile,
        contactDiameterMm: settings.tip.contactDiameterMm,
        diskLengthOverride: undefined,
        coneAxis: { x: axisB.x, y: axisB.y, z: axisB.z },
    };

    const twigId = uuid();
    const twig: Twig = {
        id: twigId,
        modelId,
        segments: [segment],
        contactDiskA,
        contactDiskB,
    };

    return { twig };
}
