/**
 * GridAStar — 26-connected grid pathfinder using SDF + occupancy
 *
 * Replaces the old raycast-bundle candidate expansion with SDF-based
 * collision checks. Uses a coarse grid step (2mm default) for pathfinding
 * to cover large distances efficiently, while validating each edge with
 * fine SDF segment checks (0.5mm intervals) for accuracy.
 *
 * Key features:
 * - **Signed SDF**: correctly blocks interior points (negative distance)
 * - **Upward movement**: limited climbing (up to 3 cells) to route around
 *   protrusions — without this, any geometry below the socket is impassable
 * - **Goal validation**: roots collision check integrated into goal acceptance
 * - **Frame-coherent warm-start**: reuses open set between frames
 *
 * Cost priorities (in order):
 * 1. **Shortest collision-free path** — base euclidean distance (moveCost)
 * 2. **Greatest verticality**         — lateral XY movement is penalised
 * 3. **Least shallow angles**         — quadratic penalty on lateral/drop ratio
 */

import { Vec3 } from '../../types';
import type { SDFCache } from './SDFCache';
import type { SupportOccupancy } from './SupportOccupancy';

// ---------- Types ----------

export interface GridAStarOptions {
    /** Maximum node expansions before giving up. Default 200. */
    maxExpansions?: number;
    /** Grid step size in mm (should match SDF cellSize). Default 0.5. */
    stepMm?: number;
    /** Minimum allowed distance-from-vertical angle for shaft segments (degrees). */
    minAngleFromVerticalDeg?: number;
    /** Maximum total lateral (XY) displacement from socket. */
    maxLateralMm?: number;
    /** Clearance = shaft radius + safety margin. Cells closer than this are blocked. */
    clearanceMm: number;
    /** If provided, skip cells occupied by other supports. */
    occupancy?: SupportOccupancy;
    /** Support ID to ignore in occupancy checks (don't collide with self). */
    ignoreSupportId?: string;
    /**
     * Optional goal validation callback. When the A* reaches a cell at goalZ,
     * this function is called with world coordinates. If it returns false, the
     * cell is NOT accepted as a goal and the search continues — allowing the
     * pathfinder to explore laterally for a valid goal position.
     *
     * Primary use: roots collision check. The A* can find a shaft path to goalZ,
     * but the roots volume at that XY may intersect the mesh. The validator
     * rejects those positions so the A* keeps searching.
     */
    goalValidator?: (wx: number, wy: number, wz: number) => boolean;
    /**
     * When true, each neighbor edge collision check uses `sdf.isBlocked` on
     * the endpoint cell only instead of the full `sdf.segmentBlocked` sweep.
     *
     * **Why this matters for preview performance:**
     * The A* grid step is 2mm but the SDF cell size is 0.5mm. `segmentBlocked`
     * samples at 0.5mm intervals, generating 5–8 BVH queries per edge. The
     * intermediate sample points are never grid-aligned → they can NEVER hit
     * the SDF cache → permanent cold BVH misses on every A* frame. With 26
     * neighbors × 600 expansions this means ~30,000–60,000 uncacheable BVH
     * queries per hover frame regardless of how warm the cache is.
     *
     * With endpoint-only checks, each neighbor issues exactly 1 BVH query at a
     * grid-aligned position that IS cached after first visit. Cold cost drops
     * from ~30k to ~600 BVH calls on first approach to a new region.
     *
     * Trade-off: geometry thinner than the grid step (2mm) is not detected.
     * Acceptable for hover preview — click-time always uses full resolution.
     */
    endpointOnlyCollisionCheck?: boolean;
}

export interface GridAStarResult {
    /** Waypoints from socketPos down toward rootTopZ (excludes start, includes goal). */
    path: Vec3[];
    /** Number of node expansions used. */
    expansions: number;
    /** Whether the path reached the goal region. */
    reached: boolean;
    /** True if the search was terminated early due to lack of Z progress (cavity). */
    stagnated: boolean;
    /** True if the search exhausted its expansion budget without reaching the goal.
     *  Distinct from stagnated: the search was making progress but ran out of budget.
     *  When true, V1 raycast fallback is also very unlikely to succeed. */
    hitExpansionLimit: boolean;
    /** Reusable warm-start state for the next frame. */
    warmState: WarmStartState | null;
}

export interface WarmStartState {
    /** Socket position used for this search (for invalidation). */
    socketPos: Vec3;
    /** Serialised open-set entries and g-scores. */
    openEntries: AStarEntry[];
    gScores: Map<number, number>;
    cameFrom: Map<number, number>;
}

// ---------- Internal ----------

interface AStarEntry {
    key: number;
    x: number;
    y: number;
    z: number;
    f: number; // g + h
    g: number;
}

