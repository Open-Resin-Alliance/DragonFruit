import * as THREE from 'three';
import { Vec3 } from '../types';

// Angle limit from vertical (0 degrees = vertical, 90 degrees = horizontal).
// We want to prevent supports from being too flat (horizontal) or pointing upwards (negative).
// Max 80 degrees means the support must be at least 10 degrees away from horizontal.
// Note: This default is now 80, but callers should usually provide the user setting.

export interface ShaftClampResult {
    clampedPos: Vec3;
    isClamped: boolean;
    angleDeg: number;
}

/**
 * Clamps the end position of a shaft such that the angle between the shaft and the reference axis
 * does not exceed maxAngleDeg.
 * 
 * @param start The fixed start point of the vector (anchor)
 * @param desiredEnd The desired end point (moving)
 * @param maxAngleDeg Maximum allowed angle in degrees from the reference axis
 * @param referenceAxis The axis to measure against (default: Z-Up)
 */
export function clampShaftAngle(
    start: Vec3,
    desiredEnd: Vec3,
    maxAngleDeg: number = 80,
    referenceAxis: Vec3 = { x: 0, y: 0, z: 1 }
): ShaftClampResult {
    const s = new THREE.Vector3(start.x, start.y, start.z);
    const e = new THREE.Vector3(desiredEnd.x, desiredEnd.y, desiredEnd.z);

    const v = new THREE.Vector3().subVectors(e, s);
    const len = v.length();

    if (len < 0.001) {
        return { clampedPos: desiredEnd, isClamped: false, angleDeg: 0 };
    }

    const axis = new THREE.Vector3(referenceAxis.x, referenceAxis.y, referenceAxis.z).normalize();
    const angleRad = v.angleTo(axis);
    const angleDeg = THREE.MathUtils.radToDeg(angleRad);

    if (angleDeg <= maxAngleDeg) {
        return { clampedPos: desiredEnd, isClamped: false, angleDeg };
    }

    // Clamp required
    const dot = v.dot(axis);
    const vParallel = axis.clone().multiplyScalar(dot);
    const vPerp = new THREE.Vector3().subVectors(v, vParallel);

    if (vPerp.lengthSq() < 0.0001) {
        if (Math.abs(axis.z) > 0.9) vPerp.set(1, 0, 0);
        else vPerp.set(0, 0, 1);
        const tempDot = vPerp.dot(axis);
        vPerp.sub(axis.clone().multiplyScalar(tempDot));
    }

    vPerp.normalize();

    const limitRad = THREE.MathUtils.degToRad(maxAngleDeg);
    const vNew = axis.clone().multiplyScalar(Math.cos(limitRad))
        .add(vPerp.multiplyScalar(Math.sin(limitRad)))
        .multiplyScalar(len);

    return {
        clampedPos: { x: s.x + vNew.x, y: s.y + vNew.y, z: s.z + vNew.z },
        isClamped: true,
        angleDeg: maxAngleDeg
    };
}
