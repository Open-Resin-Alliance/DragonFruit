/**
 * SDFCache — Lazy, BVH-backed **Signed** Distance Field
 *
 * Wraps three-mesh-bvh's `closestPointToPoint` behind a spatial-hash cache.
 * Grid cells are computed on-demand and cached, so the A* pathfinder pays
 * at most one BVH query per unique cell — typically ~4000 lookups per
 * placement instead of thousands of 9-ray bundles.
 *
 * The distance is SIGNED: positive = outside the mesh, negative = inside.
 * This is critical because the unsigned BVH distance can't distinguish
 * inside from outside — a point 3mm deep inside the model reports dist=3,
 * which passes a 0.5mm clearance check. Signing the distance via the
 * nearest-triangle face normal ensures that interior points are always
 * detected as blocked.
 *
 * No precomputation required; the BVH is already built on every model mesh.
 */

import * as THREE from 'three';
import { quantizeToCell } from '@/utils/math';
import { ColumnClearanceMap } from './ColumnClearanceMap';

// ---------- Types ----------

export interface SDFCacheOptions {
    /** Grid cell size in mm. Smaller = more precise but more lookups. Default 0.5. */
    cellSize?: number;
}

export interface SDFQuery {
    distance: number;
    /** Nearest point on the mesh surface (world space) */
    nearestPoint: THREE.Vector3;
}

interface MeshBVHClosestPointTarget {
    point: THREE.Vector3;
    distance: number;
    faceIndex: number;
}

interface MeshBVHLike {
    closestPointToPoint(
        point: THREE.Vector3,
        target: MeshBVHClosestPointTarget,
        minThreshold?: number,
        maxThreshold?: number,
    ): MeshBVHClosestPointTarget | null;
}

// ---------- Helpers ----------

function cellKey(qx: number, qy: number, qz: number): number {
    // Cantor-style hash for three integers — faster than string keys.
    // Shift to unsigned range first (supports coords up to ±16k grid cells).
    const ux = (qx + 0x4000) | 0;
    const uy = (qy + 0x4000) | 0;
    const uz = (qz + 0x4000) | 0;
    return (ux * 0x8000 + uy) * 0x8000 + uz;
}

// ---------- Matrix drift notifications ----------

type SDFMatrixDriftListener = (meshUuid: string) => void;
const sdfMatrixDriftListeners = new Set<SDFMatrixDriftListener>();

/** Subscribe to "a mesh's world matrix changed" events, detected the next time
 *  any caller refreshes that mesh's pooled SDF. Used by world-space caches
 *  (stagnation points, placement results) whose entries are only valid for the
 *  model position they were recorded at. */
export function onSDFMatrixDrift(listener: SDFMatrixDriftListener): () => void {
    sdfMatrixDriftListeners.add(listener);
    return () => sdfMatrixDriftListeners.delete(listener);
}

function notifySDFMatrixDrift(meshUuid: string): void {
    for (const listener of sdfMatrixDriftListeners) listener(meshUuid);
}

/**
 * How far a march ever needs to know the distance.
 *
 * The march takes Lipschitz steps of `distance - clearance`, so a cell farther
 * away than the step it is about to take only has to answer "at least this far",
 * and the answer can be capped here. That cap is what lets the BVH prune: an
 * *unbounded* `closestPointToPoint` has to keep every node whose box could hold
 * the nearest triangle, which on a 505k-triangle part measured ~22us per cell —
 * and the router asks for 1.6M of them per run, 36 of its 47 seconds.
 *
 * Bounding it is verdict-preserving: every cell is still compared against its
 * clearance exactly, the march never steps past a point closer than `clearance`,
 * and the endpoint is always sampled. It only stops the march from taking one
 * enormous step through empty space, which costs a few more iterations and buys
 * the pruning.
 */
const MARCH_DISTANCE_BOUND_MM = 8;
/**
 * Slots in the cell table, as a power of two. 4M slots is 16 MB of keys plus
 * 16 MB of values, and holds ~2.8M cells before it fills; past that the cache
 * falls back to a `Map` (correct, just slower).
 */
const CELL_TABLE_SLOTS = 1 << 22;

// ---------- SDFCache ----------

export class SDFCache {
    readonly cellSize: number;

