import { Vec3 } from '../../types';
import type { SDFCache } from './SDFCache';

export interface FieldDeterministicSolverOptions {
    clearanceMm: number;
    marginMm: number;
    stepMm: number;
    maxLateralMm: number;
    maxSteps?: number;
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

        const nextX = current.x + vx * stepMm;
        const nextY = current.y + vy * stepMm;
        const nextZ = current.z + vz * stepMm;

        const dx = nextX - startPos.x;
        const dy = nextY - startPos.y;
        const lateralDist = Math.sqrt(dx * dx + dy * dy);
        if (lateralDist > maxLateral) {
            stagnated = true;
            break;
        }

        current = { x: nextX, y: nextY, z: nextZ };
        path.push({ ...current });
    }

    if (!reached && !stagnated) {
        stagnated = true;
    }

    let finalPath = path;
    if (reached) {
        finalPath = simplifyPath(path, sdf, clearance);
    }

    return {
        path: finalPath,
        reached,
        stagnated,
        iterations,
    };
}

function simplifyPath(path: Vec3[], sdf: SDFCache, clearance: number): Vec3[] {
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

    const result: Vec3[] = [monoPath[0]];
    let anchor = 0;

    for (let probe = 2; probe < monoPath.length; probe++) {
        const a = monoPath[anchor];
        const b = monoPath[probe];

        if (sdf.segmentBlocked(a.x, a.y, a.z, b.x, b.y, b.z, clearance)) {
            result.push(monoPath[probe - 1]);
            anchor = probe - 1;
        }
    }

    result.push(monoPath[monoPath.length - 1]);
    return result;
}