interface NeighborRuntime {
    dx: number;
    dy: number;
    dz: number;
    /** sqrt(dx^2 + dy^2 + dz^2) */
    stepCostFactor: number;
    /** sqrt(dx^2 + dy^2) */
    lateralCells: number;
    /** lateral/drop for downward moves; Infinity otherwise */
    lateralPerDrop: number;
}

// 26-connected neighborhood offsets (no (0,0,0))
const NEIGHBORS: ReadonlyArray<{ dx: number; dy: number; dz: number; cost: number }> = (() => {
    const out: { dx: number; dy: number; dz: number; cost: number }[] = [];
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            for (let dz = -1; dz <= 1; dz++) {
                if (dx === 0 && dy === 0 && dz === 0) continue;
                out.push({ dx, dy, dz, cost: Math.sqrt(dx * dx + dy * dy + dz * dz) });
            }
        }
    }
    return out;
})();

const NEIGHBOR_RUNTIME: ReadonlyArray<NeighborRuntime> = NEIGHBORS.map((n) => {
    const lateralCells = Math.sqrt(n.dx * n.dx + n.dy * n.dy);
    const lateralPerDrop = n.dz < 0 ? (lateralCells / Math.abs(n.dz)) : Infinity;
    return {
        dx: n.dx,
        dy: n.dy,
        dz: n.dz,
        stepCostFactor: n.cost,
        lateralCells,
        lateralPerDrop,
    };
});

function cellKeyInt(qx: number, qy: number, qz: number): number {
    const ux = (qx + 0x4000) | 0;
    const uy = (qy + 0x4000) | 0;
    const uz = (qz + 0x4000) | 0;
    return (ux * 0x8000 + uy) * 0x8000 + uz;
}

// ---------- Min-heap for A* open set ----------

function heapPush(heap: AStarEntry[], entry: AStarEntry): void {
    heap.push(entry);
    let i = heap.length - 1;
    while (i > 0) {
        const pi = (i - 1) >> 1;
        if (heap[pi].f <= heap[i].f) break;
        [heap[pi], heap[i]] = [heap[i], heap[pi]];
        i = pi;
    }
}

function heapPop(heap: AStarEntry[]): AStarEntry | undefined {
    if (heap.length <= 1) return heap.pop();
    const top = heap[0];
    heap[0] = heap.pop()!;
    let i = 0;
    const len = heap.length;
    while (true) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < len && heap[l].f < heap[smallest].f) smallest = l;
        if (r < len && heap[r].f < heap[smallest].f) smallest = r;
        if (smallest === i) break;
        [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
        i = smallest;
    }
    return top;
}

// ---------- Heuristic ----------

/** Octile-distance heuristic in 3D (admissible for 26-connected grids). */
function heuristic(qx: number, qy: number, qz: number, gqx: number, gqy: number, gqz: number): number {
    let dx = Math.abs(qx - gqx);
    let dy = Math.abs(qy - gqy);
    let dz = Math.abs(qz - gqz);

    // Sort so dx >= dy >= dz
    if (dx < dy) { const t = dx; dx = dy; dy = t; }
    if (dx < dz) { const t = dx; dx = dz; dz = t; }
    if (dy < dz) { const t = dy; dy = dz; dz = t; }

    // 3D octile: face-diag = √2, space-diag = √3
    const SQRT2 = 1.4142135623730951;
    const SQRT3 = 1.7320508075688772;
    return (dx - dy) + (dy - dz) * SQRT2 + dz * SQRT3;
}

// ---------- Public API ----------

/**
 * Runs a grid-based A* from `startPos` downward toward `goalZ`,
 * keeping the path within `maxLateralMm` of the start XY and avoiding
 * cells where `sdf.distanceAt < clearanceMm` or occupancy is set.
 *
 * @returns Path + warm-start state for the next call.
 */
