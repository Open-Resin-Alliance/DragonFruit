import * as THREE from 'three';
import { modelGeometryOf } from '../autoSupport/meshStore';
import { getSettings } from '../Settings/state';
import {
    synthesizePlacementNormal,
    type PlacementNormalSynthesisResult,
} from './PlacementNormalSynthesis';

// Pooled scratch objects — reused across calls to avoid per-frame GC pressure.
const _nA = new THREE.Vector3();
const _nB = new THREE.Vector3();
const _nC = new THREE.Vector3();
const _pA = new THREE.Vector3();
const _pB = new THREE.Vector3();
const _pC = new THREE.Vector3();
const _tri = new THREE.Triangle();
const _bary = new THREE.Vector3();
const _interpolated = new THREE.Vector3();
const _normalMatrix = new THREE.Matrix3();
const _synthTarget: PlacementNormalSynthesisResult = {
    normal: new THREE.Vector3(),
    regime: 'raw',
    acceptedSphereTris: 0,
};

export interface CalculateSmoothedNormalOptions {
    contactRadiusMm?: number;
    prevNormal?: { x: number; y: number; z: number } | THREE.Vector3;
    isDiskHudDrag?: boolean;
    forceRaw?: boolean;
}

function localNormalToWorld(
    nx: number,
    ny: number,
    nz: number,
    object?: THREE.Object3D | null,
): { x: number, y: number, z: number } {
    _interpolated.set(nx, ny, nz);
    if (object?.matrixWorld) {
        _normalMatrix.getNormalMatrix(object.matrixWorld);
        _interpolated.applyNormalMatrix(_normalMatrix);
        if (_interpolated.lengthSq() === 0) {
            _interpolated.set(nx, ny, nz).transformDirection(object.matrixWorld);
        }
    } else {
        _interpolated.normalize();
    }

    if (_interpolated.lengthSq() === 0) {
        return { x: 0, y: 0, z: 1 };
    }

    return {
        x: _interpolated.x,
        y: _interpolated.y,
        z: _interpolated.z,
    };
}

/**
 * Calculates the raw barycentric-interpolated world normal at a raycast hit on `modelGeometryOf(hit.object)`.
 * Falls back to the world-transformed face normal when vertex attributes are absent.
 */
export function calculateRawWorldNormal(hit: THREE.Intersection): { x: number, y: number, z: number } {
    if (!hit.face) {
        return { x: 0, y: 0, z: 1 };
    }
    if (!(hit.object instanceof THREE.Mesh) || !hit.object.geometry) {
        return localNormalToWorld(hit.face.normal.x, hit.face.normal.y, hit.face.normal.z, hit.object);
    }

    // The hit's face indices address the model's own mesh (StlMesh raycasts it), not the display mesh it draws.
    const geom = modelGeometryOf(hit.object);
    const normalAttr = geom.attributes.normal;
    const positionAttr = geom.attributes.position;

    // If no vertex normals (or positions), fallback to world-transformed face normal
    if (!normalAttr || !positionAttr) {
        return localNormalToWorld(hit.face.normal.x, hit.face.normal.y, hit.face.normal.z, hit.object);
    }

    const a = hit.face.a;
    const b = hit.face.b;
    const c = hit.face.c;

    _nA.fromBufferAttribute(normalAttr, a);
    _nB.fromBufferAttribute(normalAttr, b);
    _nC.fromBufferAttribute(normalAttr, c);

    _pA.fromBufferAttribute(positionAttr, a);
    _pB.fromBufferAttribute(positionAttr, b);
    _pC.fromBufferAttribute(positionAttr, c);

    // Transform vertices to world space to match hit.point
    _pA.applyMatrix4(hit.object.matrixWorld);
    _pB.applyMatrix4(hit.object.matrixWorld);
    _pC.applyMatrix4(hit.object.matrixWorld);

    // Calculate Barycentric weights
    _tri.set(_pA, _pB, _pC);
    _tri.getBarycoord(hit.point, _bary);

    // Interpolate normals using weights
    _interpolated.set(0, 0, 0);
    _interpolated.addScaledVector(_nA, _bary.x);
    _interpolated.addScaledVector(_nB, _bary.y);
    _interpolated.addScaledVector(_nC, _bary.z);
    _interpolated.normalize();

    return localNormalToWorld(_interpolated.x, _interpolated.y, _interpolated.z, hit.object);
}

