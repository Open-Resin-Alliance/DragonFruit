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
    goalValidator?: (wx: number, wy: number, wz: number, parentPos: Vec3 | null) => boolean;
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
    /** Optional label used by the pathfinding debug overlay. */
    debugLabel?: string;
    /** When true, capture expanded/frontier/path snapshots for the debug overlay. */
    captureDebug?: boolean;
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
    /** Optional debug snapshot of the explored cells and solved path. */
    debug?: GridAStarDebugSnapshot;
}

export interface WarmStartState {
    /** Socket position used for this search (for invalidation). */
    socketPos: Vec3;
    /** Serialised open-set entries and g-scores. */
    openEntries: AStarEntry[];
    gScores: Map<number, number>;
    cameFrom: Map<number, number>;
}

export interface GridAStarDebugSnapshot {
    label: string;
    searchStepMm: number;
    expansions: number;
    reached: boolean;
    stagnated: boolean;
    hitExpansionLimit: boolean;
    expandedNodes: Vec3[];
    frontierNodes: Vec3[];
    rawPath: Vec3[];
    simplifiedPath: Vec3[];
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

interface NodeRuntimeState {
    g: number;
    cameFrom?: number;
    closed: boolean;
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

type DistanceAtWithin = (wx: number, wy: number, wz: number, maxDistance: number) => number;

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
    // Long pure-down strides keep tall, mostly vertical routes from spending
    // one expansion per fine Z cell. These edges are still segment-checked.
    for (const dz of [-2, -4, -8]) {
        out.push({ dx: 0, dy: 0, dz, cost: Math.abs(dz) });
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

const PURE_DOWN_PRIORITY_INDICES = NEIGHBOR_RUNTIME
    .map((n, index) => ({ n, index }))
    .filter(({ n }) => n.dx === 0 && n.dy === 0 && n.dz < 0)
    .sort((a, b) => Math.abs(b.n.dz) - Math.abs(a.n.dz))
    .map(({ index }) => index);

const STRAIGHT_DESCENT_CLEARANCE_FACTOR = 2;

function cellKeyInt(qx: number, qy: number, qz: number): number {
    const ux = (qx + 0x4000) | 0;
    const uy = (qy + 0x4000) | 0;
    const uz = (qz + 0x4000) | 0;
    return (ux * 0x8000 + uy) * 0x8000 + uz;
}

// ---------- Min-heap for A* open set ----------

type HeapCompare = (a: AStarEntry, b: AStarEntry) => number;

function heapSwap(heap: AStarEntry[], heapIndexByKey: Map<number, number>, i: number, j: number): void {
    const a = heap[i];
    const b = heap[j];
    heap[i] = b;
    heap[j] = a;
    heapIndexByKey.set(a.key, j);
    heapIndexByKey.set(b.key, i);
}

function heapSiftUp(heap: AStarEntry[], heapIndexByKey: Map<number, number>, startIndex: number, compare: HeapCompare): void {
    let i = startIndex;
    while (i > 0) {
        const pi = (i - 1) >> 1;
        if (compare(heap[pi], heap[i]) <= 0) break;
        heapSwap(heap, heapIndexByKey, pi, i);
        i = pi;
    }
}

function heapSiftDown(heap: AStarEntry[], heapIndexByKey: Map<number, number>, startIndex: number, compare: HeapCompare): void {
    let i = startIndex;
    const len = heap.length;
    while (true) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < len && compare(heap[l], heap[smallest]) < 0) smallest = l;
        if (r < len && compare(heap[r], heap[smallest]) < 0) smallest = r;
        if (smallest === i) break;
        heapSwap(heap, heapIndexByKey, i, smallest);
        i = smallest;
    }
}

function heapPushOrUpdate(
    heap: AStarEntry[],
    heapIndexByKey: Map<number, number>,
    entry: AStarEntry,
    compare: HeapCompare,
): void {
    const existingIndex = heapIndexByKey.get(entry.key);
    if (existingIndex !== undefined) {
        const existing = heap[existingIndex];
        if (compare(entry, existing) >= 0) {
            return;
        }
        heap[existingIndex] = entry;
        heapIndexByKey.set(entry.key, existingIndex);
        heapSiftUp(heap, heapIndexByKey, existingIndex, compare);
        heapSiftDown(heap, heapIndexByKey, heapIndexByKey.get(entry.key)!, compare);
        return;
    }

    heap.push(entry);
    const index = heap.length - 1;
    heapIndexByKey.set(entry.key, index);
    heapSiftUp(heap, heapIndexByKey, index, compare);
}

function heapPopIndexed(heap: AStarEntry[], heapIndexByKey: Map<number, number>, compare: HeapCompare): AStarEntry | undefined {
    if (heap.length === 0) return undefined;
    const top = heap[0];
    heapIndexByKey.delete(top.key);

    if (heap.length === 1) {
        heap.pop();
        return top;
    }

    const last = heap.pop()!;
    heap[0] = last;
    heapIndexByKey.set(last.key, 0);
    heapSiftDown(heap, heapIndexByKey, 0, compare);
    return top;
}

// ---------- Heuristic ----------

/** Octile-distance heuristic in 3D (admissible for 26-connected grids). */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
    const maxExp = opts.maxExpansions ?? 1000;
    const clearance = opts.clearanceMm;
    const maxLateral = opts.maxLateralMm ?? 30;
    const maxLateralSq = maxLateral * maxLateral;
    const occupancy = opts.occupancy;
    const ignoreSupportId = opts.ignoreSupportId;
    const endpointOnlyCollisionCheck = !!opts.endpointOnlyCollisionCheck;
    const captureDebug = !!opts.captureDebug;
    const nodeDistanceMaxMm = clearance * 2;
    const sdfWithThreshold = sdf as SDFCache & { distanceAtWithin?: DistanceAtWithin };
    const distanceAtWithin = typeof sdfWithThreshold.distanceAtWithin === 'function'
        ? sdfWithThreshold.distanceAtWithin.bind(sdf)
        : null;

