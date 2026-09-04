import * as THREE from 'three';
import type { Leaf, Knot, Vec3 } from '../../types';
import type { ContactCone, SupportTipProfile } from '../../SupportPrimitives/ContactCone/types';
import { recomputeContactConeForMovedDisk } from '../../SupportPrimitives/ContactDisk';
import type { SupportData } from '../../rendering/SupportBuilder';
import { getSettings } from '../../Settings/state';
import { applySizingOverridesToSettings } from '../../autoSupport/parameterSizing';
import { encodeSupportSettingsHex } from '../../Settings/supportSettingsCodec';
import { v4 as uuidv4 } from 'uuid';

export interface LeafBuildInput {
    tipPos: Vec3;
    surfaceNormal: Vec3;
    modelId: string;
    parentKnot: Knot;
    hostDiameterMm: number;
    /** Auto-support tier tip contact — absent for manual placement. */
    tipContactDiameterMm?: number;
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
    // Auto-support tier override — absent for manual placement (global band).
    const tipContactDiameterMm = input.tipContactDiameterMm ?? settings.tip.contactDiameterMm;
    const settingsCodeHex = encodeSupportSettingsHex(applySizingOverridesToSettings(settings, {
        tipContactDiameterMm: input.tipContactDiameterMm,
        tipBodyDiameterMm: input.hostDiameterMm,
    }));

    const baseProfile: SupportTipProfile = {
        type: 'disk',
        contactDiameterMm: tipContactDiameterMm,
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
        id: uuidv4(),
    };

    const leafId = uuidv4();
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
