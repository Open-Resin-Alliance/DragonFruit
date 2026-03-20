import * as THREE from 'three';
import type { ContactCone } from '../ContactCone/types';
import type { ContactDisk, Vec3 } from '../../types';
import { calculateDiskThickness } from './contactDiskUtils';
import { getFinalSocketPosition } from '../ContactCone/contactConeUtils';

export function toVec3(vector: THREE.Vector3): Vec3 {
    return { x: vector.x, y: vector.y, z: vector.z };
}

export function recomputeContactConeForMovedDisk(cone: ContactCone, nextContactPos: Vec3, nextSurfaceNormal: Vec3, fixedSocketPos?: Vec3): ContactCone {
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

    const thickness = cone.profile.type === 'disk'
        ? calculateDiskThickness(nextSurfaceNormal, toVec3(approxAxis), cone.profile)
        : 0;

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