    // Angle constraint: minimum angle from vertical in degrees
    // Converted to maximum lateral-per-vertical ratio
    const minAngleFromVertDeg = opts.minAngleFromVerticalDeg ?? 15;
    const maxLateralPerDrop = Math.tan((minAngleFromVertDeg * Math.PI) / 180);
    const goalValidator = opts.goalValidator;
    const goalPlaneHeuristic = (qz: number): number => Math.max(0, qz - gqz) * step;

    // Per-neighbor static costs (independent of node position).
    // Resin printing philosophy: go straight down. Only deviate the minimum
    // amount needed to clear an obstruction.  Lateral and shallow-angle
    // movement are heavily penalised so the A* treats them as a last resort.
    const neighborStaticCosts = new Array<number>(NEIGHBOR_RUNTIME.length);
    for (let i = 0; i < NEIGHBOR_RUNTIME.length; i++) {
        const n = NEIGHBOR_RUNTIME[i];
        const moveCost = n.stepCostFactor * step;
        // Strong penalty for any lateral (XY) displacement — each 1mm lateral
        // costs ~2.5mm of vertical equivalent.
        const verticalityPenalty = n.lateralCells * step * 2.5;
        let shallowAnglePenalty = 0;
        if (n.lateralCells > 0) {
            if (n.dz !== 0) {
                const ratio = n.lateralPerDrop;
                // Quadratic penalty on shallow angles — moving at 45° from
                // vertical costs much more than moving at 15°.
                shallowAnglePenalty = ratio * ratio * step * 1.5;
            } else {
                // Pure horizontal: nearly forbidden — only used when absolutely
                // necessary to route around a thin obstruction.
                shallowAnglePenalty = step * 8.0;
            }
        }
        // Climbing (moving upward): heavily penalised — only for escaping
        // local concavities, not for "reach-around" routes.
        const climbPenalty = n.dz > 0 ? step * 5 : 0;
        neighborStaticCosts[i] = moveCost + verticalityPenalty + shallowAnglePenalty + climbPenalty;
    }

    // Maximum upward climb: tight limit so the A* can't "reach around" overhangs
    // by climbing far above the socket.  Small climbs (~12mm) are allowed for
    // escaping local concavities.
    const maxClimbCells = Math.max(3, Math.ceil(12 / step));

    const q = (v: number) => Math.round(v * invStep);
    const compareHeapEntries: HeapCompare = (a, b) => {
        const fDiff = a.f - b.f;
        if (Math.abs(fDiff) > 1e-12) return fDiff;

        const zDiff = a.z - b.z;
        if (zDiff !== 0) return zDiff;

        const aLatSq = (a.x - sqx) * (a.x - sqx) + (a.y - sqy) * (a.y - sqy);
        const bLatSq = (b.x - sqx) * (b.x - sqx) + (b.y - sqy) * (b.y - sqy);
        return aLatSq - bLatSq;
    };

    // Quantized start / goal
    const sqx = q(startPos.x);
    const sqy = q(startPos.y);
    const sqz = q(startPos.z);
    const gqz = q(goalZ);

