import * as THREE from 'three';
import type { ContactCone } from '../ContactCone/types';
import type { ContactDisk, Vec3 } from '../../types';
import { calculateDiskThickness } from './contactDiskUtils';
import { getFinalSocketPosition } from '../ContactCone/contactConeUtils';
import { calculateSafeOffset } from '../../PlacementLogic/CollisionAvoidance';

// Contact cones need to respect the model, but they can sit much closer than
// shafts/roots without causing the oversized detours that a full 0.8mm margin induces.
const CONTACT_CONE_COLLISION_SAFETY_MM = 0.3;
const LEGACY_MAX_STANDOFF_MM = 1.5;
const LEGACY_CLAMPED_MAX_STANDOFF_MM = 0.35;

function resolveCollisionAwareDiskThickness(
    cone: ContactCone,
    surfaceNormal: THREE.Vector3,
    coneAxis: THREE.Vector3,
    socketTarget: THREE.Vector3,
    collisionMesh?: THREE.Mesh,
): number {
    const angleThickness = cone.profile.type === 'disk'
        ? calculateDiskThickness(
            { x: surfaceNormal.x, y: surfaceNormal.y, z: surfaceNormal.z },
            { x: coneAxis.x, y: coneAxis.y, z: coneAxis.z },
            cone.profile,
        )
        : 0;

    if (!collisionMesh || cone.profile.type !== 'disk') {
        return angleThickness;
    }

    const bodyRadius = cone.profile.bodyDiameterMm / 2;
    const rawMaxStandoff = cone.profile.maxStandoffMm ?? LEGACY_MAX_STANDOFF_MM;
    const maxStandoff = rawMaxStandoff === LEGACY_MAX_STANDOFF_MM
        ? LEGACY_CLAMPED_MAX_STANDOFF_MM
        : rawMaxStandoff;

    if (maxStandoff <= angleThickness + 0.000001) {
        return angleThickness;
    }

    const safeThickness = calculateSafeOffset(
        cone.pos,
        { x: surfaceNormal.x, y: surfaceNormal.y, z: surfaceNormal.z },
        { x: socketTarget.x, y: socketTarget.y, z: socketTarget.z },
        bodyRadius + CONTACT_CONE_COLLISION_SAFETY_MM,
        collisionMesh,
        angleThickness,
        maxStandoff,
        0.2,
        {
            startRadius: (cone.profile.contactDiameterMm / 2) + CONTACT_CONE_COLLISION_SAFETY_MM,
            endRadius: bodyRadius + CONTACT_CONE_COLLISION_SAFETY_MM,
        },
    );

    const capEps = 1e-6;
    return safeThickness >= (maxStandoff - capEps)
        ? angleThickness
        : safeThickness;
}

export function toVec3(vector: THREE.Vector3): Vec3 {
    return { x: vector.x, y: vector.y, z: vector.z };
}

export function recomputeContactConeForMovedDisk(
    cone: ContactCone,
    nextContactPos: Vec3,
    nextSurfaceNormal: Vec3,
    fixedSocketPos?: Vec3,
    collisionMesh?: THREE.Mesh,
): ContactCone {
    const socketTarget = fixedSocketPos
        ? new THREE.Vector3(fixedSocketPos.x, fixedSocketPos.y, fixedSocketPos.z)
        : (() => { const p = getFinalSocketPosition(cone); return new THREE.Vector3(p.x, p.y, p.z); })();

    const contactPos = new THREE.Vector3(nextContactPos.x, nextContactPos.y, nextContactPos.z);
    const surfaceNormal = new THREE.Vector3(nextSurfaceNormal.x, nextSurfaceNormal.y, nextSurfaceNormal.z);
    if (surfaceNormal.lengthSq() < 0.000001) {
        surfaceNormal.set(0, 0, 1);
    }
    surfaceNormal.normalize();

    // Pass 1: approximate axis from contact point to socket for disk thickness calc
    let approxAxis = socketTarget.clone().sub(contactPos);
    if (approxAxis.lengthSq() < 0.000001) {
        approxAxis = new THREE.Vector3(cone.normal.x, cone.normal.y, cone.normal.z);
    }
    if (approxAxis.lengthSq() < 0.000001) {
        approxAxis = surfaceNormal.clone();
    }
    approxAxis.normalize();

    const thickness = resolveCollisionAwareDiskThickness(
        cone,
        surfaceNormal,
        approxAxis,
        socketTarget,
        collisionMesh,
    );

    // Cone body starts after the disk offset along surface normal
    const coneStart = contactPos.clone().add(surfaceNormal.clone().multiplyScalar(thickness));

    // Pass 2: final axis from coneStart to socket (matches how the renderer applies it)
    let finalAxis = socketTarget.clone().sub(coneStart);
    if (finalAxis.lengthSq() < 0.000001) {
        finalAxis = approxAxis.clone();
    }
    const lengthMm = Math.max(0.05, finalAxis.length());
    finalAxis.normalize();

    return {
        ...cone,
        pos: nextContactPos,
        surfaceNormal: nextSurfaceNormal,
        normal: toVec3(finalAxis),
        profile: {
            ...cone.profile,
            lengthMm,
        },
        diskLengthOverride: thickness,
    };
}

export function moveDiskKeepingConeConnection(disk: ContactDisk, nextContactPos: Vec3, nextSurfaceNormal: Vec3): ContactDisk {
    const surfaceNormal = new THREE.Vector3(nextSurfaceNormal.x, nextSurfaceNormal.y, nextSurfaceNormal.z);
    if (surfaceNormal.lengthSq() < 0.000001) {
        surfaceNormal.set(0, 0, 1);
    }
    surfaceNormal.normalize();

    const tipAxis = new THREE.Vector3(disk.coneAxis.x, disk.coneAxis.y, disk.coneAxis.z);
    if (tipAxis.lengthSq() < 0.000001) {
        tipAxis.copy(surfaceNormal);
    }
    tipAxis.normalize();

    return {
        ...disk,
        pos: nextContactPos,
        surfaceNormal: toVec3(surfaceNormal),
        coneAxis: toVec3(tipAxis),
        diskLengthOverride: undefined,
    };
}
