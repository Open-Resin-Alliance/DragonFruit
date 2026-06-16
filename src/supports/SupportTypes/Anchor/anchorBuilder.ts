import type { Anchor, Joint, Vec3 } from '../../types';
import type { ContactCone, SupportTipProfile } from '../../SupportPrimitives/ContactCone/types';
import type { SupportData } from '../../rendering/SupportBuilder';
import type * as THREE from 'three';
import { recomputeContactConeForMovedDisk } from '../../SupportPrimitives/ContactDisk';
import { getSettings } from '../../Settings';
import { resolveConeAxisPolicy } from '../../PlacementLogic/ConeAxisPolicy';
import { encodeSupportSettingsHex } from '../../Settings/supportSettingsCodec';
import { generateUuid } from '../../../utils/uuid';
import { getRaftSettings } from '../../Rafts/Crenelated/RaftState';

const ANCHOR_ROOT_BASE_DIAMETER_MM = 2.0;
const ANCHOR_ROOT_TOP_DIAMETER_MM = 1.5;
const ANCHOR_ROOT_HEIGHT_MM = 1.0;
const ANCHOR_JOINT_DIAMETER_MM = 1.5;

export interface AnchorBuildInput {
    tipPos: Vec3;
    tipNormal: Vec3;
    modelId: string;
    mesh?: THREE.Mesh;
}

export interface AnchorBuildResult {
    anchor: Anchor;
    supportData: SupportData;
}

export function buildAnchorData(input: AnchorBuildInput): AnchorBuildResult {
    const { tipPos, tipNormal, modelId, mesh } = input;

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

    // Compute raft vertical offset (must match RootsRenderer logic)
    const raft = getRaftSettings();
    const hasSolidBottom = raft.bottomMode === 'solid';
    const raftThickness = raft.thickness ?? 0;
    const ANCHOR_DISK_HEIGHT_MM = 0.1;
    const effectiveDiskHeight = hasSolidBottom ? 0.05 : ANCHOR_DISK_HEIGHT_MM;
    const verticalOffset = hasSolidBottom ? Math.max(raftThickness - effectiveDiskHeight, 0) : 0;

    // Sphere center Z = verticalOffset + effectiveDiskHeight + coneHeight
    // (sphere center is at top of cone, not offset by radius)
    const targetSocketZ = verticalOffset + effectiveDiskHeight + ANCHOR_ROOT_HEIGHT_MM;
    const dzPerUnit = effectiveConeAxis.z;
    const coneLength = Math.abs(dzPerUnit) > 1e-6
        ? (targetSocketZ - tipPos.z) / dzPerUnit
        : tipProfile.lengthMm; // fallback if cone axis is nearly horizontal

    // Use the stretched length (but never shorter than the default)
    const effectiveConeLength = Math.max(coneLength, tipProfile.lengthMm);

    const guessedSocketPos: Vec3 = {
        x: tipPos.x + effectiveConeAxis.x * effectiveConeLength,
        y: tipPos.y + effectiveConeAxis.y * effectiveConeLength,
        z: tipPos.z + effectiveConeAxis.z * effectiveConeLength,
    };
    const authoredCone = recomputeContactConeForMovedDisk(
        {
            id: 'preview-anchor-cone',
            pos: tipPos,
            normal: effectiveConeAxis,
            surfaceNormal: tipNormal,
            profile: {
                ...tipProfile,
                lengthMm: effectiveConeLength,
                bodyDiameterMm: ANCHOR_JOINT_DIAMETER_MM - 0.1,
            },
        },
        tipPos,
        tipNormal,
        guessedSocketPos,
        mesh,
    );
    const socketPos: Vec3 = {
        x: authoredCone.pos.x + (authoredCone.surfaceNormal?.x ?? tipNormal.x) * (authoredCone.diskLengthOverride ?? 0) + authoredCone.normal.x * authoredCone.profile.lengthMm,
        y: authoredCone.pos.y + (authoredCone.surfaceNormal?.y ?? tipNormal.y) * (authoredCone.diskLengthOverride ?? 0) + authoredCone.normal.y * authoredCone.profile.lengthMm,
        z: authoredCone.pos.z + (authoredCone.surfaceNormal?.z ?? tipNormal.z) * (authoredCone.diskLengthOverride ?? 0) + authoredCone.normal.z * authoredCone.profile.lengthMm,
    };

    // Root and joint are positioned at the socket XY, vertical stack
    const rootPos: Vec3 = { x: socketPos.x, y: socketPos.y, z: 0 };
    const jointPos: Vec3 = { x: socketPos.x, y: socketPos.y, z: targetSocketZ };
    const joint: Joint = {
        id: generateUuid(),
        pos: jointPos,
        diameter: ANCHOR_JOINT_DIAMETER_MM,
    };

    const socketJoint: Joint = {
        id: generateUuid(),
        pos: socketPos,
        diameter: ANCHOR_JOINT_DIAMETER_MM,
    };

    // Override profile: stretched length + body diameter matches joint
    const anchorTipProfile: SupportTipProfile = {
        ...tipProfile,
        lengthMm: effectiveConeLength,
        bodyDiameterMm: ANCHOR_JOINT_DIAMETER_MM - 0.1,
    };

    const contactCone: ContactCone = {
        ...authoredCone,
        id: generateUuid(),
        socketJointId: socketJoint.id,
    };

    const anchorId = generateUuid();
    const anchor: Anchor = {
        id: anchorId,
        modelId,
        settingsCodeHex,
        rootPos,
        rootBaseDiameter: ANCHOR_ROOT_BASE_DIAMETER_MM,
        rootTopDiameter: ANCHOR_ROOT_TOP_DIAMETER_MM,
        rootHeight: ANCHOR_ROOT_HEIGHT_MM,
        joint,
        segments: [],
        contactCone,
    };

    const supportData: SupportData = {
        id: anchorId,
        segments: [],
        contactCone,
    };

    return { anchor, supportData };
}