    // ---- Warm-start or fresh ----
    let openSet: AStarEntry[];
    const openSetIndexByKey = new Map<number, number>();
    const nodeState = new Map<number, NodeRuntimeState>();

    const canWarmStart = warmStart &&
        Math.abs(warmStart.socketPos.x - startPos.x) < step * 2 &&
        Math.abs(warmStart.socketPos.y - startPos.y) < step * 2 &&
        Math.abs(warmStart.socketPos.z - startPos.z) < step * 2;

    if (canWarmStart && warmStart) {
        // Re-seed from previous search state
        openSet = [];
        for (const [k, v] of warmStart.gScores) {
            const existing = nodeState.get(k);
            if (existing) {
                existing.g = v;
            } else {
                nodeState.set(k, { g: v, closed: false });
            }
        }
        for (const [k, v] of warmStart.cameFrom) {
            const existing = nodeState.get(k);
            if (existing) {
                existing.cameFrom = v;
            } else {
                nodeState.set(k, { g: Infinity, cameFrom: v, closed: false });
            }
        }
        for (const entry of warmStart.openEntries) {
            heapPushOrUpdate(openSet, openSetIndexByKey, entry, compareHeapEntries);
        }
    } else {
        const startKey = cellKeyInt(sqx, sqy, sqz);
        const h = goalPlaneHeuristic(sqz);
        openSet = [];
        heapPushOrUpdate(openSet, openSetIndexByKey, { key: startKey, x: sqx, y: sqy, z: sqz, g: 0, f: h }, compareHeapEntries);
        nodeState.set(startKey, { g: 0, closed: false });
    }

    let expansions = 0;
    let goalEntry: AStarEntry | null = null;
    const debugExpandedNodes: Vec3[] = [];
    const edgeBlockedCache = new Map<number, Map<number, boolean>>();
    const nodeDistanceCache = new Map<number, number>();
    const occupancyCache = new Map<number, boolean>();

    const STAGNATION_LIMIT = 400;
    let bestZReached = sqz;
    let lastZProgressAt = 0;

    function decodeKey(key: number): { x: number; y: number; z: number } {
        const uz = key % 0x8000;
        const rem = (key - uz) / 0x8000;
        const uy = rem % 0x8000;
        const ux = (rem - uy) / 0x8000;
        return { x: ux - 0x4000, y: uy - 0x4000, z: uz - 0x4000 };
    }

    function getNodeDistance(key: number, wx: number, wy: number, wz: number): number {
        const cached = nodeDistanceCache.get(key);
        if (cached !== undefined) return cached;
        const distance = distanceAtWithin
            ? distanceAtWithin(wx, wy, wz, nodeDistanceMaxMm)
            : sdf.distanceAt(wx, wy, wz);
        nodeDistanceCache.set(key, distance);
        return distance;
    }

    function getEdgeBlocked(
        aKey: number,
        bKey: number,
        compute: () => boolean,
    ): boolean {
        const lowKey = aKey < bKey ? aKey : bKey;
        const highKey = aKey < bKey ? bKey : aKey;
        let highMap = edgeBlockedCache.get(lowKey);
        if (!highMap) {
            highMap = new Map<number, boolean>();
            edgeBlockedCache.set(lowKey, highMap);
        } else {
            const cached = highMap.get(highKey);
            if (cached !== undefined) return cached;
        }
        const blocked = compute();
        highMap.set(highKey, blocked);
        return blocked;
    }

    function getSegmentMoveBlocked(
        aKey: number,
        bKey: number,
        ax: number,
        ay: number,
        az: number,
        bx: number,
        by: number,
        bz: number,
    ): boolean {
        return getEdgeBlocked(
            aKey,
            bKey,
            () => {
                if (occupancy?.segmentOccupied(
                    ax,
                    ay,
                    az,
                    bx,
                    by,
                    bz,
                    Math.min(step, occupancy.cellSize),
                    ignoreSupportId,
                )) {
                    return true;
                }
                return sdf.segmentBlocked(ax, ay, az, bx, by, bz, clearance);
            },
        );
    }

    function getNodeOccupied(key: number, wx: number, wy: number, wz: number): boolean {
        const cached = occupancyCache.get(key);
        if (cached !== undefined) return cached;
        const occupied = occupancy ? occupancy.isOccupied(wx, wy, wz, ignoreSupportId) : false;
        occupancyCache.set(key, occupied);
        return occupied;
    }

