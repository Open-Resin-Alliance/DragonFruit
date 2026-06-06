import * as THREE from 'three';
import { Vec3 } from '../types';

const MAX_CONE_AXIS_DEVIATION_FROM_SURFACE_NORMAL_DEG = 30;

export interface ConeAxisPolicyInput {
    surfaceNormal: Vec3;
    coneAngleMode: 'normal' | 'locked' | 'adaptive';
    adaptiveConeAngleOffsetDeg?: number;
}

export interface ConeAxisPolicyResult {
    surfaceAngleFromUpDeg: number;
    minAllowedSurfaceAngleFromUpDeg: number;
    coneAxis: Vec3;
}

export function resolveConeAxisPolicy(input: ConeAxisPolicyInput): ConeAxisPolicyResult {
    const { surfaceNormal, coneAngleMode, adaptiveConeAngleOffsetDeg } = input;

    const normal = new THREE.Vector3(surfaceNormal.x, surfaceNormal.y, surfaceNormal.z).normalize();
    const up = new THREE.Vector3(0, 0, 1);

    const surfaceAngleFromUpDeg = normal.angleTo(up) * (180 / Math.PI);

    const minAllowedSurfaceAngleFromUpDeg = coneAngleMode === 'normal' ? 90 : 85;

    let coneAxisVec = normal.clone();

    if (coneAngleMode === 'locked') {
        let forcedAngleFromUpDeg: number | null = null;

        if (surfaceAngleFromUpDeg >= 110 && surfaceAngleFromUpDeg <= 140) {
            forcedAngleFromUpDeg = 140;
        } else if (surfaceAngleFromUpDeg >= 85 && surfaceAngleFromUpDeg < 110) {
            forcedAngleFromUpDeg = 110;
        }

        if (forcedAngleFromUpDeg !== null) {
            const horizontalDir = new THREE.Vector3(normal.x, normal.y, 0);
            if (horizontalDir.lengthSq() > 1e-10) {
                horizontalDir.normalize();

                const forcedRad = THREE.MathUtils.degToRad(forcedAngleFromUpDeg);
                const horizontalMag = Math.sin(forcedRad);
                const vertical = Math.cos(forcedRad);

                coneAxisVec = horizontalDir
                    .multiplyScalar(horizontalMag)
                    .add(up.clone().multiplyScalar(vertical))
                    .normalize();
            }
        }
    } else if (coneAngleMode === 'adaptive') {
        const horizontalDir = new THREE.Vector3(normal.x, normal.y, 0);
        if (horizontalDir.lengthSq() > 1e-10) {
            horizontalDir.normalize();

            const rampStartDeg = 90;
            const rampEndDeg = 150;
            const rawOffset = adaptiveConeAngleOffsetDeg ?? 30;
            const maxOffsetDeg = THREE.MathUtils.clamp(rawOffset, 0, 90);

            const t = THREE.MathUtils.clamp(
                (surfaceAngleFromUpDeg - rampStartDeg) / (rampEndDeg - rampStartDeg),
                0,
                1
            );
            const offsetDeg = maxOffsetDeg * (1 - t);
            const forcedAngleFromUpDeg = Math.min(180, surfaceAngleFromUpDeg + offsetDeg);

            const forcedRad = THREE.MathUtils.degToRad(forcedAngleFromUpDeg);
            const horizontalMag = Math.sin(forcedRad);
            const vertical = Math.cos(forcedRad);

            coneAxisVec = horizontalDir
                .multiplyScalar(horizontalMag)
                .add(up.clone().multiplyScalar(vertical))
                .normalize();
        }
    } else {
        if (surfaceAngleFromUpDeg >= 90 && surfaceAngleFromUpDeg <= 95) {
            const horizontal = new THREE.Vector3(normal.x, normal.y, 0);
            if (horizontal.lengthSq() > 1e-10) {
                horizontal.normalize();
                const tiltRad = THREE.MathUtils.degToRad(10);
                const down = new THREE.Vector3(0, 0, -1);
                coneAxisVec = horizontal
                    .multiplyScalar(Math.cos(tiltRad))
                    .add(down.multiplyScalar(Math.sin(tiltRad)))
                    .normalize();
            }
        }
    }

    const maxDeviationRad = THREE.MathUtils.degToRad(MAX_CONE_AXIS_DEVIATION_FROM_SURFACE_NORMAL_DEG);
    const deviationRad = coneAxisVec.angleTo(normal);
    if (deviationRad > maxDeviationRad + 1e-6) {
        const rotationAxis = new THREE.Vector3().crossVectors(normal, coneAxisVec);
        if (rotationAxis.lengthSq() < 1e-10) {
            rotationAxis.copy(new THREE.Vector3(0, 0, 1).cross(normal));
            if (rotationAxis.lengthSq() < 1e-10) {
                rotationAxis.copy(new THREE.Vector3(1, 0, 0).cross(normal));
            }
        }
        rotationAxis.normalize();
        coneAxisVec = normal.clone().applyAxisAngle(rotationAxis, maxDeviationRad).normalize();
    }

    const coneAxis: Vec3 = { x: coneAxisVec.x, y: coneAxisVec.y, z: coneAxisVec.z };

    // Never let the cone axis point upward — in resin printing the cone must
    // point toward the build plate (negative Z).  If the computed axis has a
    // positive Z component, project it to horizontal with a slight downward tilt.
    const clampedAxis = clampAxisDownward(coneAxis);

    return {
        surfaceAngleFromUpDeg,
        minAllowedSurfaceAngleFromUpDeg,
        coneAxis: clampedAxis,
    };
}

/**
 * Ensures a cone axis never points upward (positive Z).
 * Projects upward-pointing axes to horizontal with a 5° downward tilt.
 */
function clampAxisDownward(axis: Vec3): Vec3 {
    if (axis.z <= 0) return axis;

    const hLen = Math.sqrt(axis.x * axis.x + axis.y * axis.y);
    if (hLen < 0.001) {
        return { x: 0, y: 0, z: -1 };
    }
    const tiltRad = Math.PI / 36; // 5°
    const scale = 1 / hLen;
    return {
        x: axis.x * scale * Math.cos(tiltRad),
        y: axis.y * scale * Math.cos(tiltRad),
        z: -Math.sin(tiltRad),
    };
}
