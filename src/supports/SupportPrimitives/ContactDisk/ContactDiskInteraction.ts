import { toVec3 } from '@/supports/Curves/BezierUtils';
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


export function recomputeContactConeForMovedDisk(
    cone: ContactCone,
    nextContactPos: Vec3,
    nextSurfaceNormal: Vec3,
    fixedSocketPos?: Vec3,
    collisionMesh?: THREE.Mesh,
): ContactCone {
    // This runs for every trunk/branch/leaf the placement builds, so the axis
    // math is scalar and only the vectors the thickness resolver takes are
    // materialised. The arithmetic is the same `sub`/`normalize` sequence the
    // Vector3 calls performed.
    const socket = fixedSocketPos ?? getFinalSocketPosition(cone);
    const socketX = socket.x;
    const socketY = socket.y;
    const socketZ = socket.z;

    let nx = nextSurfaceNormal.x;
    let ny = nextSurfaceNormal.y;
    let nz = nextSurfaceNormal.z;
    if (nx * nx + ny * ny + nz * nz < 0.000001) {
        nx = 0; ny = 0; nz = 1;
    }
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
    nx /= nl; ny /= nl; nz /= nl;
    const surfaceNormal = new THREE.Vector3(nx, ny, nz);

    // Pass 1: approximate axis from contact point to socket for disk thickness calc
    let ax = socketX - nextContactPos.x;
    let ay = socketY - nextContactPos.y;
    let az = socketZ - nextContactPos.z;
    if (ax * ax + ay * ay + az * az < 0.000001) {
        ax = cone.normal.x; ay = cone.normal.y; az = cone.normal.z;
    }
    if (ax * ax + ay * ay + az * az < 0.000001) {
        ax = nx; ay = ny; az = nz;
    }
    const al = Math.sqrt(ax * ax + ay * ay + az * az);
    ax /= al; ay /= al; az /= al;
    const socketTarget = new THREE.Vector3(socketX, socketY, socketZ);
    const approxAxis = new THREE.Vector3(ax, ay, az);

    const thickness = resolveCollisionAwareDiskThickness(
        cone,
        surfaceNormal,
        approxAxis,
        socketTarget,
        collisionMesh,
    );

    // Cone body starts after the disk offset along surface normal
    const coneStartX = nextContactPos.x + nx * thickness;
    const coneStartY = nextContactPos.y + ny * thickness;
    const coneStartZ = nextContactPos.z + nz * thickness;

    // Pass 2: final axis from coneStart to socket (matches how the renderer applies it)
    let fx = socketX - coneStartX;
    let fy = socketY - coneStartY;
    let fz = socketZ - coneStartZ;
    if (fx * fx + fy * fy + fz * fz < 0.000001) {
        fx = ax; fy = ay; fz = az;
    }
    const fl = Math.sqrt(fx * fx + fy * fy + fz * fz);
    const lengthMm = Math.max(0.05, fl);
    fx /= fl; fy /= fl; fz /= fl;
    const finalAxis = new THREE.Vector3(fx, fy, fz);

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
