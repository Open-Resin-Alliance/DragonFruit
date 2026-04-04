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
    const vx = desiredEnd.x - start.x;
    const vy = desiredEnd.y - start.y;
    const vz = desiredEnd.z - start.z;
    const lenSq = (vx * vx) + (vy * vy) + (vz * vz);
    const len = Math.sqrt(lenSq);

    if (len < 0.001) {
        return { clampedPos: desiredEnd, isClamped: false, angleDeg: 0 };
    }

    const axRaw = referenceAxis.x;
    const ayRaw = referenceAxis.y;
    const azRaw = referenceAxis.z;
    const axisLen = Math.sqrt((axRaw * axRaw) + (ayRaw * ayRaw) + (azRaw * azRaw));

    if (axisLen < 1e-8) {
        return { clampedPos: desiredEnd, isClamped: false, angleDeg: 0 };
    }

    const ax = axRaw / axisLen;
    const ay = ayRaw / axisLen;
    const az = azRaw / axisLen;

    const dot = (vx * ax) + (vy * ay) + (vz * az);
    const cosTheta = Math.max(-1, Math.min(1, dot / len));
    const angleRad = Math.acos(cosTheta);
    const angleDeg = angleRad * (180 / Math.PI);

    if (angleDeg <= maxAngleDeg) {
        return { clampedPos: desiredEnd, isClamped: false, angleDeg };
    }

    // Clamp required: preserve vector length and azimuth around the axis.
    let perpX = vx - (ax * dot);
    let perpY = vy - (ay * dot);
    let perpZ = vz - (az * dot);
    let perpLen = Math.sqrt((perpX * perpX) + (perpY * perpY) + (perpZ * perpZ));

    // Degenerate case: choose a stable arbitrary axis-perpendicular direction.
    if (perpLen < 1e-8) {
        if (Math.abs(az) < 0.9) {
            // cross(axis, z-up)
            perpX = ay;
            perpY = -ax;
            perpZ = 0;
        } else {
            // cross(axis, x-right)
            perpX = 0;
            perpY = az;
            perpZ = -ay;
        }

        perpLen = Math.sqrt((perpX * perpX) + (perpY * perpY) + (perpZ * perpZ));
        if (perpLen < 1e-8) {
            return { clampedPos: desiredEnd, isClamped: false, angleDeg };
        }
    }

    const invPerpLen = 1 / perpLen;
    const perpDirX = perpX * invPerpLen;
    const perpDirY = perpY * invPerpLen;
    const perpDirZ = perpZ * invPerpLen;

    const limitRad = (maxAngleDeg * Math.PI) / 180;
    const newParallelLen = Math.cos(limitRad) * len;
    const newPerpLen = Math.sin(limitRad) * len;

    const vNewX = (ax * newParallelLen) + (perpDirX * newPerpLen);
    const vNewY = (ay * newParallelLen) + (perpDirY * newPerpLen);
    const vNewZ = (az * newParallelLen) + (perpDirZ * newPerpLen);

    return {
        clampedPos: { x: start.x + vNewX, y: start.y + vNewY, z: start.z + vNewZ },
        isClamped: true,
        angleDeg: maxAngleDeg
    };
}
