import { Vec3 } from '../../types';
import type { SDFCache } from './SDFCache';

export interface PotentialFieldSolverOptions {
    /** Minimum allowed clearance from the model. */
    clearanceMm: number;
    /** Safety margin within which repulsion begins to scale up. Default 2.0mm. */
    marginMm?: number;
    /** The repulsion coefficient/force multiplier. Default 5.0. */
    repulsionStrength?: number;
    /** Step size of the integration path in mm. Default 1.0mm. */
    stepMm?: number;
    /** Maximum steps/iterations allowed. Default 300. */
    maxSteps?: number;
    /** Maximum lateral (XY) deviation allowed from the starting position. Default 30mm. */
    maxLateralMm?: number;
    /** Set to true to simplify the path to straight segments/joints. Default true. */
    simplify?: boolean;
    /** Swirling tangent force coefficient/weight. Default 0.5. */
    tangentWeight?: number;
}

export interface PotentialFieldSolverResult {
    /** Solved waypoints (from socket position down to goalZ). */
    path: Vec3[];
    /** Whether the path successfully reached goalZ without stagnating. */
    reached: boolean;
    /** Whether search stagnated (Z progress stopped). */
    stagnated: boolean;
    /** Number of integration steps executed. */
    iterations: number;
    /** Position where the path stagnated, if reached is false. */
    stagnationPos?: Vec3;
}

/**
 * Greedy line-of-sight simplification: keep only waypoints where the
 * direct segment to the next kept waypoint would be blocked by model geometry.
 */