    private readonly mesh: THREE.Mesh;
    /** BVH instance from three-mesh-bvh (geometry.boundsTree) */
    private readonly bvh: MeshBVHLike;
    private inverseMatrix = new THREE.Matrix4();
    private readonly worldBounds = new THREE.Box3();
    private worldScale = 1;
    /** Fallback store, used only once the table is full. */
    private readonly cache = new Map<number, number>();
    /**
     * Open-addressed cell table: keys (-1 = empty) and their distances.
     *
     * The keys are `Float64Array`, not `Int32Array`: a cell key is a ~42-bit
     * number, and an `Int32Array` would silently truncate it, so the stored key
     * could never equal the probed one and every lookup would walk the whole
     * table (measured: 26 us a lookup against 62 ns for a `Map`).
     */
    private readonly cellKeys = new Float64Array(CELL_TABLE_SLOTS).fill(-1);
    private readonly cellValues = new Float32Array(CELL_TABLE_SLOTS);
    private cellCount = 0;
    /** Opt-in exact fast path for vertical segments; see `enableColumnMap`. */
    private _columnMap: ColumnClearanceMap | null = null;
    private _columnMapClearance = 0;

    // Reusable temporaries — avoids per-query allocation
    private readonly _localPoint = new THREE.Vector3();
    private readonly _resultTarget: { point: THREE.Vector3; distance: number; faceIndex: number } = {
        point: new THREE.Vector3(),
        distance: 0,
        faceIndex: -1,
    };
    private readonly _faceNormalCache = new Map<number, { x: number; y: number; z: number }>();

    /** Last seen matrixWorld — used to detect stale cache. */
    private readonly _lastMatrix = new THREE.Matrix4();

    /**
     * What the cache did, for the run report. `cellReads` is the router's probe
     * volume (it walks a long column per probe), `bvhQueries` is how much of
     * that was new geometry work rather than a cached answer. Together they say
     * which of the two to attack next.
     */
    readonly stats = { cellReads: 0, bvhQueries: 0 };

    constructor(mesh: THREE.Mesh, opts?: SDFCacheOptions) {
        this.cellSize = opts?.cellSize ?? 0.5;
        this.mesh = mesh;

        const geom = mesh.geometry as THREE.BufferGeometry & { boundsTree?: MeshBVHLike };
        const bvh = geom.boundsTree;
        if (!bvh) {
            throw new Error('SDFCache: mesh geometry has no boundsTree (BVH). Ensure BVH is computed before constructing the cache.');
        }
        this.bvh = bvh;

        this._snapshotMatrix();
    }

    /**
     * Signed distance for a march sample, bounded unconditionally.
     *
     * `distanceAtWithin` deliberately keeps the *unbounded* query for cells
     * inside the model's bounding box, because a point deep in the solid must
     * report a negative distance and only an unbounded traversal finds the
     * surface to sign it against. A march does not need that, and this is why:
     *
     *   A march steps by `distance - clearance`, capped at the bound, so from a
     *   sample it can never land further than the bound from where it was.
     *   Every sample it takes is therefore within the bound of any surface that
     *   could matter, the crossing sample included: it is at most one step from
     *   the sample before it, and the surface lies between the two.
     *
     * So the bound is exact here rather than an approximation, and it is what
     * lets the BVH prune. Measured on a 505k-triangle part: 3.1us per fresh cell
     * unbounded, 0.2us bounded, 14x. The router asks for 1.6M of them per run.
     *
     * A cached distance **at or beyond the bound means "at least that much"**,
     * not an exact value: the bounded query stops looking once nothing is within
     * the bound, and caching that answer is what keeps the query count down —
     * discarding it instead made every visit to a far cell a fresh traversal
     * (4.5M queries against 1.6M for the whole run). Every caller compares the
     * result against a clearance of a few tenths of a millimetre, so a cap at
     * the bound never changes a verdict; `distanceAt` re-queries when it needs
     * the exact value, which keeps its own contract.
     */
    boundedDistanceAt(wx: number, wy: number, wz: number, boundMm: number): number {
        const cs = this.cellSize;
        const qx = quantizeToCell(wx, cs);
        const qy = quantizeToCell(wy, cs);
        const qz = quantizeToCell(wz, cs);
        const cached = this._readCell(qx, qy, qz);
        if (cached !== undefined) return cached;
        const dist = this._computeSignedDistanceAtQuantizedCell(qx, qy, qz, boundMm);
        const capped = dist === Infinity ? boundMm : Math.min(dist, boundMm);
        this._writeCell(qx, qy, qz, capped);
        return capped;
    }

