import * as THREE from 'three';

/**
 * Efficiently computes the lowest Z coordinate of a geometry after applying a transformation matrix.
 * This avoids cloning the geometry or creating Vector3 objects for every vertex.
 * 
 * @param geometry The geometry to analyze
 * @param matrix The transformation matrix to apply (Local -> World)
 * @returns The lowest Z coordinate in world space
 */
export function computeLowestZ(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4): number {
    const positionAttribute = geometry.getAttribute('position');
    if (!positionAttribute) return 0;

    // Extract matrix elements for direct calculation
    // Matrix4 elements are column-major:
    // 0  4  8  12
    // 1  5  9  13
    // 2  6  10 14
    // 3  7  11 15
    const e = matrix.elements;
    const m2 = e[2];
    const m6 = e[6];
    const m10 = e[10];
    const m14 = e[14];

    // Optimization: Check if rotation is identity (or close enough) regarding Z axis.
    // If m2 (x->z) and m6 (y->z) are ~0, then Z only depends on Z.
    // This happens when there is no rotation around X or Y axis that would tilt the object.
    // Rotation around Z axis is fine.
    const EPSILON = 1e-6;
    if (Math.abs(m2) < EPSILON && Math.abs(m6) < EPSILON) {
        // Z is only dependent on Z.
        // z' = z * m10 + m14
        // If m10 > 0, minZ' comes from minZ.
        // If m10 < 0, minZ' comes from maxZ.

        if (!geometry.boundingBox) geometry.computeBoundingBox();
        const bbox = geometry.boundingBox!;

        if (m10 >= 0) {
            return bbox.min.z * m10 + m14;
        } else {
            return bbox.max.z * m10 + m14;
        }
    }

    let minZ = Infinity;
    const count = positionAttribute.count;

    // Direct buffer access for performance
    if (positionAttribute instanceof THREE.BufferAttribute) {
        const array = positionAttribute.array;
        const itemSize = positionAttribute.itemSize;

        // Handle standard Float32Array
        for (let i = 0; i < count; i++) {
            const idx = i * itemSize;
            const x = array[idx];
            const y = array[idx + 1];
            const z = array[idx + 2];

            // Apply matrix Z row:
            // z' = x * m2 + y * m6 + z * m10 + m14
            const zWorld = x * m2 + y * m6 + z * m10 + m14;

            if (zWorld < minZ) {
                minZ = zWorld;
            }
        }
    } else {
        // Fallback for InterleavedBufferAttribute or others
        for (let i = 0; i < count; i++) {
            const x = positionAttribute.getX(i);
            const y = positionAttribute.getY(i);
            const z = positionAttribute.getZ(i);

            const zWorld = x * m2 + y * m6 + z * m10 + m14;
            if (zWorld < minZ) minZ = zWorld;
        }
    }

    return minZ;
}

/**
 * Efficiently computes the Z bounds (min/max) of a geometry after applying a transformation matrix.
 * This avoids cloning the geometry.
 */
export function computeBoundsZ(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4): { min: number, max: number } {
    const positionAttribute = geometry.getAttribute('position');
    if (!positionAttribute) return { min: 0, max: 0 };

    const e = matrix.elements;
    const m2 = e[2];
    const m6 = e[6];
    const m10 = e[10];
    const m14 = e[14];

    // Optimization: Check if rotation is identity (or close enough) regarding Z axis.
    const EPSILON = 1e-6;
    if (Math.abs(m2) < EPSILON && Math.abs(m6) < EPSILON) {
        if (!geometry.boundingBox) geometry.computeBoundingBox();
        const bbox = geometry.boundingBox!;

        let min, max;
        if (m10 >= 0) {
            min = bbox.min.z * m10 + m14;
            max = bbox.max.z * m10 + m14;
        } else {
            min = bbox.max.z * m10 + m14;
            max = bbox.min.z * m10 + m14;
        }
        return { min, max };
    }

    let minZ = Infinity;
    let maxZ = -Infinity;
    const count = positionAttribute.count;

    if (positionAttribute instanceof THREE.BufferAttribute) {
        const array = positionAttribute.array;
        const itemSize = positionAttribute.itemSize;

        for (let i = 0; i < count; i++) {
            const idx = i * itemSize;
            const x = array[idx];
            const y = array[idx + 1];
            const z = array[idx + 2];

            const zWorld = x * m2 + y * m6 + z * m10 + m14;

            if (zWorld < minZ) minZ = zWorld;
            if (zWorld > maxZ) maxZ = zWorld;
        }
    } else {
        for (let i = 0; i < count; i++) {
            const x = positionAttribute.getX(i);
            const y = positionAttribute.getY(i);
            const z = positionAttribute.getZ(i);

            const zWorld = x * m2 + y * m6 + z * m10 + m14;
            if (zWorld < minZ) minZ = zWorld;
            if (zWorld > maxZ) maxZ = zWorld;
        }
    }

    return { min: minZ, max: maxZ };
}
