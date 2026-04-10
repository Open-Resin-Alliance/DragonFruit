import * as THREE from 'three';

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

/**
 * Calculates the smoothed normal (interpolated vertex normal) at a specific intersection point on a mesh.
 * This provides a much smoother angle for support placement on curved surfaces compared to raw face normals.
 * 
 * @param hit The Three.js Intersection object containing face, object, and point data.
 * @returns The smoothed normal vector in world space, or the face normal if smoothing fails.
 */
export function calculateSmoothedNormal(hit: THREE.Intersection): { x: number, y: number, z: number } {
    if (!hit.face || !(hit.object instanceof THREE.Mesh) || !hit.object.geometry) {
        return { 
            x: hit.face?.normal.x ?? 0, 
            y: hit.face?.normal.y ?? 0, 
            z: hit.face?.normal.z ?? 1 
        };
    }

    const geom = hit.object.geometry;
    const normalAttr = geom.attributes.normal;

    // If no vertex normals, fallback to face normal
    if (!normalAttr) {
        return { 
            x: hit.face.normal.x, 
            y: hit.face.normal.y, 
            z: hit.face.normal.z 
        };
    }

    const positionAttr = geom.attributes.position;
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
    
    // Transform normal to world space (rotation only)
    _interpolated.transformDirection(hit.object.matrixWorld);

    return { 
        x: _interpolated.x, 
        y: _interpolated.y, 
        z: _interpolated.z 
    };
}