    /**
     * Cell storage: an open-addressed table over typed arrays.
     *
     * The distance cache is *sparse* — one run touches ~1.4M cells of a model
     * whose bounding box holds 31M at this cell size — and both obvious stores
     * fail on that shape. A `Map` costs ~600 ns a lookup, which across 18M
     * lookups in a run is half a minute. A dense array is only affordable when
     * the box is small: at 0.5 mm cells a 100x60x126 mm part is already 6M
     * cells, and one with a margin around it is 31M, so the dense path silently
     * switched itself off for exactly the models that need it most.
     *
     * Linear probing costs ~15 ns at any size, and the table is allocated once,
     * at a fixed size, so nothing about a model's dimensions changes which path
     * is taken. It is also the only store: one code path, no cliff.
     */
    private _tableIndex(key: number): number {
        // Mix *all* of the key's bits: it is ~42 bits wide, and `Math.imul`
        // sees only the low 32, so hashing it directly would collide every pair
        // of cells that differ only in x or y. Split, mix, then fold.
        const low = key >>> 0;
        const high = Math.floor(key / 0x100000000);
        return (Math.imul(low ^ Math.imul(high, 2654435761), 2654435761) >>> 0) & (CELL_TABLE_SLOTS - 1);
    }

    /** Cached distance for a cell, or undefined when it has not been computed. */
    private _readCell(qx: number, qy: number, qz: number): number | undefined {
        this.stats.cellReads++;
        const key = cellKey(qx, qy, qz);
        for (let index = this._tableIndex(key); ; index = (index + 1) & (CELL_TABLE_SLOTS - 1)) {
            const stored = this.cellKeys[index];
            if (stored === key) return this.cellValues[index];
            if (stored === -1) return this.cache.get(key);
        }
    }

    private _writeCell(qx: number, qy: number, qz: number, value: number): void {
        const key = cellKey(qx, qy, qz);
        for (let index = this._tableIndex(key); ; index = (index + 1) & (CELL_TABLE_SLOTS - 1)) {
            const stored = this.cellKeys[index];
            if (stored === key) {
                this.cellValues[index] = value;
                return;
            }
            if (stored === -1) {
                if (this.cellCount >= CELL_TABLE_SLOTS - 1) {
                    // Full: keep the answer, just on the slower path.
                    this.cache.set(key, value);
                    return;
                }
                this.cellKeys[index] = key;
                this.cellValues[index] = value;
                this.cellCount++;
                return;
            }
        }
    }

    private _clearCells(): void {
        this.cellKeys.fill(-1);
        this.cellCount = 0;
        this.cache.clear();
    }

    private _snapshotMatrix(): void {
        this._lastMatrix.copy(this.mesh.matrixWorld);
        this.inverseMatrix.copy(this.mesh.matrixWorld).invert();
        const scale = new THREE.Vector3();
        this.mesh.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
        this.worldScale = (scale.x + scale.y + scale.z) / 3;

        const geom = this.mesh.geometry;
        if (!geom.boundingBox) {
            geom.computeBoundingBox();
        }
        if (geom.boundingBox) {
            this.worldBounds.copy(geom.boundingBox).applyMatrix4(this.mesh.matrixWorld);
        } else {
            this.worldBounds.makeEmpty();
        }
    }

    /**
     * Call once at the start of each placement query.
     * If the mesh's world transform has changed since last call
     * (e.g. model was moved on the build plate), all cached distances
     * are invalidated and the matrix is updated.
     *
     * Returns true when drift was detected. Because several callers share the
     * pooled instance and the first caller consumes the drift, world-space
     * sibling caches (stagnation/placement results recorded at the OLD model
     * position) must subscribe via `onSDFMatrixDrift` rather than rely on the
     * return value — otherwise their stale points become false-collision
     * landmines after a move.
     */
    refreshMatrix(): boolean {
        if (!this.mesh.matrixWorld.equals(this._lastMatrix)) {
            this._clearCells();
            this._snapshotMatrix();
            notifySDFMatrixDrift(this.mesh.uuid);
            return true;
        }
        return false;
    }

    // ---- Public API ----

    /**
     * Returns the **signed** distance from `(wx, wy, wz)` (world-space, mm)
     * to the nearest mesh surface. Cached per grid cell.
     *
     * Positive = outside the mesh.
     * Negative = inside the mesh (the point is embedded in the model).
     * Near-zero = on or very close to the surface.
     *
     * The sign is determined by comparing the direction from the closest
     * surface point to the query point against the geometric face normal
     * of the closest triangle. If the dot product is negative, the query
     * point is on the interior side of the surface.
     */
    distanceAt(wx: number, wy: number, wz: number): number {
        const cs = this.cellSize;
        const qx = quantizeToCell(wx, cs);
        const qy = quantizeToCell(wy, cs);
        const qz = quantizeToCell(wz, cs);
        const cached = this._readCell(qx, qy, qz);
        // A value at or beyond the march's bound may be capped rather than
        // exact (see `boundedDistanceAt`), so it cannot answer an unbounded
        // question: re-query and replace it with the true value.
        if (cached !== undefined && cached < MARCH_DISTANCE_BOUND_MM) return cached;

        const dist = this._computeSignedDistanceAtQuantizedCell(qx, qy, qz);
        this._writeCell(qx, qy, qz, dist);
        return dist;
    }

