import * as THREE from 'three';

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

    const nA = new THREE.Vector3().fromBufferAttribute(normalAttr, a);
    const nB = new THREE.Vector3().fromBufferAttribute(normalAttr, b);
    const nC = new THREE.Vector3().fromBufferAttribute(normalAttr, c);

    const pA = new THREE.Vector3().fromBufferAttribute(positionAttr, a);
    const pB = new THREE.Vector3().fromBufferAttribute(positionAttr, b);
    const pC = new THREE.Vector3().fromBufferAttribute(positionAttr, c);

    // Transform vertices to world space to match hit.point
    pA.applyMatrix4(hit.object.matrixWorld);
    pB.applyMatrix4(hit.object.matrixWorld);
    pC.applyMatrix4(hit.object.matrixWorld);

    // Calculate Barycentric weights
    const tri = new THREE.Triangle(pA, pB, pC);
    const bary = new THREE.Vector3();
    tri.getBarycoord(hit.point, bary);

    // Interpolate normals using weights
    const interpolatedNormal = new THREE.Vector3();
    interpolatedNormal.addScaledVector(nA, bary.x);
    interpolatedNormal.addScaledVector(nB, bary.y);
    interpolatedNormal.addScaledVector(nC, bary.z);
    interpolatedNormal.normalize();
    
    // Transform normal to world space (rotation only)
    interpolatedNormal.transformDirection(hit.object.matrixWorld);

    return { 
        x: interpolatedNormal.x, 
        y: interpolatedNormal.y, 
        z: interpolatedNormal.z 
    };
}
