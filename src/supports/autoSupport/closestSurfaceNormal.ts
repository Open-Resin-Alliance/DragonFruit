import * as THREE from 'three';

type ClosestPointTarget = {
    point: THREE.Vector3;
    distance: number;
    faceIndex: number;
};

type BvhLike = {
    closestPointToPoint: (
        point: THREE.Vector3,
        target: ClosestPointTarget,
        minThreshold?: number,
        maxThreshold?: number,
    ) => ClosestPointTarget | null;
};

/**
 * The outward normal of the model surface nearest `worldPoint`.
 *
 * The vertical-ray resolver cannot see a side wall: both of its rays run along
 * Z, so a contact on a steep face falls back to "down" and every such island
 * looked like an underside. The BVH's nearest triangle answers for any
 * orientation.
 *
 * Returns null when the geometry has no BVH or no triangles.
 */
export function closestSurfaceNormal(
    mesh: THREE.Mesh,
    worldPoint: THREE.Vector3,
): THREE.Vector3 | null {
    const geometry = mesh.geometry;
    const bvh = (geometry as THREE.BufferGeometry & { boundsTree?: BvhLike }).boundsTree;
    if (!bvh) return null;

    const local = worldPoint.clone().applyMatrix4(
        new THREE.Matrix4().copy(mesh.matrixWorld).invert(),
    );
    const target: ClosestPointTarget = {
        point: new THREE.Vector3(),
        distance: Infinity,
        faceIndex: -1,
    };
    if (!bvh.closestPointToPoint(local, target) || target.faceIndex < 0) return null;

    const position = geometry.getAttribute('position');
    const index = geometry.getIndex();
    const i0 = index ? index.getX(target.faceIndex * 3) : target.faceIndex * 3;
    const i1 = index ? index.getX(target.faceIndex * 3 + 1) : target.faceIndex * 3 + 1;
    const i2 = index ? index.getX(target.faceIndex * 3 + 2) : target.faceIndex * 3 + 2;
    if (i2 >= position.count) return null;

    const a = new THREE.Vector3().fromBufferAttribute(position, i0);
    const b = new THREE.Vector3().fromBufferAttribute(position, i1);
    const c = new THREE.Vector3().fromBufferAttribute(position, i2);
    const normal = new THREE.Vector3()
        .crossVectors(b.clone().sub(a), c.clone().sub(a))
        .normalize();

    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    return normal.applyMatrix3(normalMatrix).normalize();
}