    private _getOrCreateQuantizedDistance(qx: number, qy: number, qz: number, maxDistance = Infinity): number {
        const cached = this._readCell(qx, qy, qz);
        if (cached !== undefined) return cached;

        const cs = this.cellSize;
        const cX = qx * cs;
        const cY = qy * cs;
        const cZ = qz * cs;

        if (maxDistance !== Infinity && !this._expandedWorldBoundsContains(cX, cY, cZ, maxDistance)) {
            return Infinity;
        }

        const canBeInterior = this._expandedWorldBoundsContains(cX, cY, cZ, 0);
        const dist = this._computeSignedDistanceAtQuantizedCell(
            qx,
            qy,
            qz,
            canBeInterior ? Infinity : maxDistance,
        );
        if (canBeInterior || dist !== Infinity) {
            this._writeCell(qx, qy, qz, dist);
        }
        return dist;
    }

    distanceAtTrilinear(wx: number, wy: number, wz: number): number {
        const cs = this.cellSize;
        const fx = wx / cs;
        const fy = wy / cs;
        const fz = wz / cs;

        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const z0 = Math.floor(fz);

        const tx = fx - x0;
        const ty = fy - y0;
        const tz = fz - z0;

        const d000 = this._getOrCreateQuantizedDistance(x0, y0, z0);
        const d100 = this._getOrCreateQuantizedDistance(x0 + 1, y0, z0);
        const d010 = this._getOrCreateQuantizedDistance(x0, y0 + 1, z0);
        const d110 = this._getOrCreateQuantizedDistance(x0 + 1, y0 + 1, z0);
        const d001 = this._getOrCreateQuantizedDistance(x0, y0, z0 + 1);
        const d101 = this._getOrCreateQuantizedDistance(x0 + 1, y0, z0 + 1);
        const d011 = this._getOrCreateQuantizedDistance(x0, y0 + 1, z0 + 1);
        const d111 = this._getOrCreateQuantizedDistance(x0 + 1, y0 + 1, z0 + 1);

        if (
            d000 === Infinity || d100 === Infinity || d010 === Infinity || d110 === Infinity ||
            d001 === Infinity || d101 === Infinity || d011 === Infinity || d111 === Infinity
        ) {
            return this.distanceAt(wx, wy, wz);
        }

        // Interpolate along X
        const d00 = d000 * (1 - tx) + d100 * tx;
        const d10 = d010 * (1 - tx) + d110 * tx;
        const d01 = d001 * (1 - tx) + d101 * tx;
        const d11 = d011 * (1 - tx) + d111 * tx;

        // Interpolate along Y
        const d0 = d00 * (1 - ty) + d10 * ty;
        const d1 = d01 * (1 - ty) + d11 * ty;

        // Interpolate along Z
        return d0 * (1 - tz) + d1 * tz;
    }

