import { Vec3 } from '../../types';
import {
    firstSegmentSatisfiesSocketElbowMaxAngle,
    getLengthAwareMaxAngleFromVerticalDeg,
    segmentSatisfiesLengthAwareMaxAngleFromVertical,
    SOCKET_ELBOW_MAX_ANGLE_FROM_VERTICAL_DEG,
    SOCKET_ELBOW_MAX_LENGTH_MM,
} from '../smartPlacementSearchUtils';
import type { SDFCache } from './SDFCache';

export interface FieldDeterministicSolverOptions {
    clearanceMm: number;
    marginMm: number;
    stepMm: number;
    maxLateralMm: number;
    maxSteps?: number;
    /** Max step/chord angle from vertical (degrees). When set, every march step
     *  is clamped to a descending direction within this angle and path
     *  simplification refuses chords that violate the length-aware angle rule,
     *  so the returned path satisfies the final chain validator instead of
     *  being rejected (and misreported) downstream. */
    maxAngleFromVerticalDeg?: number;
}

export interface FieldDeterministicSolverResult {
    path: Vec3[];
    reached: boolean;
    stagnated: boolean;
    iterations: number;
}

export function solveDeterministicFieldPath(
    sdf: SDFCache,
    startPos: Vec3,
    goalZ: number,
    opts: FieldDeterministicSolverOptions
): FieldDeterministicSolverResult {
    const clearance = opts.clearanceMm;
    const margin = opts.marginMm;
    const stepMm = opts.stepMm;
    const maxLateral = opts.maxLateralMm;
    const maxSteps = opts.maxSteps ?? 300;
    // The per-step cap comes from the same length-aware rule the final chain
    // validator applies, evaluated at the step length — short steps get the
    // short-span detour slack. Aim slightly inside the cap: a step at exactly
    // the cap angle fails the validator's `<=` comparison on float noise.
    // Within the socket-elbow window (first SOCKET_ELBOW_MAX_LENGTH_MM of
    // chain length) steps may use the steeper elbow angle, matching the
    // validator's first-segment elbow rule.
    const ANGLE_CAP_INSET_DEG = 0.05;
    const maxAngleRad = opts.maxAngleFromVerticalDeg !== undefined
        ? (Math.max(0, getLengthAwareMaxAngleFromVerticalDeg(stepMm, opts.maxAngleFromVerticalDeg) - ANGLE_CAP_INSET_DEG) * Math.PI) / 180
        : null;
    const elbowAngleRad = opts.maxAngleFromVerticalDeg !== undefined
        ? (Math.max(0, SOCKET_ELBOW_MAX_ANGLE_FROM_VERTICAL_DEG - ANGLE_CAP_INSET_DEG) * Math.PI) / 180
        : null;
    let chainLengthMm = 0;

    const path: Vec3[] = [{ ...startPos }];
    let current = { ...startPos };
    let iterations = 0;
    let reached = false;
    let stagnated = false;

    // Blending boundaries:
    // D <= dSafety (clearance) => pure gradient steering (w = 1.0)
    // D >= dClearance (clearance + margin) => pure vertical descent (w = 0.0)
    // dSafety < D < dClearance => linear blend
    const dSafety = clearance;
    const dClearance = clearance + margin;

    while (iterations < maxSteps) {
        iterations++;

        if (current.z <= goalZ) {
            reached = true;
            current.z = goalZ;
            path.push({ ...current });
            break;
        }

        // Early vertical escape check
        const dist = sdf.distanceAtTrilinear(current.x, current.y, current.z);
        if (dist >= dSafety) {
            const blocked = sdf.segmentBlocked(current.x, current.y, current.z, current.x, current.y, goalZ, clearance);
            if (!blocked) {
                path.push({ x: current.x, y: current.y, z: goalZ });
                reached = true;
                break;
            }
        }

        // March vector: blended downward vector and SDF gradient
        const maxDistance = dClearance;
        let { distance: D, gradient: grad } = sdf.distanceAndGradientAt(current.x, current.y, current.z, maxDistance);

        if (D < dSafety && grad.x === 0 && grad.y === 0 && grad.z === 0) {
            grad = { x: 0, y: 0, z: 1 };
        }

        let w = 0;
        if (D < dSafety) {
            w = 1.0;
        } else if (D < dClearance) {
            w = (dClearance - D) / (dClearance - dSafety);
        } else {
            w = 0.0;
        }

        let vx = w * grad.x;
        let vy = w * grad.y;
        let vz = (1 - w) * (-1.0) + w * grad.z;

        const vLen = Math.sqrt(vx * vx + vy * vy + vz * vz);
        if (vLen > 1e-6) {
            vx /= vLen;
            vy /= vLen;
            vz /= vLen;
        } else {
            vx = 0;
            vy = 0;
            vz = -1;
        }

        // Clamp the step direction to the max angle from vertical. The final
        // chain validator enforces this angle on the resolved route; steps
        // steeper than the cap (or ascending) would only produce chords the
        // validator rejects. Ascending points are dropped by the Z-monotone
        // filters anyway, so re-aiming to a capped descent loses nothing.
        if (maxAngleRad !== null && elbowAngleRad !== null) {
            const inElbowWindow = chainLengthMm + stepMm <= SOCKET_ELBOW_MAX_LENGTH_MM + 1e-6;
            const capRad = inElbowWindow ? Math.max(maxAngleRad, elbowAngleRad) : maxAngleRad;
            const lateralLen = Math.sqrt(vx * vx + vy * vy);
            const angleFromVertical = Math.atan2(lateralLen, -vz);
            if (angleFromVertical > capRad) {
                if (lateralLen > 1e-6) {
                    const sinCap = Math.sin(capRad);
                    vx = (vx / lateralLen) * sinCap;
                    vy = (vy / lateralLen) * sinCap;
                    vz = -Math.cos(capRad);
                } else {
                    vx = 0;
                    vy = 0;
                    vz = -1;
                }
            }
        }

        let nextX = current.x + vx * stepMm;
        let nextY = current.y + vy * stepMm;
        let nextZ = current.z + vz * stepMm;

        // Collision projection check: if next step is inside clearance, push out
        // along the gradient. The acceptance threshold carries a half-step
        // margin: the SDF is 1-Lipschitz, so keeping every path POINT at
        // clearance + step/2 guarantees the segment INTERIOR between adjacent
        // points never dips below clearance — which is what the final chain
        // validation sphere-traces against.
        const dAccept = dSafety + stepMm / 2 + 0.01;
        const nextDist = sdf.distanceAtTrilinear(nextX, nextY, nextZ);
        if (nextDist < dAccept) {
            const { gradient: nextGrad } = sdf.distanceAndGradientAt(nextX, nextY, nextZ, dClearance);
            const pushMag = dAccept - nextDist;
            nextX += nextGrad.x * pushMag;
            nextY += nextGrad.y * pushMag;
            nextZ += nextGrad.z * pushMag;
        }

        const dx = nextX - startPos.x;
        const dy = nextY - startPos.y;
        const lateralDist = Math.sqrt(dx * dx + dy * dy);
        if (lateralDist > maxLateral) {
            stagnated = true;
            break;
        }

        chainLengthMm += Math.sqrt(
            (nextX - current.x) ** 2 + (nextY - current.y) ** 2 + (nextZ - current.z) ** 2,
        );
        current = { x: nextX, y: nextY, z: nextZ };
        path.push({ ...current });
    }

    if (!reached && !stagnated) {
        stagnated = true;
    }

    let finalPath = path;
    if (reached) {
        finalPath = simplifyPath(path, sdf, clearance, opts.maxAngleFromVerticalDeg);
    }

    return {
        path: finalPath,
        reached,
        stagnated,
        iterations,
    };
}

