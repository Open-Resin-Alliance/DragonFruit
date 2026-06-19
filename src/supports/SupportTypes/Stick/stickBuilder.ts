import * as THREE from 'three';
import { Joint, Segment, Stick, Vec3, LimitationCode } from '../../types';
import type { ContactCone, SupportTipProfile } from '../../SupportPrimitives/ContactCone/types';
import { getSocketPosition } from '../../SupportPrimitives/ContactCone/contactConeUtils';
import { calculateDiskThickness } from '../../SupportPrimitives/ContactDisk/contactDiskUtils';
import { getSettings } from '../../Settings';
import { getJointDiameter } from '../../constants';
import { isShaftBlocked, isCollisionFrustumBlocked } from '../../PlacementLogic/CollisionAvoidance';
import { clampConeAxisDeviationFromSurfaceNormal } from '../../PlacementLogic/ConeAxisPolicy';

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
    mesh?: THREE.Mesh;
}

export interface StickBuildResult {
    stick: Stick;
    error?: LimitationCode;
}

const GEOMETRY_EPSILON = 0.000001;

function toVec3(vector: THREE.Vector3): Vec3 {
    return { x: vector.x, y: vector.y, z: vector.z };
}

export function buildStick(input: StickBuildInput): StickBuildResult {
    const { modelId, aPos, aNormal, bPos, bNormal, mesh } = input;

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

    const surfaceNormalA = new THREE.Vector3(aNormal.x, aNormal.y, aNormal.z);
    if (surfaceNormalA.lengthSq() < GEOMETRY_EPSILON) surfaceNormalA.set(0, 0, 1);
    surfaceNormalA.normalize();

    const surfaceNormalB = new THREE.Vector3(bNormal.x, bNormal.y, bNormal.z);
    if (surfaceNormalB.lengthSq() < GEOMETRY_EPSILON) surfaceNormalB.set(0, 0, 1);
    surfaceNormalB.normalize();

    const coneAxisA = new THREE.Vector3(
        bPos.x - aPos.x,
        bPos.y - aPos.y,
        bPos.z - aPos.z,
    );
    if (coneAxisA.lengthSq() < GEOMETRY_EPSILON) {
        coneAxisA.copy(surfaceNormalA);
    }
    coneAxisA.normalize();

    const coneAxisB = coneAxisA.clone().multiplyScalar(-1);
    const coneStartA = new THREE.Vector3();
    const coneStartB = new THREE.Vector3();
    let diskThicknessA = 0;
    let diskThicknessB = 0;

    // Match trunk behavior more closely: the disk stays glued to the local
    // surface normal, but the cone body is allowed to cant toward the bridge.
    for (let pass = 0; pass < 2; pass += 1) {
        const clampedAxisA = clampConeAxisDeviationFromSurfaceNormal(
            toVec3(surfaceNormalA),
            toVec3(coneAxisA),
        );
        coneAxisA.set(clampedAxisA.x, clampedAxisA.y, clampedAxisA.z);

        const clampedAxisB = clampConeAxisDeviationFromSurfaceNormal(
            toVec3(surfaceNormalB),
            toVec3(coneAxisB),
        );
        coneAxisB.set(clampedAxisB.x, clampedAxisB.y, clampedAxisB.z);

        diskThicknessA = tipProfile.type === 'disk'
            ? calculateDiskThickness(toVec3(surfaceNormalA), toVec3(coneAxisA), tipProfile)
            : 0;
        diskThicknessB = tipProfile.type === 'disk'
            ? calculateDiskThickness(toVec3(surfaceNormalB), toVec3(coneAxisB), tipProfile)
            : 0;

        coneStartA.set(aPos.x, aPos.y, aPos.z).addScaledVector(surfaceNormalA, diskThicknessA);
        coneStartB.set(bPos.x, bPos.y, bPos.z).addScaledVector(surfaceNormalB, diskThicknessB);

        const bridgeAxis = coneStartB.clone().sub(coneStartA);
        if (bridgeAxis.lengthSq() < GEOMETRY_EPSILON) break;

        bridgeAxis.normalize();
        coneAxisA.copy(bridgeAxis);
        coneAxisB.copy(bridgeAxis).multiplyScalar(-1);
    }

    const finalClampedAxisA = clampConeAxisDeviationFromSurfaceNormal(
        toVec3(surfaceNormalA),
        toVec3(coneAxisA),
    );
    coneAxisA.set(finalClampedAxisA.x, finalClampedAxisA.y, finalClampedAxisA.z);

    const finalClampedAxisB = clampConeAxisDeviationFromSurfaceNormal(
        toVec3(surfaceNormalB),
        toVec3(coneAxisB),
    );
    coneAxisB.set(finalClampedAxisB.x, finalClampedAxisB.y, finalClampedAxisB.z);

    const socketA = getSocketPosition(toVec3(coneStartA), toVec3(coneAxisA), tipProfile);
    const socketB = getSocketPosition(toVec3(coneStartB), toVec3(coneAxisB), tipProfile);

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
        normal: toVec3(coneAxisA),
        surfaceNormal: toVec3(surfaceNormalA),
        diskLengthOverride: diskThicknessA,
        profile: tipProfile,
        socketJointId: socketJointA.id,
    };

    const contactConeB: ContactCone = {
        id: uuid(),
        pos: bPos,
        normal: toVec3(coneAxisB),
        surfaceNormal: toVec3(surfaceNormalB),
        diskLengthOverride: diskThicknessB,
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

    let error: LimitationCode | undefined = undefined;
    if (mesh) {
        const shaftRadius = shaftDiameter / 2;
        const contactRadius = tipProfile.contactDiameterMm / 2;
        const bodyRadius = tipProfile.bodyDiameterMm / 2;

        // 1. Check shaft segment (SDF adaptive sphere tracing — zero BVH
        //    overhead when precomputed SDF grid is loaded)
        const segmentBlocked = isShaftBlocked(socketA, socketB, shaftRadius, mesh);

        // 2. Check both contact cones as tapered frustums
        const coneABlocked = isCollisionFrustumBlocked(
            aPos, socketA, contactRadius, bodyRadius, mesh,
        );
        const coneBBlocked = isCollisionFrustumBlocked(
            bPos, socketB, contactRadius, bodyRadius, mesh,
        );

        if (segmentBlocked || coneABlocked || coneBBlocked) {
            error = 'COLLISION_WITH_MODEL';
        }
    }

    return { stick, error };
}