    distanceAndGradientAt(wx: number, wy: number, wz: number, maxDistance = Infinity): { distance: number; gradient: { x: number; y: number; z: number } } {
        const cs = this.cellSize;
        if (maxDistance !== Infinity && !this._expandedWorldBoundsContains(wx, wy, wz, maxDistance + cs * 2)) {
            return { distance: Infinity, gradient: { x: 0, y: 0, z: 0 } };
        }

        const fx = wx / cs;
        const fy = wy / cs;
        const fz = wz / cs;

        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const z0 = Math.floor(fz);

        const tx = fx - x0;
        const ty = fy - y0;
        const tz = fz - z0;

        const d000 = this._getOrCreateQuantizedDistance(x0, y0, z0, maxDistance);
        const d100 = this._getOrCreateQuantizedDistance(x0 + 1, y0, z0, maxDistance);
        const d010 = this._getOrCreateQuantizedDistance(x0, y0 + 1, z0, maxDistance);
        const d110 = this._getOrCreateQuantizedDistance(x0 + 1, y0 + 1, z0, maxDistance);
        const d001 = this._getOrCreateQuantizedDistance(x0, y0, z0 + 1, maxDistance);
        const d101 = this._getOrCreateQuantizedDistance(x0 + 1, y0, z0 + 1, maxDistance);
        const d011 = this._getOrCreateQuantizedDistance(x0, y0 + 1, z0 + 1, maxDistance);
        const d111 = this._getOrCreateQuantizedDistance(x0 + 1, y0 + 1, z0 + 1, maxDistance);

        if (
            d000 === Infinity || d100 === Infinity || d010 === Infinity || d110 === Infinity ||
            d001 === Infinity || d101 === Infinity || d011 === Infinity || d111 === Infinity
        ) {
            const distance = this.distanceAtWithin(wx, wy, wz, maxDistance);
            const h = 0.1;
            const dXPlus = this.distanceAtWithin(wx + h, wy, wz, maxDistance);
            const dXMinus = this.distanceAtWithin(wx - h, wy, wz, maxDistance);
            const dYPlus = this.distanceAtWithin(wx, wy + h, wz, maxDistance);
            const dYMinus = this.distanceAtWithin(wx, wy - h, wz, maxDistance);
            const dZPlus = this.distanceAtWithin(wx, wy, wz + h, maxDistance);
            const dZMinus = this.distanceAtWithin(wx, wy, wz - h, maxDistance);

            let gx = 0, gy = 0, gz = 0;
            if (dXPlus !== Infinity && dXMinus !== Infinity) gx = (dXPlus - dXMinus) / (2 * h);
            if (dYPlus !== Infinity && dYMinus !== Infinity) gy = (dYPlus - dYMinus) / (2 * h);
            if (dZPlus !== Infinity && dZMinus !== Infinity) gz = (dZPlus - dZMinus) / (2 * h);

            const len = Math.sqrt(gx * gx + gy * gy + gz * gz);
            const gradient = len > 1e-6 ? { x: gx / len, y: gy / len, z: gz / len } : { x: 0, y: 0, z: 0 };
            return { distance, gradient };
        }

        const d00 = d000 * (1 - tx) + d100 * tx;
        const d10 = d010 * (1 - tx) + d110 * tx;
        const d01 = d001 * (1 - tx) + d101 * tx;
        const d11 = d011 * (1 - tx) + d111 * tx;

        const d0 = d00 * (1 - ty) + d10 * ty;
        const d1 = d01 * (1 - ty) + d11 * ty;

        const distance = d0 * (1 - tz) + d1 * tz;

        const dD_dtx = (d100 - d000) * (1 - ty) * (1 - tz) +
                       (d110 - d010) * ty * (1 - tz) +
                       (d101 - d001) * (1 - ty) * tz +
                       (d111 - d011) * ty * tz;

        const dD_dty = (d010 - d000) * (1 - tx) * (1 - tz) +
                       (d110 - d100) * tx * (1 - tz) +
                       (d011 - d001) * (1 - tx) * tz +
                       (d111 - d101) * tx * tz;

        const dD_dtz = (d001 - d000) * (1 - tx) * (1 - ty) +
                       (d101 - d100) * tx * (1 - ty) +
                       (d011 - d010) * (1 - tx) * ty +
                       (d111 - d110) * tx * ty;

        const invCs = 1 / cs;
        const gx = dD_dtx * invCs;
        const gy = dD_dty * invCs;
        const gz = dD_dtz * invCs;

        const len = Math.sqrt(gx * gx + gy * gy + gz * gz);
        const gradient = len > 1e-6 ? { x: gx / len, y: gy / len, z: gz / len } : { x: 0, y: 0, z: 0 };

        return { distance, gradient };
    }

    /**
     * Returns the signed distance if this cell might be within `maxDistance`
     * of the mesh, otherwise returns Infinity without traversing the BVH.
     *
     * This is conservative: cells outside the mesh world AABB expanded by
     * `maxDistance` cannot be close enough to affect routing clearance or
     * clearance penalties. Cells inside the actual mesh AABB still use the
     * full signed distance path, preserving interior-blocking behavior.
     */
    distanceAtWithin(wx: number, wy: number, wz: number, maxDistance: number): number {
        const cs = this.cellSize;
        const qx = quantizeToCell(wx, cs);
        const qy = quantizeToCell(wy, cs);
        const qz = quantizeToCell(wz, cs);
        const cached = this._readCell(qx, qy, qz);
        if (cached !== undefined) return cached;

        const cX = qx * cs;
        const cY = qy * cs;
        const cZ = qz * cs;
        if (!this._expandedWorldBoundsContains(cX, cY, cZ, maxDistance)) {
            return Infinity;
        }

        const canBeInterior = this._expandedWorldBoundsContains(cX, cY, cZ, 0);
        const dist = this._computeSignedDistanceAtQuantizedCell(
            qx,
            qy,
            qz,
            canBeInterior ? Infinity : maxDistance,
        );
        if (canBeInterior || dist !== Infinity) {
            this._writeCell(qx, qy, qz, dist);
        }
        return dist;
    }

