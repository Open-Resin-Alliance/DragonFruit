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
    const maxExp = opts.maxExpansions ?? 2000;
    const clearance = opts.clearanceMm;
    const maxLateral = opts.maxLateralMm ?? 30;
    const occupancy = opts.occupancy;
    const ignoreSupportId = opts.ignoreSupportId;

    // Angle constraint: minimum angle from vertical in degrees
    // Converted to maximum lateral-per-vertical ratio
    const minAngleFromVertDeg = opts.minAngleFromVerticalDeg ?? 15;
    const maxLateralPerDrop = Math.tan((minAngleFromVertDeg * Math.PI) / 180);
    const goalValidator = opts.goalValidator;

    // Maximum upward climb in grid cells — allows routing over protrusions
    // but prevents the path from going far above the socket
    const maxClimbCells = Math.max(5, Math.ceil(20 / step)); // up to ~20mm above start

    const q = (v: number) => Math.round(v / step);

    // Quantized start / goal
    const sqx = q(startPos.x);
    const sqy = q(startPos.y);
    const sqz = q(startPos.z);
    const gqz = q(goalZ);

    // Goal column (directly below start) — we accept any cell at goalZ
    const gqx = sqx;
    const gqy = sqy;

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
        const h = heuristic(sqx, sqy, sqz, gqx, gqy, gqz);
        openSet = [];
        heapPush(openSet, { key: startKey, x: sqx, y: sqy, z: sqz, g: 0, f: h });
        gScore.set(startKey, 0);
    }

    let expansions = 0;
    let goalEntry: AStarEntry | null = null;

    // Stagnation detection: bail early when the search is trapped in a
    // cavity and cannot make downward progress. Track the lowest Z reached
    // and the expansion count when it last improved. If 250 expansions pass
    // without any Z improvement, the search is stuck and will never reach
    // the goal — abort instead of burning the full 2000-expansion budget.
    const STAGNATION_LIMIT = 250;
    let bestZReached = sqz;
    let lastZProgressAt = 0;

    while (openSet.length > 0 && expansions < maxExp) {
        const current = heapPop(openSet)!;
        if (closedSet.has(current.key)) continue;
        closedSet.add(current.key);
        expansions++;

        // Track Z progress for stagnation detection
        if (current.z < bestZReached) {
            bestZReached = current.z;
            lastZProgressAt = expansions;
        }
        if (expansions - lastZProgressAt > STAGNATION_LIMIT) break;

        // Goal check: reached the target Z layer
        if (current.z <= gqz) {
            // Validate the goal position (e.g., roots collision check).
            // If validation fails, DON'T break — continue searching for a
            // valid goal position by exploring laterally at this Z level.
            if (!goalValidator || goalValidator(current.x * step, current.y * step, current.z * step)) {
                goalEntry = current;
                break;
            }
            // Invalid goal — fall through to neighbor expansion so the
            // search can explore adjacent cells at the goal level.
        }

        for (let ni = 0; ni < NEIGHBORS.length; ni++) {
            const n = NEIGHBORS[ni];
            const nx = current.x + n.dx;
            const ny = current.y + n.dy;
            const nz = current.z + n.dz;

            // Allow limited upward movement to route around protrusions.
            // Without this, any geometry between socket and base is impassable.
            if (n.dz > 0) {
                // Only allow climbing up to maxClimbCells above the start
                if (nz > sqz + maxClimbCells) continue;
            }

            const nKey = cellKeyInt(nx, ny, nz);
            if (closedSet.has(nKey)) continue;

            // Lateral constraint
            const latX = (nx - sqx) * step;
            const latY = (ny - sqy) * step;
            const lateral = Math.sqrt(latX * latX + latY * latY);
            if (lateral > maxLateral) continue;

            // Angle constraint for downward movement
            if (n.dz < 0) {
                // Has vertical drop — check ratio
                const localLateral = Math.sqrt(n.dx * n.dx + n.dy * n.dy) * step;
                const localDrop = Math.abs(n.dz) * step;
                if (localDrop > 0 && localLateral / localDrop > maxLateralPerDrop) continue;
            } else if (n.dz === 0) {
                // Purely horizontal — allow near the goal level to enable
                // lateral search for valid roots positions. Also allow above
                // the socket for climbing around protrusions.
                const nearGoal = (current.z - gqz) <= 3;
                const aboveStart = current.z >= sqz;
                if (!nearGoal && !aboveStart && minAngleFromVertDeg < 89) continue;
            }
            // n.dz > 0 (upward) — no angle constraint, always allowed if within climb limit

            // SDF collision check.
            // Full mode: fine-resolution segment check at SDF cellSize intervals.
            // Endpoint-only mode (preview): just check the destination cell.
            //   The intermediate sample points in segmentBlocked are NOT grid-aligned
            //   and can never hit the SDF cache, producing permanent cold BVH misses
            //   on every frame. Endpoint cells ARE on the 2mm grid and are cached
            //   after first visit, so preview A* becomes cheap on revisits.
            const cwx = current.x * step;
            const cwy = current.y * step;
            const cwz = current.z * step;
            const wx = nx * step;
            const wy = ny * step;
            const wz = nz * step;

            if (opts.endpointOnlyCollisionCheck
                ? sdf.isBlocked(wx, wy, wz, clearance)
                : sdf.segmentBlocked(cwx, cwy, cwz, wx, wy, wz, clearance)
            ) continue;

            // Support occupancy check
            if (occupancy && occupancy.isOccupied(wx, wy, wz, ignoreSupportId)) continue;

            // ---- Priority-based cost function ----
            //
            // 1. Shortest collision-free path (base euclidean distance)
            // 2. Greatest verticality   (penalise lateral XY movement)
            // 3. Least shallow angles   (penalise high lateral-to-drop ratio)

            // (1) Base movement cost — euclidean distance in mm
            const moveCost = n.cost * step;

            // (2) Verticality penalty — pure-vertical moves are free;
            //     lateral component is penalised proportionally.
            const lateralCells = Math.sqrt(n.dx * n.dx + n.dy * n.dy);
            const verticalityPenalty = lateralCells * step * 1.5;

            // (3) Shallow-angle penalty — quadratic in lateral/drop ratio
            //     so near-vertical moves are cheap; near-horizontal expensive.
            let shallowAnglePenalty = 0;
            if (lateralCells > 0) {
                if (n.dz !== 0) {
                    const ratio = lateralCells / Math.abs(n.dz);
                    shallowAnglePenalty = ratio * ratio * step * 0.8;
                } else {
                    // Pure horizontal: maximum angle penalty
                    shallowAnglePenalty = step * 4.0;
                }
            }

            // Proximity penalty — prefer paths with more clearance from mesh
            const dist = sdf.distanceAt(wx, wy, wz);
            const clearancePenalty = dist < clearance * 2 ? (clearance * 2 - dist) * 0.5 : 0;

            // Climb penalty — heavily discourage upward movement
            const climbPenalty = n.dz > 0 ? step * 3 : 0;

            const tentativeG = current.g + moveCost + verticalityPenalty + shallowAnglePenalty + clearancePenalty + climbPenalty;

            const existingG = gScore.get(nKey);
            if (existingG !== undefined && tentativeG >= existingG) continue;

            gScore.set(nKey, tentativeG);
            cameFrom.set(nKey, current.key);

            const h = heuristic(nx, ny, nz, gqx, gqy, gqz);
            heapPush(openSet, { key: nKey, x: nx, y: ny, z: nz, g: tentativeG, f: tentativeG + h });
        }
    }

    // ---- Reconstruct path ----
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
    // Decode key back to coords via the gScore chain
    // We need coord tracking — build a lookup
    const keyToCoord = new Map<number, { x: number; y: number; z: number }>();
    // Collect from gScore keys by replaying
    // More efficient: we stored entries, so collect from closed set
    // Actually, we only need the path. Let's trace via cameFrom using stored coords.
    // Since we don't store coords per key, rebuild from the search.
    // Better approach: store coords alongside cameFrom.

    // We'll use a different data structure. Let's build coord map from all entries we processed.
    // For efficiency, use a parallel map.
    // Actually for the grid A*, we can decode coordinates from the key directly.

    // Decode key → coords
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

    rawPath.reverse(); // Now goes from start → goal

    // Simplify: remove co-linear intermediate points to produce joints
    const simplified = simplifyPath(rawPath, sdf, clearance, step);

    return {
        path: simplified,
        expansions,
        reached: true,
        stagnated: false,
        hitExpansionLimit: false,
        warmState: {
            socketPos: { ...startPos },
            openEntries: [], // search complete, no reuse needed
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
function simplifyPath(path: Vec3[], sdf: SDFCache, clearance: number, step: number): Vec3[] {
    if (path.length <= 2) return path;

    const result: Vec3[] = [path[0]];
    let anchor = 0;

    for (let probe = 2; probe < path.length; probe++) {
        const a = path[anchor];
        const b = path[probe];

        if (sdf.segmentBlocked(a.x, a.y, a.z, b.x, b.y, b.z, clearance)) {
            // Can't skip path[probe-1], it's needed as a joint
            result.push(path[probe - 1]);
            anchor = probe - 1;
        }
    }

    result.push(path[path.length - 1]);
    return result;
}