export function gridAStar(
    sdf: SDFCache,
    startPos: Vec3,
    goalZ: number,
    opts: GridAStarOptions,
    warmStart?: WarmStartState | null,
): GridAStarResult {
    const step = opts.stepMm ?? 2.0; // Coarse grid for pathfinding (2mm default)
    const invStep = 1 / step;
    const maxExp = opts.maxExpansions ?? 2000;
    const clearance = opts.clearanceMm;
    const maxLateral = opts.maxLateralMm ?? 30;
    const maxLateralSq = maxLateral * maxLateral;
    const occupancy = opts.occupancy;
    const ignoreSupportId = opts.ignoreSupportId;
    const endpointOnlyCollisionCheck = !!opts.endpointOnlyCollisionCheck;

    // Angle constraint: minimum angle from vertical in degrees
    // Converted to maximum lateral-per-vertical ratio
    const minAngleFromVertDeg = opts.minAngleFromVerticalDeg ?? 15;
    const maxLateralPerDrop = Math.tan((minAngleFromVertDeg * Math.PI) / 180);
    const goalValidator = opts.goalValidator;

    // Per-neighbor static costs (independent of node position).
    const neighborStaticCosts = new Array<number>(NEIGHBOR_RUNTIME.length);
    for (let i = 0; i < NEIGHBOR_RUNTIME.length; i++) {
        const n = NEIGHBOR_RUNTIME[i];
        const moveCost = n.stepCostFactor * step;
        const verticalityPenalty = n.lateralCells * step * 1.5;
        let shallowAnglePenalty = 0;
        if (n.lateralCells > 0) {
            if (n.dz !== 0) {
                const ratio = n.lateralPerDrop;
                shallowAnglePenalty = ratio * ratio * step * 0.8;
            } else {
                // Pure horizontal: maximum angle penalty
                shallowAnglePenalty = step * 4.0;
            }
        }
        const climbPenalty = n.dz > 0 ? step * 3 : 0;
        neighborStaticCosts[i] = moveCost + verticalityPenalty + shallowAnglePenalty + climbPenalty;
    }

    // Maximum upward climb in grid cells — allows routing over protrusions
    // but prevents the path from going far above the socket
    const maxClimbCells = Math.max(5, Math.ceil(20 / step)); // up to ~20mm above start

    const q = (v: number) => Math.round(v * invStep);

    // Quantized start / goal
    const sqx = q(startPos.x);
    const sqy = q(startPos.y);
    const sqz = q(startPos.z);
    const gqz = q(goalZ);

    // ---- Warm-start or fresh ----
    let openSet: AStarEntry[];
    const gScore: Map<number, number> = new Map();
    const cameFrom: Map<number, number> = new Map();
    const closedSet = new Set<number>();

    const canWarmStart = warmStart &&
        Math.abs(warmStart.socketPos.x - startPos.x) < step * 2 &&
        Math.abs(warmStart.socketPos.y - startPos.y) < step * 2 &&
        Math.abs(warmStart.socketPos.z - startPos.z) < step * 2;

    if (canWarmStart && warmStart) {
        // Re-seed from previous search state
        openSet = [...warmStart.openEntries];
        for (const [k, v] of warmStart.gScores) gScore.set(k, v);
        for (const [k, v] of warmStart.cameFrom) cameFrom.set(k, v);
    } else {
        const startKey = cellKeyInt(sqx, sqy, sqz);
        const h = Math.max(0, sqz - gqz); // pure vertical heuristic
        openSet = [];
        heapPush(openSet, { key: startKey, x: sqx, y: sqy, z: sqz, g: 0, f: h });
        gScore.set(startKey, 0);
    }

    let expansions = 0;
    let goalEntry: AStarEntry | null = null;

    const STAGNATION_LIMIT = 600;
    let bestZReached = sqz;
    let lastZProgressAt = 0;

    while (openSet.length > 0 && expansions < maxExp) {
        const current = heapPop(openSet)!;
        if (closedSet.has(current.key)) continue;
        closedSet.add(current.key);
        expansions++;

        if (current.z < bestZReached) {
            bestZReached = current.z;
            lastZProgressAt = expansions;
        }
        if (expansions - lastZProgressAt > STAGNATION_LIMIT) break;

        if (current.z <= gqz) {
            if (!goalValidator || goalValidator(current.x * step, current.y * step, current.z * step)) {
                goalEntry = current;
                break;
            }
        }

        const cwx = current.x * step;
        const cwy = current.y * step;
        const cwz = current.z * step;

        for (let ni = 0; ni < NEIGHBOR_RUNTIME.length; ni++) {
            const n = NEIGHBOR_RUNTIME[ni];
            const nx = current.x + n.dx;
            const ny = current.y + n.dy;
            const nz = current.z + n.dz;

            if (n.dz > 0 && nz > sqz + maxClimbCells) continue;

            const nKey = cellKeyInt(nx, ny, nz);
            if (closedSet.has(nKey)) continue;

            const latX = (nx - sqx) * step;
            const latY = (ny - sqy) * step;
            const lateralSq = latX * latX + latY * latY;
            if (lateralSq > maxLateralSq) continue;

            if (n.dz < 0 && n.lateralPerDrop > maxLateralPerDrop) continue;

            const wx = nx * step;
            const wy = ny * step;
            const wz = nz * step;

            if (endpointOnlyCollisionCheck
                ? sdf.isBlocked(wx, wy, wz, clearance)
                : sdf.segmentBlocked(cwx, cwy, cwz, wx, wy, wz, clearance)
            ) continue;

            if (occupancy && occupancy.isOccupied(wx, wy, wz, ignoreSupportId)) continue;

            const dist = sdf.distanceAt(wx, wy, wz);
            const clearancePenalty = dist < clearance * 2 ? (clearance * 2 - dist) * 0.5 : 0;
            const tentativeG = current.g + neighborStaticCosts[ni] + clearancePenalty;

            const existingG = gScore.get(nKey);
            if (existingG !== undefined && tentativeG >= existingG) continue;

            gScore.set(nKey, tentativeG);
            cameFrom.set(nKey, current.key);

            const h = Math.max(0, nz - gqz);
            heapPush(openSet, { key: nKey, x: nx, y: ny, z: nz, g: tentativeG, f: tentativeG + h });
        }
    }

    const stagnated = !goalEntry && (expansions - lastZProgressAt > STAGNATION_LIMIT);
    const hitExpansionLimit = !goalEntry && !stagnated && expansions >= maxExp;

    if (!goalEntry) {
        return {
            path: [],
            expansions,
            reached: false,
            stagnated,
            hitExpansionLimit,
            warmState: stagnated ? null : {
                socketPos: { ...startPos },
                openEntries: openSet.slice(0, 64),
                gScores: gScore,
                cameFrom,
            },
        };
    }

    const rawPath: Vec3[] = [];
    let traceKey = goalEntry.key;

    function decodeKey(key: number): { x: number; y: number; z: number } {
        const uz = key % 0x8000;
        const rem = (key - uz) / 0x8000;
        const uy = rem % 0x8000;
        const ux = (rem - uy) / 0x8000;
        return { x: ux - 0x4000, y: uy - 0x4000, z: uz - 0x4000 };
    }

    while (traceKey !== undefined) {
        const coords = decodeKey(traceKey);
        rawPath.push({
            x: coords.x * step,
            y: coords.y * step,
            z: coords.z * step,
        });
        const parent = cameFrom.get(traceKey);
        if (parent === undefined) break;
        traceKey = parent;
    }

    rawPath.reverse();

    const simplified = simplifyPath(rawPath, sdf, clearance, step, endpointOnlyCollisionCheck);

    return {
        path: simplified,
        expansions,
        reached: true,
        stagnated: false,
        hitExpansionLimit: false,
        warmState: {
            socketPos: { ...startPos },
            openEntries: [],
            gScores: gScore,
            cameFrom,
        },
    };
}

