import * as THREE from 'three';
import { ContactDisk, Joint, Segment, Twig, Vec3, LimitationCode } from '../../types';
import type { ContactDiskProfile } from '../../SupportPrimitives/ContactCone/types';
import { getSettings } from '../../Settings';
import { twigDiskJointStandoff } from './twigJointStandoff';
import { twigJointDiameterForLocalDiameter } from './twigTaper';
// DEBUG: temporary per-twig disk B diameter override. Remove with src/supports/__debug__/.
import { getTwigDiskBOverrideMm } from '../../__debug__/twigDiameterOverride';
import { checkShaftCollision } from '../../PlacementLogic/CollisionUtils';

// Twig-local sizing: a joint at a disk-end is 10% larger than that disk's
// contact diameter. SSOT for the 10% rule lives in ./twigTaper.ts.
function twigJointDiameterForDisk(diskContactDiameter: number): number {
    return twigJointDiameterForLocalDiameter(diskContactDiameter);
}

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
    mesh?: THREE.Mesh;
}

export interface TwigBuildResult {
    twig: Twig;
    error?: LimitationCode;
}

// Pooled scratch vectors — reused across calls to avoid per-frame GC pressure.
const _aVec = new THREE.Vector3();
const _bVec = new THREE.Vector3();
const _axisA = new THREE.Vector3();
const _axisB = new THREE.Vector3();

export function buildTwig(input: TwigBuildInput): TwigBuildResult {
    const { modelId, aPos, aNormal, bPos, bNormal, mesh } = input;

    const settings = getSettings();

    const diskProfile: ContactDiskProfile = {
        type: 'disk',
        diskThicknessMm: settings.tip.diskThicknessMm ?? 0.1,
        maxStandoffMm: settings.tip.maxStandoffMm ?? 1.5,
        standoffAngleThreshold: settings.tip.standoffAngleThreshold ?? Math.PI / 4,
    };

    // Twig sizing rule: each disk drives its own joint, and the shaft tapers
    // between the two joints. Disk A keeps using the global tip.contactDiameterMm;
    // disk B can be overridden via the temporary debug control to test taper.
    const diskAContactDiameter = settings.tip.contactDiameterMm;
    const diskBOverride = getTwigDiskBOverrideMm();
    const diskBContactDiameter = diskBOverride ?? settings.tip.contactDiameterMm;

    const jointDiameterA = twigJointDiameterForDisk(diskAContactDiameter);
    const jointDiameterB = twigJointDiameterForDisk(diskBContactDiameter);

    // Legacy uniform value for slicer/proxy and any consumer that reads
    // segment.diameter. The actual visible taper is carried per-end by the
    // joints and applied by TwigRenderer.
    const shaftDiameter = settings.tip.contactDiameterMm;

    _aVec.set(aPos.x, aPos.y, aPos.z);
    _bVec.set(bPos.x, bPos.y, bPos.z);

    _axisA.copy(_bVec).sub(_aVec);
    if (_axisA.lengthSq() < 0.000001) _axisA.set(0, 0, 1);
    _axisA.normalize();
    _axisB.copy(_axisA).multiplyScalar(-1);

    // Joint stand-off scales with joint diameter so a large disk-end joint
    // never punches through the model.
    const diskThicknessA = twigDiskJointStandoff({
        surfaceNormal: aNormal,
        coneAxis: { x: _axisA.x, y: _axisA.y, z: _axisA.z },
        profile: diskProfile,
        jointDiameterMm: jointDiameterA,
    });
    const diskThicknessB = twigDiskJointStandoff({
        surfaceNormal: bNormal,
        coneAxis: { x: _axisB.x, y: _axisB.y, z: _axisB.z },
        profile: diskProfile,
        jointDiameterMm: jointDiameterB,
    });

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
        diameter: jointDiameterA,
    };

    const socketJointB: Joint = {
        id: uuid(),
        pos: jointPosB,
        diameter: jointDiameterB,
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
        contactDiameterMm: diskAContactDiameter,
        diskLengthOverride: diskThicknessA,
        coneAxis: { x: _axisA.x, y: _axisA.y, z: _axisA.z },
    };

    const contactDiskB: ContactDisk = {
        id: uuid(),
        pos: bPos,
        surfaceNormal: bNormal,
        profile: diskProfile,
        contactDiameterMm: diskBContactDiameter,
        diskLengthOverride: diskThicknessB,
        coneAxis: { x: _axisB.x, y: _axisB.y, z: _axisB.z },
    };

        const twigId = uuid();
    const twig: Twig = {
        id: twigId,
        modelId,
        segments: [segment],
        contactDiskA,
        contactDiskB,
    };

    let error: LimitationCode | undefined = undefined;
    if (mesh) {
        const shaftRadius = shaftDiameter / 2;
        
        // 1. Check segment
        const segmentBlocked = checkShaftCollision(socketJointA.pos, socketJointB.pos, shaftRadius, mesh).hit;
        
        // 2. Check contact disks with tip-ignore offset
        const normalA = new THREE.Vector3(aNormal.x, aNormal.y, aNormal.z).normalize();
        const distA = new THREE.Vector3(socketJointA.pos.x - aPos.x, socketJointA.pos.y - aPos.y, socketJointA.pos.z - aPos.z).length();
        const offsetA = Math.min(0.25, distA * 0.5);
        const startA = new THREE.Vector3(aPos.x, aPos.y, aPos.z).add(normalA.multiplyScalar(offsetA));
        const avgRadiusA = (diskAContactDiameter + jointDiameterA) / 4;
        const diskABlocked = checkShaftCollision(startA, socketJointA.pos, avgRadiusA, mesh).hit;

        const normalB = new THREE.Vector3(bNormal.x, bNormal.y, bNormal.z).normalize();
        const distB = new THREE.Vector3(socketJointB.pos.x - bPos.x, socketJointB.pos.y - bPos.y, socketJointB.pos.z - bPos.z).length();
        const offsetB = Math.min(0.25, distB * 0.5);
        const startB = new THREE.Vector3(bPos.x, bPos.y, bPos.z).add(normalB.multiplyScalar(offsetB));
        const avgRadiusB = (diskBContactDiameter + jointDiameterB) / 4;
        const diskBBlocked = checkShaftCollision(startB, socketJointB.pos, avgRadiusB, mesh).hit;
        
        if (segmentBlocked || diskABlocked || diskBBlocked) {
            error = 'COLLISION_WITH_MODEL';
        }
    }

    return { twig, error };
}
