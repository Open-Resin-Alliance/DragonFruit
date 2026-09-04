import * as THREE from 'three';
import { ContactDisk, Joint, Segment, Twig, Vec3, LimitationCode } from '../../types';
import type { ContactDiskProfile } from '../../SupportPrimitives/ContactCone/types';
import { getSettings } from '../../Settings/state';
import { twigDiskJointStandoff } from './twigJointStandoff';
import { twigJointDiameterForLocalDiameter } from './twigTaper';
import { isShaftBlocked, isCollisionFrustumBlocked } from '../../PlacementLogic/CollisionAvoidance';
import { clampConeAxisDeviationFromSurfaceNormal } from '../../PlacementLogic/ConeAxisPolicy';
import { v4 as uuidv4 } from 'uuid';

// Twig-local sizing: a joint at a disk-end is 10% larger than that disk's
// contact diameter. SSOT for the 10% rule lives in ./twigTaper.ts.
function twigJointDiameterForDisk(diskContactDiameter: number): number {
    return twigJointDiameterForLocalDiameter(diskContactDiameter);
}

export interface TwigBuildInput {
    modelId: string;
    aPos: Vec3;
    aNormal: Vec3;
    bPos: Vec3;
    bNormal: Vec3;
    mesh?: THREE.Mesh;
    /** Auto-support tier tip contact — absent for manual placement. */
    tipContactDiameterMm?: number;
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

    // Twig sizing rule: both disk ends share one diameter — twigs are
    // CYLINDRICAL. Slightly smaller than the global tip contact (twigs are
    // short, low-span supports). An earlier change scaled the free (B) end
    // down with span, which accidentally rendered every twig as a cone;
    // equal ends is the intended geometry (the taper machinery in
    // twigTaper.ts still works — with equal ends it degenerates to a
    // cylinder).
    const diskAContactDiameter = (input.tipContactDiameterMm ?? settings.tip.contactDiameterMm) * 0.9;
    const diskBContactDiameter = diskAContactDiameter;

    const jointDiameterA = twigJointDiameterForDisk(diskAContactDiameter);
    const jointDiameterB = twigJointDiameterForDisk(diskBContactDiameter);

    // Legacy uniform value for slicer/proxy and any consumer that reads
    // segment.diameter. The actual visible taper is carried per-end by the
    // joints and applied by TwigRenderer.
    const shaftDiameter = diskAContactDiameter;

    _aVec.set(aPos.x, aPos.y, aPos.z);
    _bVec.set(bPos.x, bPos.y, bPos.z);

    _axisA.copy(_bVec).sub(_aVec);
    if (_axisA.lengthSq() < 0.000001) _axisA.set(0, 0, 1);
    _axisA.normalize();
    _axisB.copy(_axisA).multiplyScalar(-1);

    const clampedAxisA = clampConeAxisDeviationFromSurfaceNormal(
        aNormal,
        { x: _axisA.x, y: _axisA.y, z: _axisA.z },
    );
    _axisA.set(clampedAxisA.x, clampedAxisA.y, clampedAxisA.z);

    const clampedAxisB = clampConeAxisDeviationFromSurfaceNormal(
        bNormal,
        { x: _axisB.x, y: _axisB.y, z: _axisB.z },
    );
    _axisB.set(clampedAxisB.x, clampedAxisB.y, clampedAxisB.z);

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
        id: uuidv4(),
        pos: jointPosA,
        diameter: jointDiameterA,
    };

    const socketJointB: Joint = {
        id: uuidv4(),
        pos: jointPosB,
        diameter: jointDiameterB,
    };

    const segment: Segment = {
        id: uuidv4(),
        diameter: shaftDiameter,
        bottomJoint: socketJointA,
        topJoint: socketJointB,
    };

    const contactDiskA: ContactDisk = {
        id: uuidv4(),
        pos: aPos,
        surfaceNormal: aNormal,
        profile: diskProfile,
        contactDiameterMm: diskAContactDiameter,
        diskLengthOverride: diskThicknessA,
        coneAxis: { x: _axisA.x, y: _axisA.y, z: _axisA.z },
    };

    const contactDiskB: ContactDisk = {
        id: uuidv4(),
        pos: bPos,
        surfaceNormal: bNormal,
        profile: diskProfile,
        contactDiameterMm: diskBContactDiameter,
        diskLengthOverride: diskThicknessB,
        coneAxis: { x: _axisB.x, y: _axisB.y, z: _axisB.z },
    };

        const twigId = uuidv4();
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

        // 1. Check shaft segment (SDF adaptive sphere tracing)
        const segmentBlocked = isShaftBlocked(
            socketJointA.pos, socketJointB.pos, shaftRadius, mesh,
        );

        // 2. Check contact disks as tapered frustums (disk surface → joint)
        const diskABlocked = isCollisionFrustumBlocked(
            aPos, socketJointA.pos,
            diskAContactDiameter / 2, jointDiameterA / 2, mesh,
        );
        const diskBBlocked = isCollisionFrustumBlocked(
            bPos, socketJointB.pos,
            diskBContactDiameter / 2, jointDiameterB / 2, mesh,
        );

        if (segmentBlocked || diskABlocked || diskBBlocked) {
            error = 'COLLISION_WITH_MODEL';
        }
    }

    return { twig, error };
}
