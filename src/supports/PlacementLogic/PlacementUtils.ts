import * as THREE from 'three';
import { modelGeometryOf } from '../autoSupport/meshStore';

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
 * Calculates the smoothed normal (interpolated vertex normal) at a specific intersection point on a mesh.
 * This provides a much smoother angle for support placement on curved surfaces compared to raw face normals.
 * 
 * @param hit The Three.js Intersection object containing face, object, and point data.
 * @returns The smoothed normal vector in world space, or the face normal if smoothing fails.
 */
export function calculateSmoothedNormal(hit: THREE.Intersection): { x: number, y: number, z: number } {
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