function simplifyPath(path: Vec3[], sdf: SDFCache, clearance: number): Vec3[] {
    if (path.length <= 2) return path;

    // First pass: enforce Z-monotonicity.
    const monoPath: Vec3[] = [path[0]];
    let minZ = path[0].z;
    for (let i = 1; i < path.length; i++) {
        if (path[i].z <= minZ) {
            monoPath.push(path[i]);
            minZ = path[i].z;
        }
    }
    if (monoPath.length <= 2) return monoPath;

    // Second pass: greedy line-of-sight collapse.
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

/**
 * Solves support routing using continuous potential field integration.
 * Routes a virtual particle from startPos downwards to goalZ, repelled by model geometry via the SDF.
 */
export function solvePotentialField(
    sdf: SDFCache,
    startPos: Vec3,
    goalZ: number,
    opts: PotentialFieldSolverOptions
): PotentialFieldSolverResult {
    const clearance = opts.clearanceMm;
    const margin = opts.marginMm ?? 2.5;
    const repulsionStrength = opts.repulsionStrength ?? 8.0;
    const stepMm = opts.stepMm ?? 1.0;
    const maxSteps = opts.maxSteps ?? 300;
    const maxLateral = opts.maxLateralMm ?? 30;
    const maxLateralSq = maxLateral * maxLateral;
    const simplify = opts.simplify ?? true;
    const tangentWeight = opts.tangentWeight ?? 0.5;

    const path: Vec3[] = [{ ...startPos }];
    let current = { ...startPos };
    let iterations = 0;
    let reached = false;
    let stagnated = false;
    let stagnationPos: Vec3 | undefined;

    const history: Vec3[] = [];
    const HISTORY_WINDOW = 15;
    const STAGNATION_DISPLACEMENT_THRESHOLD = 1.5 * stepMm;

    while (iterations < maxSteps) {
        iterations++;

        if (current.z <= goalZ) {
            reached = true;
            current.z = goalZ;
            path.push({ ...current });
            break;
        }

        const dx = current.x - startPos.x;
        const dy = current.y - startPos.y;

        const maxDistance = clearance + margin;
        let { distance: d, gradient: grad } = sdf.distanceAndGradientAt(current.x, current.y, current.z, maxDistance);

        // If we are inside/close to an obstacle but the gradient is zero (e.g. flat mock SDF or local minimum),
        // default the gradient to point straight UP (0, 0, 1) to repel against gravity.
        if (d < clearance + margin && grad.x === 0 && grad.y === 0 && grad.z === 0) {
            grad = { x: 0, y: 0, z: 1 };
        }

        let wRepulsion = 0;
        if (d < clearance + margin) {
            const safeDistance = d - clearance;
            if (safeDistance > 0.05) {
                wRepulsion = repulsionStrength * (margin / safeDistance - 1.0);
            } else {
                // Inside or extremely close to clearance zone: scale up repulsion aggressively
                wRepulsion = repulsionStrength * (margin / 0.05 - 1.0) * (1.0 + Math.max(0, 0.05 - safeDistance) * 10.0);
            }
        }

        // Calculate lateral escape direction (normalized XY gradient).
        // If the particle is under an overhang (grad.z > 0), we want to slide
        // laterally to find an exit.
        let escapeX = 0;
        let escapeY = 0;
        const hLen = Math.sqrt(grad.x * grad.x + grad.y * grad.y);
        if (hLen > 1e-4) {
            escapeX = grad.x / hLen;
            escapeY = grad.y / hLen;
        } else {
            // Use current displacement direction to break symmetry if available
            const distFromStart = Math.sqrt(dx * dx + dy * dy);
            if (distFromStart > 1e-4) {
                escapeX = dx / distFromStart;
                escapeY = dy / distFromStart;
            } else {
                escapeX = 1;
                escapeY = 0;
            }
        }

        // Calculate tangential slide force around the obstacle (swirling)
        let tx = 0;
        let ty = 0;
        if (hLen > 1e-4) {
            // Two possible tangents: (grad.y, -grad.x) and (-grad.y, grad.x)
            // Choose the one that points outward (positive dot product with displacement from startPos)
            const rawTx = grad.y / hLen;
            const rawTy = -grad.x / hLen;
            const dot = rawTx * dx + rawTy * dy;
            if (dot >= 0) {
                tx = rawTx;
                ty = rawTy;
            } else {
                tx = -rawTx;
                ty = -rawTy;
            }
        }

        // Transfer vertical repulsion to lateral escape force to slide out under overhangs.
        const lateralSlideWeight = grad.z > 0 ? grad.z * 0.90 : 0;

        let vx = 0 + wRepulsion * (grad.x + escapeX * lateralSlideWeight + tx * tangentWeight);
        let vy = 0 + wRepulsion * (grad.y + escapeY * lateralSlideWeight + ty * tangentWeight);
        let vz = -1.0 + wRepulsion * grad.z * (1 - lateralSlideWeight * 0.5);

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

        const nextDx = nextX - startPos.x;
        const nextDy = nextY - startPos.y;
        const lateralDist = Math.sqrt(nextDx * nextDx + nextDy * nextDy);

        if (lateralDist > maxLateral) {
            stagnated = true;
            stagnationPos = { ...current };
            break;
        }

        current = { x: nextX, y: nextY, z: nextZ };
        path.push({ ...current });

        history.push({ ...current });
        if (history.length > HISTORY_WINDOW) {
            history.shift();
            const oldPos = history[0];
            const hdx = current.x - oldPos.x;
            const hdy = current.y - oldPos.y;
            const hdz = current.z - oldPos.z;
            const distSq = hdx * hdx + hdy * hdy + hdz * hdz;
            if (distSq < STAGNATION_DISPLACEMENT_THRESHOLD * STAGNATION_DISPLACEMENT_THRESHOLD) {
                stagnated = true;
                stagnationPos = { ...current };
                break;
            }
        }
    }

    if (!reached && !stagnated) {
        stagnated = true;
        stagnationPos = { ...current };
    }

    let finalPath = path;
    if (reached && simplify) {
        finalPath = simplifyPath(path, sdf, clearance);
    }

    return {
        path: finalPath,
        reached,
        stagnated,
        iterations,
        stagnationPos,
    };
}