// ---------- Path simplification ----------

/**
 * Greedy line-of-sight simplification: keep only waypoints where the
 * direct segment to the next kept waypoint would be blocked.
 * This turns a zig-zag grid path into clean straight segments with
 * joints only where needed to avoid geometry.
 */
function simplifyPath(path: Vec3[], sdf: SDFCache, clearance: number, step: number, previewFastMode = false): Vec3[] {
    if (path.length <= 2) return path;

    // First pass: enforce Z-monotonicity.  The A* allows limited upward
    // movement to route around protrusions, but the final support must
    // only descend. Walk the path and track the running Z minimum;
    // remove any waypoint that rises above the envelope.
    let monoPath: Vec3[] = [path[0]];
    let minZ = path[0].z;
    for (let i = 1; i < path.length; i++) {
        if (path[i].z <= minZ) {
            monoPath.push(path[i]);
            minZ = path[i].z;
        }
        // else: skip — this point rises above the descending envelope
    }
    if (monoPath.length <= 2) return monoPath;

    // Preview fast-mode (endpoint-only A*): preserve path geometry while
    // removing only strictly co-linear runs. This avoids expensive LOS
    // segmentBlocked sweeps in hover mode without changing the polyline's
    // occupied space.
    if (previewFastMode) {
        const out: Vec3[] = [monoPath[0]];
        for (let i = 1; i < monoPath.length - 1; i++) {
            const a = monoPath[i - 1];
            const b = monoPath[i];
            const c = monoPath[i + 1];

            const d1x = Math.round((b.x - a.x) / step);
            const d1y = Math.round((b.y - a.y) / step);
            const d1z = Math.round((b.z - a.z) / step);
            const d2x = Math.round((c.x - b.x) / step);
            const d2y = Math.round((c.y - b.y) / step);
            const d2z = Math.round((c.z - b.z) / step);

            if (d1x === d2x && d1y === d2y && d1z === d2z) continue;
            out.push(b);
        }
        out.push(monoPath[monoPath.length - 1]);
        return out;
    }

    // Second pass: greedy line-of-sight collapse.
    const result: Vec3[] = [monoPath[0]];
    let anchor = 0;

    for (let probe = 2; probe < monoPath.length; probe++) {
        const a = monoPath[anchor];
        const b = monoPath[probe];

        if (sdf.segmentBlocked(a.x, a.y, a.z, b.x, b.y, b.z, clearance)) {
            // Can't skip monoPath[probe-1], it's needed as a joint
            result.push(monoPath[probe - 1]);
            anchor = probe - 1;
        }
    }

    result.push(monoPath[monoPath.length - 1]);
    return result;
}