function simplifyPath(
    path: Vec3[],
    sdf: SDFCache,
    clearance: number,
    maxAngleFromVerticalDeg?: number,
): Vec3[] {
    if (path.length <= 2) return path;

    const monoPath: Vec3[] = [path[0]];
    let minZ = path[0].z;
    for (let i = 1; i < path.length; i++) {
        if (path[i].z <= minZ) {
            monoPath.push(path[i]);
            minZ = path[i].z;
        }
    }
    if (monoPath.length <= 2) return monoPath;

    // A merged chord must stay collision-clear AND — when the angle cap is
    // active — satisfy the angle rule the final validator applies: the first
    // chord (leaving the socket) gets the socket-elbow allowance, everything
    // else the regular length-aware rule. Without the angle guard this pass
    // merges many small capped steps into one long steep chord that the
    // validator then rejects.
    const chordInvalid = (a: Vec3, b: Vec3, isFirstChord: boolean): boolean => {
        if (sdf.segmentBlocked(a.x, a.y, a.z, b.x, b.y, b.z, clearance)) return true;
        if (maxAngleFromVerticalDeg === undefined) return false;
        if (isFirstChord) return !firstSegmentSatisfiesSocketElbowMaxAngle(a, b, maxAngleFromVerticalDeg);
        return !segmentSatisfiesLengthAwareMaxAngleFromVertical(a, b, maxAngleFromVerticalDeg);
    };

    // Farthest-reach greedy: from each anchor, extend the chord as far as it
    // stays valid, then commit. Every committed chord has been validated —
    // the previous version skipped validating the chord right after a
    // re-anchor, letting unchecked segments into the final chain. When even
    // the adjacent chord is invalid (possible across gaps left by the
    // Z-monotone filter), bail out with the unsimplified monotone path and
    // let the caller's final validation reject it honestly.
    const result: Vec3[] = [monoPath[0]];
    let anchor = 0;

    while (anchor < monoPath.length - 1) {
        const isFirstChord = anchor === 0;
        let reach = anchor + 1;
        while (reach + 1 < monoPath.length && !chordInvalid(monoPath[anchor], monoPath[reach + 1], isFirstChord)) {
            reach++;
        }
        if (reach === anchor + 1 && chordInvalid(monoPath[anchor], monoPath[reach], isFirstChord)) {
            return monoPath;
        }
        result.push(monoPath[reach]);
        anchor = reach;
    }

    return result;
}