/**
 * Calculates the smoothed normal at a mesh intersection point, delegating to
 * BVH placement normal synthesis when `smoothContactNormals` is enabled.
 */
export function calculateSmoothedNormal(
    hit: THREE.Intersection,
    options?: CalculateSmoothedNormalOptions,
): { x: number, y: number, z: number } {
    const raw = calculateRawWorldNormal(hit);
    const settings = getSettings();
    if (
        options?.forceRaw
        || !settings.smoothContactNormals
        || !hit.face
        || !hit.point
        || !(hit.object instanceof THREE.Mesh)
        || !modelGeometryOf(hit.object)
    ) {
        return raw;
    }

    const devTools = settings.devToolsEnabled === true ? settings.devTools : undefined;
    const synthesized = synthesizePlacementNormal(
        hit.object,
        hit.point,
        raw,
        {
            mode: settings.normalSynthesisPreset,
            contactRadiusMm: options?.contactRadiusMm ?? settings.tip.contactDiameterMm * 0.5,
            prevNormal: options?.prevNormal,
            isDiskHudDrag: options?.isDiskHudDrag,
            ...(devTools
                ? {
                    sampleRadiusScale: devTools.normalSampleRadiusScale,
                    flatThresholdDeg: devTools.normalFlatThresholdDeg,
                    ...(devTools.normalCreaseThresholdDeg > 0
                        ? { creaseThresholdDeg: devTools.normalCreaseThresholdDeg }
                        : {}),
                    deadbandScale: devTools.normalDeadbandScale,
                }
                : {}),
        },
        _synthTarget,
    );

    return {
        x: synthesized.normal.x,
        y: synthesized.normal.y,
        z: synthesized.normal.z,
    };
}

/**
 * Finds the mesh in `candidates` whose surface is closest to `point`.
 * Prefers BVH closest-point distance when available, otherwise falls back to
 * world-space bounding-box distance.
 */
export function findClosestMeshToPoint(point: { x: number; y: number; z: number }, candidates: THREE.Object3D[]): THREE.Mesh | undefined {
    const worldPoint = new THREE.Vector3(point.x, point.y, point.z);
    const localPoint = new THREE.Vector3();
    const bbox = new THREE.Box3();
    const bboxPoint = new THREE.Vector3();
    const resultTarget = { point: new THREE.Vector3(), distance: 0, faceIndex: -1 };

    let bestMesh: THREE.Mesh | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const candidate of candidates) {
        if (!(candidate instanceof THREE.Mesh) || !candidate.geometry) continue;

        let distance = Number.POSITIVE_INFINITY;
        const boundsTree = (candidate.geometry as THREE.BufferGeometry & {
            boundsTree?: { closestPointToPoint?: (point: THREE.Vector3, target: object) => { distance: number } | null };
        }).boundsTree;
        if (boundsTree?.closestPointToPoint) {
            localPoint.copy(worldPoint).applyMatrix4(candidate.matrixWorld.clone().invert());
            const result = boundsTree.closestPointToPoint(localPoint, resultTarget);
            if (result) {
                distance = result.distance;
            }
        } else {
            if (!candidate.geometry.boundingBox) {
                candidate.geometry.computeBoundingBox();
            }
            if (candidate.geometry.boundingBox) {
                bbox.copy(candidate.geometry.boundingBox).applyMatrix4(candidate.matrixWorld);
                bbox.clampPoint(worldPoint, bboxPoint);
                distance = bboxPoint.distanceTo(worldPoint);
            }
        }

        if (distance < bestDistance) {
            bestDistance = distance;
            bestMesh = candidate;
        }
    }

    return bestMesh;
}
