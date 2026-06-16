import * as THREE from 'three';
import type { Leaf, Knot, Vec3 } from '../../types';
import type { ContactCone, SupportTipProfile } from '../../SupportPrimitives/ContactCone/types';
import { recomputeContactConeForMovedDisk } from '../../SupportPrimitives/ContactDisk';
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
    mesh?: THREE.Mesh;
}

export interface LeafBuildResult {
    leaf: Leaf;
    supportData: SupportData;
}

// Pooled scratch vectors — reused across calls to avoid per-frame GC pressure.
const _tip = new THREE.Vector3();
const _sn = new THREE.Vector3();
const _knot = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _start = new THREE.Vector3();
const _coneVec = new THREE.Vector3();

function computeLeafConeAxisAndLength(
    tipPos: Vec3,
    surfaceNormal: Vec3,
    knotPos: Vec3,
    baseProfile: SupportTipProfile,
    mesh?: THREE.Mesh,
): { axis: Vec3; lengthMm: number; diskThicknessMm: number } {
    const cone = recomputeContactConeForMovedDisk(
        {
            id: 'preview-leaf-cone',
            pos: tipPos,
            normal: surfaceNormal,
            surfaceNormal,
            profile: baseProfile,
        },
        tipPos,
        surfaceNormal,
        knotPos,
        mesh,
    );

    return {
        axis: cone.normal,
        lengthMm: cone.profile.lengthMm,
        diskThicknessMm: cone.diskLengthOverride ?? 0,
    };
}

export function buildLeafData(input: LeafBuildInput): LeafBuildResult {
    const { tipPos, surfaceNormal, modelId, parentKnot, hostDiameterMm, mesh } = input;

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
        baseProfile,
        mesh,
    );

    const profile: SupportTipProfile = {
        ...baseProfile,
        lengthMm,
        bodyDiameterMm: hostDiameterMm,
    };

    const contactCone: ContactCone = {
        ...recomputeContactConeForMovedDisk(
            {
                id: 'leaf-cone',
                pos: tipPos,
                normal: axis,
                surfaceNormal,
                profile,
            },
            tipPos,
            surfaceNormal,
            parentKnot.pos,
            mesh,
        ),
        id: uuid(),
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