    private _expandedWorldBoundsContains(x: number, y: number, z: number, margin: number): boolean {
        if (this.worldBounds.isEmpty()) return true;
        return x >= this.worldBounds.min.x - margin
            && x <= this.worldBounds.max.x + margin
            && y >= this.worldBounds.min.y - margin
            && y <= this.worldBounds.max.y + margin
            && z >= this.worldBounds.min.z - margin
            && z <= this.worldBounds.max.z + margin;
    }

    private _segmentIntersectsExpandedWorldBounds(
        ax: number, ay: number, az: number,
        bx: number, by: number, bz: number,
        margin: number,
    ): boolean {
        if (this.worldBounds.isEmpty()) return true;
        const minX = Math.min(ax, bx);
        const maxX = Math.max(ax, bx);
        const minY = Math.min(ay, by);
        const maxY = Math.max(ay, by);
        const minZ = Math.min(az, bz);
        const maxZ = Math.max(az, bz);
        return maxX >= this.worldBounds.min.x - margin
            && minX <= this.worldBounds.max.x + margin
            && maxY >= this.worldBounds.min.y - margin
            && minY <= this.worldBounds.max.y + margin
            && maxZ >= this.worldBounds.min.z - margin
            && minZ <= this.worldBounds.max.z + margin;
    }

    /**
     * Signed distance at the EXACT world-space point — no cell quantization,
     * no caching (callers memoize their own outcomes). One BVH query per call.
     *
     * Use this for near-field gates whose safety margins are smaller than the
     * grid substitution error: `distanceAt` answers with the distance at the
     * quantized cell CENTER, displacing the query by up to cellSize·√3/2
     * (~0.43mm at 0.5mm cells) — fatal for checks with sub-0.1mm margins like
     * the contact-cone gate.
     */
    exactSignedDistanceAt(wx: number, wy: number, wz: number): number {
        this._localPoint.set(wx, wy, wz).applyMatrix4(this.inverseMatrix);
        return this._signedDistanceAtLocalPoint(Infinity);
    }

    private _computeSignedDistanceAtQuantizedCell(qx: number, qy: number, qz: number, maxDistance = Infinity): number {
        const cs = this.cellSize;
        // Compute via BVH (local space)
        const cX = qx * cs;
        const cY = qy * cs;
        const cZ = qz * cs;

        this._localPoint.set(cX, cY, cZ).applyMatrix4(this.inverseMatrix);
        return this._signedDistanceAtLocalPoint(maxDistance);
    }

    /** Signed distance for the point currently in `_localPoint`. */
    private _signedDistanceAtLocalPoint(maxDistance: number): number {
        this.stats.bvhQueries++;
        const localMaxDistance = maxDistance === Infinity ? Infinity : maxDistance / Math.max(0.000001, this.worldScale);
        const result = this.bvh.closestPointToPoint(this._localPoint, this._resultTarget, 0, localMaxDistance);

        if (!result) {
            return Infinity;
        }

        let dist = (result.distance as number) * this.worldScale;

        // Sign the distance using the face normal of the nearest triangle.
        //
        // Without signing, a point 3mm INSIDE the mesh reports dist=3 (the
        // unsigned distance to the nearest surface). isBlocked(x,y,z, 0.75)
        // checks dist < 0.75 → false → "not blocked" → support placed through
        // geometry. With signing, that same point reports dist=-3 → always < clearance
        // → correctly blocked.
        const fi = this._resultTarget.faceIndex;
        if (dist > 1e-6 && fi >= 0) {
            if (this._isQueryInsideSurface(fi)) {
                dist = -dist;
            }
        }

        return dist;
    }

    // ---- Inside/outside determination ----

