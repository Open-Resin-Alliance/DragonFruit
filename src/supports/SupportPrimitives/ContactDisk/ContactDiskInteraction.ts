import * as THREE from 'three';
import type { ContactCone } from '../ContactCone/types';
import type { ContactDisk, Vec3 } from '../../types';
import { calculateDiskThickness } from './contactDiskUtils';

export function toVec3(vector: THREE.Vector3): Vec3 {
    return { x: vector.x, y: vector.y, z: vector.z };
}

export function recomputeContactConeForMovedDisk(cone: ContactCone, nextContactPos: Vec3, nextSurfaceNormal: Vec3): ContactCone {
    const socketPos = new THREE.Vector3(
        cone.pos.x + cone.normal.x * cone.profile.lengthMm,
        cone.pos.y + cone.normal.y * cone.profile.lengthMm,
        cone.pos.z + cone.normal.z * cone.profile.lengthMm,
    );

    const contactPos = new THREE.Vector3(nextContactPos.x, nextContactPos.y, nextContactPos.z);
    const surfaceNormal = new THREE.Vector3(nextSurfaceNormal.x, nextSurfaceNormal.y, nextSurfaceNormal.z);
    if (surfaceNormal.lengthSq() < 0.000001) {
        surfaceNormal.set(0, 0, 1);
    }
    surfaceNormal.normalize();

    let axis = socketPos.clone().sub(contactPos);
    if (axis.lengthSq() < 0.000001) {
        axis = new THREE.Vector3(cone.normal.x, cone.normal.y, cone.normal.z);
    }
    if (axis.lengthSq() < 0.000001) {
        axis = surfaceNormal.clone();
    }
    axis.normalize();

    const thickness = cone.profile.type === 'disk'
        ? calculateDiskThickness(nextSurfaceNormal, toVec3(axis), cone.profile)
        : 0;

    const coneStart = contactPos.clone().add(surfaceNormal.clone().multiplyScalar(thickness));
    const lengthMm = Math.max(0.05, socketPos.distanceTo(coneStart));

    return {
        ...cone,
        pos: nextContactPos,
        surfaceNormal: nextSurfaceNormal,
        normal: toVec3(axis),
        profile: {
            ...cone.profile,
            lengthMm,
        },
        diskLengthOverride: undefined,
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
