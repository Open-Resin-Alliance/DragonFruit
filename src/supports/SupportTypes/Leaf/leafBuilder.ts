import * as THREE from 'three';
import type { Leaf, Knot, Vec3 } from '../../types';
import type { ContactCone, SupportTipProfile } from '../../SupportPrimitives/ContactCone/types';
import { calculateDiskThickness } from '../../SupportPrimitives/ContactDisk/contactDiskUtils';
import type { SupportData } from '../../rendering/SupportBuilder';
import { getSettings } from '../../Settings';
import { encodeSupportSettingsHex } from '../../Settings/supportSettingsCodec';

function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

export interface LeafBuildInput {
    tipPos: Vec3;
    surfaceNormal: Vec3;
    modelId: string;
    parentKnot: Knot;
    hostDiameterMm: number;
}

export interface LeafBuildResult {
    leaf: Leaf;
    supportData: SupportData;
}

function computeLeafConeAxisAndLength(
    tipPos: Vec3,
    surfaceNormal: Vec3,
    knotPos: Vec3,
    baseProfile: SupportTipProfile
): { axis: Vec3; lengthMm: number; diskThicknessMm: number } {
    const tip = new THREE.Vector3(tipPos.x, tipPos.y, tipPos.z);
    const sn = new THREE.Vector3(surfaceNormal.x, surfaceNormal.y, surfaceNormal.z);
    const knot = new THREE.Vector3(knotPos.x, knotPos.y, knotPos.z);

    let axis = knot.clone().sub(tip);
    if (axis.lengthSq() < 0.000001) {
        axis.set(sn.x, sn.y, sn.z);
    }
    axis.normalize();

    let finalThickness = 0;
    let finalLength = Math.max(0.1, knot.distanceTo(tip));

    for (let i = 0; i < 3; i++) {
        const axisVec3 = { x: axis.x, y: axis.y, z: axis.z };
        const thickness = baseProfile.type === 'disk'
            ? calculateDiskThickness(surfaceNormal, axisVec3, baseProfile)
            : 0;
        finalThickness = thickness;

        const start = tip.clone().add(sn.clone().multiplyScalar(thickness));
        const coneVec = knot.clone().sub(start);
        const len = coneVec.length();
        if (len > 0.000001) {
            axis = coneVec.normalize();
            finalLength = Math.max(0.1, len);
        }
    }

    return {
        axis: { x: axis.x, y: axis.y, z: axis.z },
        lengthMm: finalLength,
        diskThicknessMm: finalThickness,
    };
}

export function buildLeafData(input: LeafBuildInput): LeafBuildResult {
    const { tipPos, surfaceNormal, modelId, parentKnot, hostDiameterMm } = input;

    const settings = getSettings();
    const settingsCodeHex = encodeSupportSettingsHex(settings);

    const baseProfile: SupportTipProfile = {
        type: 'disk',
        contactDiameterMm: settings.tip.contactDiameterMm,
        bodyDiameterMm: hostDiameterMm,
        lengthMm: settings.tip.lengthMm,
        penetrationMm: settings.tip.penetrationMm,
        diskThicknessMm: 0.1,
        maxStandoffMm: 1.5,
        standoffAngleThreshold: Math.PI / 4,
    };

    const { axis, lengthMm } = computeLeafConeAxisAndLength(
        tipPos,
        surfaceNormal,
        parentKnot.pos,
        baseProfile
    );

    const profile: SupportTipProfile = {
        ...baseProfile,
        lengthMm,
        bodyDiameterMm: hostDiameterMm,
    };

    const contactCone: ContactCone = {
        id: uuid(),
        pos: tipPos,
        normal: axis,
        surfaceNormal,
        profile,
    };

    const leafId = uuid();
    const leaf: Leaf = {
        id: leafId,
        modelId,
        settingsCodeHex,
        parentKnotId: parentKnot.id,
        contactCone,
    };

    const supportData: SupportData = {
        id: leafId,
        segments: [],
        knot: parentKnot,
        contactCone,
    };

    return { leaf, supportData };
}