    /**
     * Returns true if `_localPoint` (the most recent query point, in local
     * space) is on the interior side of the triangle at `faceIndex`.
     *
     * Uses the geometric face normal (cross product of triangle edges)
     * rather than vertex normals, which may be smoothed and unreliable
     * for inside/outside determination.
     */
    private _isQueryInsideSurface(faceIndex: number): boolean {
        let fn = this._faceNormalCache.get(faceIndex);

        if (!fn) {
            const geom = this.mesh.geometry;
            const posAttr = geom.getAttribute('position');
            const idx = geom.index;

            // Look up vertex indices for this triangle
            let i0: number, i1: number, i2: number;
            if (idx) {
                i0 = idx.getX(faceIndex * 3);
                i1 = idx.getX(faceIndex * 3 + 1);
                i2 = idx.getX(faceIndex * 3 + 2);
            } else {
                i0 = faceIndex * 3;
                i1 = faceIndex * 3 + 1;
                i2 = faceIndex * 3 + 2;
            }

            // Compute geometric face normal once and cache it.
            const v0x = posAttr.getX(i0), v0y = posAttr.getY(i0), v0z = posAttr.getZ(i0);
            const v1x = posAttr.getX(i1), v1y = posAttr.getY(i1), v1z = posAttr.getZ(i1);
            const v2x = posAttr.getX(i2), v2y = posAttr.getY(i2), v2z = posAttr.getZ(i2);

            const e1x = v1x - v0x, e1y = v1y - v0y, e1z = v1z - v0z;
            const e2x = v2x - v0x, e2y = v2y - v0y, e2z = v2z - v0z;

            fn = {
                x: e1y * e2z - e1z * e2y,
                y: e1z * e2x - e1x * e2z,
                z: e1x * e2y - e1y * e2x,
            };
            this._faceNormalCache.set(faceIndex, fn);
        }

        // Direction from closest surface point → query point (local space)
        const rp = this._resultTarget.point;
        const dx = this._localPoint.x - rp.x;
        const dy = this._localPoint.y - rp.y;
        const dz = this._localPoint.z - rp.z;

        // Negative dot → query point faces into the mesh interior
        return (dx * fn.x + dy * fn.y + dz * fn.z) < 0;
    }

    /**
     * Returns true if the cell at `(wx,wy,wz)` is closer to the mesh
     * surface than `clearance` mm (i.e. would collide for the given radius).
     *
     * Uses single-cell `distanceAt` (1 BVH query, cached) rather than
     * `distanceAtTrilinear` (8 BVH queries) — this is on the hot path for
     * A* neighbor expansion and must remain cheap.
     */
    isBlocked(wx: number, wy: number, wz: number, clearance: number): boolean {
        return this.distanceAt(wx, wy, wz) < clearance;
    }

    /**
     * Exact signed distance at a world-space point, bounded.
     *
     * Used by the march where the cached value is too coarse to decide: the
     * cache answers for the nearest lattice point, so its value bounds the
     * sample's distance but cannot resolve it. A bounded point query prunes to
     * a small neighbourhood and costs ~0.2 µs, so this is only worth asking
     * where the lattice bound actually lands near the clearance.
     */
    private _exactBoundedDistanceAt(wx: number, wy: number, wz: number, boundMm: number): number {
        this._localPoint.set(wx, wy, wz).applyMatrix4(this.inverseMatrix);
        const dist = this._signedDistanceAtLocalPoint(boundMm);
        return dist === Infinity ? boundMm : Math.min(dist, boundMm);
    }

    /**
     * Turn on the exact column fast path for one clearance.
     *
     * The router asks "is this column clear down to the root?" once per walk
     * step and per direction, and that vertical march is the bulk of a run's
     * distance-field reads. `ColumnClearanceMap` answers a column from one
     * scalar per XY cell, built from the mesh's own vertices.
     *
     * Opt-in and clearance-specific: the map is built for one clearance and its
     * verdicts only mean anything for that one, and a caller that uses several
     * (the router's shaft clearance, then a shaft radius) would otherwise
     * silently get the wrong answer. Idempotent, because callers sit on a
     * per-placement path and the build is tens of milliseconds. Returns false
     * when the grid would be too large, in which case nothing changes.
     */
    enableColumnMap(clearanceMm: number, cellMm: number): boolean {
        if (this._columnMap !== null && Math.abs(clearanceMm - this._columnMapClearance) < 1e-9) return true;
        const map = ColumnClearanceMap.build(this.mesh, clearanceMm, cellMm);
        if (!map) return false;
        this._columnMap = map;
        this._columnMapClearance = clearanceMm;
        return true;
    }

    /**
     * How far a sample's true distance can be below the cached value: the cache
     * answers for the nearest lattice point (`quantizeToCell` rounds), so this
     * is the sample's distance to it.
     */
    private _latticeGap(px: number, py: number, pz: number): number {
        const cs = this.cellSize;
        const lx = Math.round(px / cs) * cs - px;
        const ly = Math.round(py / cs) * cs - py;
        const lz = Math.round(pz / cs) * cs - pz;
        return Math.sqrt(lx * lx + ly * ly + lz * lz);
    }

