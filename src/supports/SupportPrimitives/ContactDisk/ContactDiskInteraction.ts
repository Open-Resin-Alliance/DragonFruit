import { toVec3 } from '@/supports/Curves/BezierUtils';
import * as THREE from 'three';
import type { ContactCone } from '../ContactCone/types';
import type { ContactDisk, Vec3 } from '../../types';
import { calculateDiskThickness } from './contactDiskUtils';
import { getFinalSocketPosition } from '../ContactCone/contactConeUtils';
import { calculateSafeOffset } from '../../PlacementLogic/CollisionAvoidance';
import { computeThinWallMaxSafePenetrationMm } from '../../PlacementLogic/PlacementNormalSynthesis';
import { hasWarmSDFCache } from '../../PlacementLogic/Pathfinding/SDFCachePool';

export interface RecomputeContactConeOptions {
    allowColdCollision?: boolean;
    cornerMeta?: { thetaSpreadRad: number; isConcave: boolean };
    edgeSafeguards?: boolean;
}

// Contact cones need to respect the model, but they can sit much closer than
// shafts/roots without causing the oversized detours that a full 0.8mm margin induces.
const CONTACT_CONE_COLLISION_SAFETY_MM = 0.3;
const LEGACY_MAX_STANDOFF_MM = 1.5;
const LEGACY_CLAMPED_MAX_STANDOFF_MM = 0.35;
const PEN_A2_MIN_CONCAVE_SPREAD_RAD = THREE.MathUtils.degToRad(15);
const SAFE_B_MIN_CORNER_SPREAD_RAD = THREE.MathUtils.degToRad(35);

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
    effectiveMinThickness: number,
    allowColdCollision = true,
    edgeSafeguards = false,
    effectiveCornerMeta?: { thetaSpreadRad: number; isConcave: boolean },
    hasFixedSocket = false,
): number {
    if (!collisionMesh || cone.profile.type !== 'disk') {
        return effectiveMinThickness;
    }

    const bodyRadius = cone.profile.bodyDiameterMm / 2;
    const rawMaxStandoff = cone.profile.maxStandoffMm ?? LEGACY_MAX_STANDOFF_MM;
    const baseMaxStandoff = rawMaxStandoff === LEGACY_MAX_STANDOFF_MM
        ? LEGACY_CLAMPED_MAX_STANDOFF_MM
        : rawMaxStandoff;
    const useCornerExactSweep = edgeSafeguards
        && effectiveCornerMeta !== undefined
        && effectiveCornerMeta.thetaSpreadRad >= SAFE_B_MIN_CORNER_SPREAD_RAD;
    const shiftTargetRigidly = useCornerExactSweep && !hasFixedSocket;
    const maxOffsetScale = useCornerExactSweep && effectiveCornerMeta?.isConcave ? Math.SQRT2 : 1;
    const effectiveMaxStandoff = baseMaxStandoff * maxOffsetScale;

    if (effectiveMaxStandoff <= effectiveMinThickness + 1e-6) {
        return effectiveMinThickness;
    }

    // The world matrix and geometry are part of the thickness: the same mesh
    // object is reused when the model is moved or its geometry is replaced.
    const meshKey = `${collisionMesh.matrixWorld.elements.join(',')}|${collisionMesh.geometry?.uuid ?? ''}`;
    const baseCacheKey = `${meshKey}`
        + `|${contactPos.x},${contactPos.y},${contactPos.z}`
        + `|${surfaceNormal.x},${surfaceNormal.y},${surfaceNormal.z}`
        + `|${socketTarget.x},${socketTarget.y},${socketTarget.z}`
        + `|${cone.profile.contactDiameterMm},${cone.profile.bodyDiameterMm}`
        + `|${baseMaxStandoff},${uncollidedThickness}`;
    const cacheKey = edgeSafeguards
        ? `${baseCacheKey}|es:${useCornerExactSweep ? 1 : 0}|sh:${shiftTargetRigidly ? 1 : 0}|ms:${effectiveMaxStandoff}|em:${effectiveMinThickness}`
        : baseCacheKey;
    let cache = diskThicknessCache.get(collisionMesh);
    const cached = cache?.get(cacheKey);
    if (cached !== undefined) return cached;

    if (!allowColdCollision && !hasWarmSDFCache(collisionMesh)) {
        return effectiveMinThickness;
    }

    const surfaceNormalObj = { x: surfaceNormal.x, y: surfaceNormal.y, z: surfaceNormal.z };
    const socketTargetObj = { x: socketTarget.x, y: socketTarget.y, z: socketTarget.z };
    const capEps = 1e-6;
    let thickness: number;
    if (useCornerExactSweep) {
        const safeThickness = calculateSafeOffset(
            contactPos,
            surfaceNormalObj,
            socketTargetObj,
            bodyRadius,
            collisionMesh,
            effectiveMinThickness,
            baseMaxStandoff,
            0.05,
            undefined,
            {
                useExactContactConeSweep: true,
                exactConeRadii: {
                    startRadius: Math.max(0.001, cone.profile.contactDiameterMm / 2),
                    endRadius: Math.max(0.001, bodyRadius),
                },
                shiftTargetRigidly,
                maxOffsetScale,
            },
        );
        thickness = safeThickness >= (effectiveMaxStandoff - capEps)
            ? effectiveMinThickness
            : safeThickness;
    } else {
        const safeThickness = calculateSafeOffset(
            contactPos,
            surfaceNormalObj,
            socketTargetObj,
            bodyRadius + CONTACT_CONE_COLLISION_SAFETY_MM,
            collisionMesh,
            effectiveMinThickness,
            baseMaxStandoff,
            0.2,
            {
                startRadius: (cone.profile.contactDiameterMm / 2) + CONTACT_CONE_COLLISION_SAFETY_MM,
                endRadius: bodyRadius + CONTACT_CONE_COLLISION_SAFETY_MM,
            },
        );
        thickness = safeThickness >= (baseMaxStandoff - capEps)
            ? effectiveMinThickness
            : safeThickness;
    }
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

    // Scalar fixed-point iterations for (uncollidedAxis, uncollidedThickness),
    // breaking once consecutive thicknesses agree within 1e-13 mm.
    let ux = ax;
    let uy = ay;
    let uz = az;
    let uncollidedThickness = 0;
    const diskProfile = cone.profile.type === 'disk' ? cone.profile : null;
    if (diskProfile) {
        const setAxisScratchForOffset = (offset: number): void => {
            let tx = socketX - (nextContactPos.x + nx * offset);
            let ty = socketY - (nextContactPos.y + ny * offset);
            let tz = socketZ - (nextContactPos.z + nz * offset);
            let tLenSq = tx * tx + ty * ty + tz * tz;
            if (tLenSq < 0.000001) {
                tx = ax; ty = ay; tz = az;
                tLenSq = 1;
            }
            const tl = Math.sqrt(tLenSq);
            _uncollidedAxisScratch.x = tx / tl;
            _uncollidedAxisScratch.y = ty / tl;
            _uncollidedAxisScratch.z = tz / tl;
        };

        let converged = false;
        for (let i = 0; i < 32; i++) {
            _uncollidedAxisScratch.x = ux;
            _uncollidedAxisScratch.y = uy;
            _uncollidedAxisScratch.z = uz;
            const nextThickness = calculateDiskThickness(surfaceNormal, _uncollidedAxisScratch, diskProfile);
            const diff = Math.abs(nextThickness - uncollidedThickness);
            uncollidedThickness = nextThickness;
            setAxisScratchForOffset(uncollidedThickness);
            ux = _uncollidedAxisScratch.x;
            uy = _uncollidedAxisScratch.y;
            uz = _uncollidedAxisScratch.z;
            if (i > 0 && diff <= 1e-13) {
                converged = true;
                break;
            }
        }

        // Bisection fallback for slow-contracting short oblique cones that do not hit 1e-13 in 32 Picard steps.
        if (!converged) {
            _uncollidedAxisScratch.x = -nx;
            _uncollidedAxisScratch.y = -ny;
            _uncollidedAxisScratch.z = -nz;
            let lo = 0;
            let hi = Math.max(
                uncollidedThickness,
                calculateDiskThickness(surfaceNormal, _uncollidedAxisScratch, diskProfile),
            );
            setAxisScratchForOffset(lo);
            const fLo = calculateDiskThickness(surfaceNormal, _uncollidedAxisScratch, diskProfile) - lo;
            setAxisScratchForOffset(hi);
            const fHi = calculateDiskThickness(surfaceNormal, _uncollidedAxisScratch, diskProfile) - hi;
            if (fLo >= 0 && fHi <= 0) {
                for (let b = 0; b < 52; b++) {
                    const mid = 0.5 * (lo + hi);
                    setAxisScratchForOffset(mid);
                    if (calculateDiskThickness(surfaceNormal, _uncollidedAxisScratch, diskProfile) - mid >= 0) {
                        lo = mid;
                    } else {
                        hi = mid;
                    }
                    if (hi - lo <= 1e-15) break;
                }
                setAxisScratchForOffset(0.5 * (lo + hi));
                ux = _uncollidedAxisScratch.x;
                uy = _uncollidedAxisScratch.y;
                uz = _uncollidedAxisScratch.z;
            }
        }

        // Re-evaluate on the final converged (ux, uy, uz) so uncollidedThickness matches finalAxis within < 1e-15 mm.
        _uncollidedAxisScratch.x = ux;
        _uncollidedAxisScratch.y = uy;
        _uncollidedAxisScratch.z = uz;
        uncollidedThickness = calculateDiskThickness(surfaceNormal, _uncollidedAxisScratch, diskProfile);
    }

    const edgeSafeguards = options?.edgeSafeguards === true;
    const dx = cone.pos.x - nextContactPos.x;
    const dy = cone.pos.y - nextContactPos.y;
    const dz = cone.pos.z - nextContactPos.z;
    const keepCapAnchor = cone.capAnchor !== undefined && (dx * dx + dy * dy + dz * dz) <= 1e-6;
    const effectiveCornerMeta = edgeSafeguards
        ? (options?.cornerMeta ?? (keepCapAnchor && cone.capAnchor
            ? { thetaSpreadRad: cone.capAnchor.thetaSpreadRad, isConcave: cone.capAnchor.isConcave }
            : undefined))
        : undefined;

    let effectiveMinThickness = uncollidedThickness;
    if (
        edgeSafeguards
        && diskProfile
        && effectiveCornerMeta?.isConcave
        && effectiveCornerMeta.thetaSpreadRad >= PEN_A2_MIN_CONCAVE_SPREAD_RAD
    ) {
        const rawMaxStandoff = diskProfile.maxStandoffMm ?? LEGACY_MAX_STANDOFF_MM;
        const baseMaxStandoff = rawMaxStandoff === LEGACY_MAX_STANDOFF_MM
            ? LEGACY_CLAMPED_MAX_STANDOFF_MM
            : rawMaxStandoff;
        const rContact = Math.max(0.001, diskProfile.contactDiameterMm / 2);
        const concaveFloor = Math.min(
            baseMaxStandoff,
            rContact / Math.max(0.5, Math.cos(effectiveCornerMeta.thetaSpreadRad)),
        );
        effectiveMinThickness = Math.max(uncollidedThickness, concaveFloor);
    }

    const shiftTargetRigidly = edgeSafeguards
        && effectiveCornerMeta !== undefined
        && effectiveCornerMeta.thetaSpreadRad >= SAFE_B_MIN_CORNER_SPREAD_RAD
        && fixedSocketPos === undefined;
    const baseShift = shiftTargetRigidly && effectiveMinThickness > uncollidedThickness + 1e-6
        ? effectiveMinThickness - uncollidedThickness
        : 0;
    const socketTarget = new THREE.Vector3(
        socketX + nx * baseShift,
        socketY + ny * baseShift,
        socketZ + nz * baseShift,
    );
    const thickness = resolveCollisionAwareDiskThickness(
        cone,
        nextContactPos,
        surfaceNormal,
        socketTarget,
        collisionMesh,
        uncollidedThickness,
        effectiveMinThickness,
        options?.allowColdCollision ?? true,
        edgeSafeguards,
        effectiveCornerMeta,
        fixedSocketPos !== undefined,
    );

    // Cone body starts after the disk offset along surface normal
    const coneStartX = nextContactPos.x + nx * thickness;
    const coneStartY = nextContactPos.y + ny * thickness;
    const coneStartZ = nextContactPos.z + nz * thickness;

    const socketShift = shiftTargetRigidly && thickness > uncollidedThickness + 1e-6
        ? thickness - uncollidedThickness
        : 0;
    const effectiveSocketX = socketX + nx * socketShift;
    const effectiveSocketY = socketY + ny * socketShift;
    const effectiveSocketZ = socketZ + nz * socketShift;

    // Pass 2: final axis from coneStart to socket (matches how the renderer applies it)
    let fx = effectiveSocketX - coneStartX;
    let fy = effectiveSocketY - coneStartY;
    let fz = effectiveSocketZ - coneStartZ;
    if (fx * fx + fy * fy + fz * fz < 0.000001) {
        fx = ax; fy = ay; fz = az;
    }
    const fl = Math.sqrt(fx * fx + fy * fy + fz * fz);
    const lengthMm = Math.max(0.05, fl);
    fx /= fl; fy /= fl; fz /= fl;

    const nextProfile = {
        ...cone.profile,
        lengthMm,
    };
    if (edgeSafeguards && collisionMesh && (options?.allowColdCollision ?? true)) {
        const maxSafePen = computeThinWallMaxSafePenetrationMm(
            collisionMesh,
            nextContactPos,
            surfaceNormal,
        );
        if (typeof maxSafePen === 'number') {
            nextProfile.maxSafePenetrationMm = maxSafePen;
        } else {
            delete nextProfile.maxSafePenetrationMm;
        }
    }

    return {
        ...cone,
        pos: nextContactPos,
        surfaceNormal: nextSurfaceNormal,
        capAnchor: keepCapAnchor ? cone.capAnchor : undefined,
        normal: { x: fx, y: fy, z: fz },
        profile: nextProfile,
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
