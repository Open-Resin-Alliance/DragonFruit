import { toVec3 } from '@/supports/Curves/BezierUtils';
import * as THREE from 'three';
import type { ContactCone } from '../ContactCone/types';
import type { ContactDisk, Vec3 } from '../../types';
import { calculateDiskThickness } from './contactDiskUtils';
import { getFinalSocketPosition } from '../ContactCone/contactConeUtils';
import { calculateSafeOffset } from '../../PlacementLogic/CollisionAvoidance';
import { hasWarmSDFCache } from '../../PlacementLogic/Pathfinding/SDFCachePool';

export interface RecomputeContactConeOptions {
    allowColdCollision?: boolean;
}

// Contact cones need to respect the model, but they can sit much closer than
// shafts/roots without causing the oversized detours that a full 0.8mm margin induces.
const CONTACT_CONE_COLLISION_SAFETY_MM = 0.3;
const LEGACY_MAX_STANDOFF_MM = 1.5;
const LEGACY_CLAMPED_MAX_STANDOFF_MM = 0.35;

/**
 * Collision-aware disk thickness is a pure function of the contact, normal,
 * socket, section and the model mesh. The fan/branch searches ask it repeatedly
 * for the same contact while they choose a host, and moving/resizing a support
 * re-asks it for an unchanged contact; the SDF probe was the hot part.
 */
const diskThicknessCache = new WeakMap<THREE.Mesh, Map<string, number>>();

const _uncollidedAxisScratch: Vec3 = { x: 0, y: 0, z: 0 };

function resolveCollisionAwareDiskThickness(
    cone: ContactCone,
    contactPos: Vec3,
    surfaceNormal: THREE.Vector3,
    socketTarget: THREE.Vector3,
    collisionMesh: THREE.Mesh | undefined,
    uncollidedThickness: number,
    allowColdCollision = true,
): number {
    if (!collisionMesh || cone.profile.type !== 'disk') {
        return uncollidedThickness;
    }

    const bodyRadius = cone.profile.bodyDiameterMm / 2;
    const rawMaxStandoff = cone.profile.maxStandoffMm ?? LEGACY_MAX_STANDOFF_MM;
    const maxStandoff = rawMaxStandoff === LEGACY_MAX_STANDOFF_MM
        ? LEGACY_CLAMPED_MAX_STANDOFF_MM
        : rawMaxStandoff;

    if (maxStandoff <= uncollidedThickness + 1e-6) {
        return uncollidedThickness;
    }

    // The world matrix and geometry are part of the thickness: the same mesh
    // object is reused when the model is moved or its geometry is replaced.
    const meshKey = `${collisionMesh.matrixWorld.elements.join(',')}|${collisionMesh.geometry?.uuid ?? ''}`;
    const cacheKey = `${meshKey}`
        + `|${contactPos.x},${contactPos.y},${contactPos.z}`
        + `|${surfaceNormal.x},${surfaceNormal.y},${surfaceNormal.z}`
        + `|${socketTarget.x},${socketTarget.y},${socketTarget.z}`
        + `|${cone.profile.contactDiameterMm},${cone.profile.bodyDiameterMm}`
        + `|${maxStandoff},${uncollidedThickness}`;
    let cache = diskThicknessCache.get(collisionMesh);
    const cached = cache?.get(cacheKey);
    if (cached !== undefined) return cached;

    if (!allowColdCollision && !hasWarmSDFCache(collisionMesh)) {
        return uncollidedThickness;
    }

    const safeThickness = calculateSafeOffset(
        contactPos,
        { x: surfaceNormal.x, y: surfaceNormal.y, z: surfaceNormal.z },
        { x: socketTarget.x, y: socketTarget.y, z: socketTarget.z },
        bodyRadius + CONTACT_CONE_COLLISION_SAFETY_MM,
        collisionMesh,
        uncollidedThickness,
        maxStandoff,
        0.2,
        {
            startRadius: (cone.profile.contactDiameterMm / 2) + CONTACT_CONE_COLLISION_SAFETY_MM,
            endRadius: bodyRadius + CONTACT_CONE_COLLISION_SAFETY_MM,
        },
    );

    const capEps = 1e-6;
    const thickness = safeThickness >= (maxStandoff - capEps)
        ? uncollidedThickness
        : safeThickness;
    if (!cache) {
        cache = new Map<string, number>();
        diskThicknessCache.set(collisionMesh, cache);
    }
    cache.set(cacheKey, thickness);
    return thickness;
}


export function recomputeContactConeForMovedDisk(
    cone: ContactCone,
    nextContactPos: Vec3,
    nextSurfaceNormal: Vec3,
    fixedSocketPos?: Vec3,
    collisionMesh?: THREE.Mesh,
    options?: RecomputeContactConeOptions,
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

    // Initial axis from contact point to socket
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

    // 3 scalar fixed-point iterations for (uncollidedAxis, uncollidedThickness)
    let ux = ax;
    let uy = ay;
    let uz = az;
    let uncollidedThickness = 0;
    for (let i = 0; i < 3; i++) {
        _uncollidedAxisScratch.x = ux;
        _uncollidedAxisScratch.y = uy;
        _uncollidedAxisScratch.z = uz;
        uncollidedThickness = cone.profile.type === 'disk'
            ? calculateDiskThickness(surfaceNormal, _uncollidedAxisScratch, cone.profile)
            : 0;
        let tx = socketX - (nextContactPos.x + nx * uncollidedThickness);
        let ty = socketY - (nextContactPos.y + ny * uncollidedThickness);
        let tz = socketZ - (nextContactPos.z + nz * uncollidedThickness);
        let tLenSq = tx * tx + ty * ty + tz * tz;
        if (tLenSq < 0.000001) {
            tx = ax; ty = ay; tz = az;
            tLenSq = 1;
        }
        const tl = Math.sqrt(tLenSq);
        ux = tx / tl;
        uy = ty / tl;
        uz = tz / tl;
    }

    const socketTarget = new THREE.Vector3(socketX, socketY, socketZ);
    const thickness = resolveCollisionAwareDiskThickness(
        cone,
        nextContactPos,
        surfaceNormal,
        socketTarget,
        collisionMesh,
        uncollidedThickness,
        options?.allowColdCollision ?? true,
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

    return {
        ...cone,
        pos: nextContactPos,
        surfaceNormal: nextSurfaceNormal,
        normal: { x: fx, y: fy, z: fz },
        profile: {
            ...cone.profile,
            lengthMm,
        },
        diskLengthOverride: thickness > uncollidedThickness + 1e-6 ? thickness : undefined,
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