    /**
     * One march sample, as the distance it can safely advance.
     *
     * Returns -1 when the sample is inside `clearance`. The cached value bounds
     * the sample's true distance to `[base - gap, base + gap]`, so above the
     * band it settles `clear` without another query, below it settles `blocked`,
     * and only the band itself is asked exactly. A method rather than a closure
     * because this runs once per sample of 18M calls, where allocating a
     * function per call is measurable.
     */
    private _marchSample(px: number, py: number, pz: number, clearance: number): number {
        const d = this.boundedDistanceAt(px, py, pz, MARCH_DISTANCE_BOUND_MM);
        const base = d === Infinity ? MARCH_DISTANCE_BOUND_MM : d;
        const gap = this._latticeGap(px, py, pz);
        if (base + gap < clearance) return -1;
        if (base - gap >= clearance) return base - gap - clearance;
        const exact = this._exactBoundedDistanceAt(px, py, pz, clearance + 0.001);
        return exact < clearance ? -1 : exact - clearance;
    }

    /**
     * Checks an entire line segment (A→B) for clearance using **adaptive
     * sphere tracing** driven by the signed distance field.
     *
     * The SDF is 1-Lipschitz: for any two points P, Q, `|d(P) - d(Q)| ≤ |P-Q|`.
     * So from a point P with cached distance `d`, we can safely advance by
     * up to `(d - clearance)` along the ray — no point within that radius
     * can be closer than `clearance` to the surface.
     *
     * Uses single-cell `distanceAt` (1 BVH query, cached per cell) rather
     * than `distanceAtTrilinear` (8 BVH queries) — this is on the hot path
     * for A* neighbor edge validation and path simplification.  Accuracy is
     * equivalent to fixed cellSize sampling (both use the same cell-quantized
     * cache), while open-space traversals that used to cost ~50 queries for
     * a 25mm segment now cost ~3–5. In tight regions the adaptive step
     * degrades gracefully to the cellSize floor.
     */
    segmentBlocked(
        ax: number, ay: number, az: number,
        bx: number, by: number, bz: number,
        clearance: number,
    ): boolean {
        // Exact fast path, vertical segments only: it answers `blocked` only
        // when a mesh vertex is provably within `clearance` of the segment, so
        // it can only settle what the march below would have settled anyway.
        if (this._columnMap !== null
            && ax === bx && ay === by
            && Math.abs(clearance - this._columnMapClearance) < 1e-9
            && this._columnMap.columnVerdict(ax, ay, az, bz) === 'blocked') {
            return true;
        }

        const dx = bx - ax;
        const dy = by - ay;
        const dz = bz - az;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 0.01) return this._marchSample(ax, ay, az, clearance) < 0;
        if (!this._segmentIntersectsExpandedWorldBounds(ax, ay, az, bx, by, bz, clearance)) {
            return false;
        }

        const invLen = 1 / len;
        const ux = dx * invLen;
        const uy = dy * invLen;
        const uz = dz * invLen;

        const cs = this.cellSize;
        // Floor step: matches the fidelity of the old fixed-cellSize sampler so
        // geometry thinner than ~cellSize is still caught. Skipping below this
        // would give up accuracy; we never want that.
        const minStep = cs * 0.9;

        let t = 0;
        // Limit iterations defensively in case a pathological SDF oscillation
        // prevents progress — shouldn't happen with the minStep floor but cheap.
        const maxIter = Math.max(8, Math.ceil(len / minStep) + 2);
        for (let iter = 0; iter < maxIter; iter++) {
            const advance = this._marchSample(ax + ux * t, ay + uy * t, az + uz * t, clearance);
            if (advance < 0) return true;
            t += advance > minStep ? advance : minStep;
            if (t >= len) break;
        }
        // Always check the exact endpoint — the adaptive loop may exit with
        // t > len before sampling the terminal cell.
        return this._marchSample(bx, by, bz, clearance) < 0;
    }

    /** Number of cached cells (for diagnostics). */
    get size(): number {
        return this.cellCount + this.cache.size;
    }

    /** How the cells are stored, for the run report. */
    get store(): { kind: 'table' | 'table+map'; cells: number; slots: number } {
        return {
            kind: this.cache.size > 0 ? 'table+map' : 'table',
            cells: this.cellCount,
            slots: CELL_TABLE_SLOTS,
        };
    }

    /** Drop the cache but keep the BVH reference. */
    clear(): void {
        this._clearCells();
    }
}