    function chooseStraightDescentIndex(current: AStarEntry, cwx: number, cwy: number, cwz: number): number {
        const minStraightClearance = clearance * STRAIGHT_DESCENT_CLEARANCE_FACTOR;
        for (const ni of PURE_DOWN_PRIORITY_INDICES) {
            const n = NEIGHBOR_RUNTIME[ni];
            let nz = current.z + n.dz;
            if (nz < gqz) {
                nz = gqz;
            }
            if (nz === current.z) continue;

            const nKey = cellKeyInt(current.x, current.y, nz);
            const existingState = nodeState.get(nKey);
            if (existingState?.closed) continue;

            const wz = nz * step;
            if (occupancy && getNodeOccupied(nKey, cwx, cwy, wz)) continue;

            const dist = getNodeDistance(nKey, cwx, cwy, wz);
            if (dist < minStraightClearance) continue;
            if (getSegmentMoveBlocked(current.key, nKey, cwx, cwy, cwz, cwx, cwy, wz)) continue;

            return ni;
        }
        return -1;
    }

    while (openSet.length > 0 && expansions < maxExp) {
        const current = heapPopIndexed(openSet, openSetIndexByKey, compareHeapEntries)!;
        const currentState = nodeState.get(current.key);
        if (!currentState) continue;
        if (current.g > currentState.g) continue;
        if (currentState.closed) continue;
        currentState.closed = true;
        expansions++;
        if (captureDebug) {
            debugExpandedNodes.push({
                x: current.x * step,
                y: current.y * step,
                z: current.z * step,
            });
        }

        if (current.z < bestZReached) {
            bestZReached = current.z;
            lastZProgressAt = expansions;
        }
        if (expansions - lastZProgressAt > STAGNATION_LIMIT) break;

        if (current.z <= gqz) {
            const parentKey = currentState.cameFrom;
            const parentPos = parentKey === undefined
                ? null
                : (() => {
                    const parent = decodeKey(parentKey);
                    return {
                        x: parent.x * step,
                        y: parent.y * step,
                        z: parent.z * step,
                    };
                })();
            if (!goalValidator || goalValidator(current.x * step, current.y * step, current.z * step, parentPos)) {
                goalEntry = current;
                break;
            }
        }

        const cwx = current.x * step;
        const cwy = current.y * step;
        const cwz = current.z * step;
        const straightDescentOnlyIndex = chooseStraightDescentIndex(current, cwx, cwy, cwz);

        for (let ni = 0; ni < NEIGHBOR_RUNTIME.length; ni++) {
            if (straightDescentOnlyIndex >= 0 && ni !== straightDescentOnlyIndex) continue;

            const n = NEIGHBOR_RUNTIME[ni];
            const nx = current.x + n.dx;
            const ny = current.y + n.dy;
            let nz = current.z + n.dz;
            if (n.dz < 0 && nz < gqz) {
                nz = gqz;
            }

            if (n.dz > 0 && nz > sqz + maxClimbCells) continue;

            const nKey = cellKeyInt(nx, ny, nz);
            const existingState = nodeState.get(nKey);
            if (existingState?.closed) continue;

            const latX = (nx - sqx) * step;
            const latY = (ny - sqy) * step;
            const lateralSq = latX * latX + latY * latY;
            if (lateralSq > maxLateralSq) continue;

            if (n.dz < 0 && n.lateralPerDrop > maxLateralPerDrop) continue;

            const wx = nx * step;
            const wy = ny * step;
            const wz = nz * step;

            if (occupancy && getNodeOccupied(nKey, wx, wy, wz)) continue;

            const dist = getNodeDistance(nKey, wx, wy, wz);
            const requiresSegmentCheck = !endpointOnlyCollisionCheck || Math.abs(nz - current.z) > 1;
            if (!requiresSegmentCheck) {
                if (dist < clearance) continue;
            } else if (getSegmentMoveBlocked(current.key, nKey, cwx, cwy, cwz, wx, wy, wz)) {
                continue;
            }

            const clearancePenalty = dist < clearance * 2 ? (clearance * 2 - dist) * 0.5 : 0;
            const edgeCost = n.dx === 0 && n.dy === 0 && n.dz < -1
                ? Math.abs(nz - current.z) * step
                : neighborStaticCosts[ni];
            const tentativeG = current.g + edgeCost + clearancePenalty;

            const existingG = existingState?.g;
            if (existingG !== undefined && tentativeG >= existingG) continue;

            if (existingState) {
                existingState.g = tentativeG;
                existingState.cameFrom = current.key;
            } else {
                nodeState.set(nKey, { g: tentativeG, cameFrom: current.key, closed: false });
            }

            const h = goalPlaneHeuristic(nz);
            heapPushOrUpdate(openSet, openSetIndexByKey, { key: nKey, x: nx, y: ny, z: nz, g: tentativeG, f: tentativeG + h }, compareHeapEntries);
        }
    }

    const stagnated = !goalEntry && (expansions - lastZProgressAt > STAGNATION_LIMIT);
    const hitExpansionLimit = !goalEntry && !stagnated && expansions >= maxExp;
    const toDebugSnapshot = (
        reached: boolean,
        rawPath: Vec3[],
        simplifiedPath: Vec3[],
    ): GridAStarDebugSnapshot | undefined => captureDebug ? ({
        label: opts.debugLabel ?? 'astar',
        searchStepMm: step,
        expansions,
        reached,
        stagnated,
        hitExpansionLimit,
        expandedNodes: debugExpandedNodes,
        frontierNodes: openSet.slice(0, 128).map((entry) => ({
            x: entry.x * step,
            y: entry.y * step,
            z: entry.z * step,
        })),
        rawPath,
        simplifiedPath,
    }) : undefined;

    if (!goalEntry) {
        return {
            path: [],
            expansions,
            reached: false,
            stagnated,
            hitExpansionLimit,
            debug: toDebugSnapshot(false, [], []),
            warmState: stagnated ? null : {
                socketPos: { ...startPos },
                openEntries: openSet.slice(0, 64),
                gScores: new Map(
                    Array.from(nodeState.entries(), ([key, state]) => [key, state.g]),
                ),
                cameFrom: new Map(
                    Array.from(nodeState.entries(), ([key, state]) =>
                        state.cameFrom === undefined ? null : ([key, state.cameFrom] as [number, number]),
                    ).filter((entry): entry is [number, number] => entry !== null),
                ),
            },
        };
    }

    const rawPath: Vec3[] = [];
    let traceKey = goalEntry.key;

    while (traceKey !== undefined) {
        const coords = decodeKey(traceKey);
        rawPath.push({
            x: coords.x * step,
            y: coords.y * step,
            z: coords.z * step,
        });
        const parent = nodeState.get(traceKey)?.cameFrom;
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
        debug: toDebugSnapshot(true, rawPath, simplified),
        warmState: {
            socketPos: { ...startPos },
            openEntries: [],
            gScores: new Map(
                Array.from(nodeState.entries(), ([key, state]) => [key, state.g]),
            ),
            cameFrom: new Map(
                Array.from(nodeState.entries(), ([key, state]) =>
                    state.cameFrom === undefined ? null : ([key, state.cameFrom] as [number, number]),
                ).filter((entry): entry is [number, number] => entry !== null),
            ),
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
    const monoPath: Vec3[] = [path[0]];
    let minZ = path[0].z;
    for (let i = 1; i < path.length; i++) {
        if (path[i].z <= minZ) {
            monoPath.push(path[i]);
            minZ = path[i].z;
        }
        // else: skip — this point rises above the descending envelope
    }
    if (monoPath.length <= 2) return monoPath;

    // Preview fast-mode (endpoint-only A*): remove co-linear runs and a capped
    // number of tiny clear detours. This keeps hover responsive without
    // preserving cosmetic one-cell sidesteps as visible trunk bends.
    if (previewFastMode) {
        const out: Vec3[] = [monoPath[0]];
        let shortcutChecks = 0;
        const MAX_PREVIEW_SHORTCUT_CHECKS = 48;
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
            if (
                shortcutChecks < MAX_PREVIEW_SHORTCUT_CHECKS
                && segmentSavesMeaningfulDetour(a, b, c)
                && !sdf.segmentBlocked(a.x, a.y, a.z, c.x, c.y, c.z, clearance)
            ) {
                shortcutChecks++;
                continue;
            }
            shortcutChecks++;
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

function segmentSavesMeaningfulDetour(a: Vec3, b: Vec3, c: Vec3): boolean {
    const splitLateral = Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - b.x, c.y - b.y);
    const directLateral = Math.hypot(c.x - a.x, c.y - a.y);
    if (splitLateral - directLateral <= 0.001) return true;

    const splitLength = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2 + (b.z - a.z) ** 2)
        + Math.sqrt((c.x - b.x) ** 2 + (c.y - b.y) ** 2 + (c.z - b.z) ** 2);
    const directLength = Math.sqrt((c.x - a.x) ** 2 + (c.y - a.y) ** 2 + (c.z - a.z) ** 2);
    return splitLength - directLength <= 1.0;
}
