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
import { PrecomputedSDFGrid } from './PrecomputedSDFGrid';
import type { ClearanceHeightmap } from './ClearanceHeightmap';

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

function quantize(v: number, cellSize: number): number {
    return Math.round(v / cellSize);
}

function cellKey(qx: number, qy: number, qz: number): number {
    // Cantor-style hash for three integers — faster than string keys.
    // Shift to unsigned range first (supports coords up to ±16k grid cells).
    const ux = (qx + 0x4000) | 0;
    const uy = (qy + 0x4000) | 0;
    const uz = (qz + 0x4000) | 0;
    return (ux * 0x8000 + uy) * 0x8000 + uz;
}

// ---------- SDFCache ----------

export class SDFCache {
    readonly cellSize: number;

    private readonly mesh: THREE.Mesh;
    /** BVH instance from three-mesh-bvh (geometry.boundsTree) */
    private readonly bvh: MeshBVHLike;
    private inverseMatrix = new THREE.Matrix4();
    private readonly worldBounds = new THREE.Box3();
    private worldScale = 1;
    private readonly cache = new Map<number, number>();

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

    /** Optional pre-computed sparse SDF grid from Rust. When set, lookups
     *  check this grid first (zero BVH overhead) and only fall back to BVH
     *  for cells outside the pre-computed shell. */
    private precomputedGrid: PrecomputedSDFGrid | null = null;

    /** Optional clearance heightmap from Rust. Enables O(1) straight-descent
     *  viability checks and a tighter A* heuristic. */
    private heightmap: ClearanceHeightmap | null = null;

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
     */
    refreshMatrix(): void {
        if (!this.mesh.matrixWorld.equals(this._lastMatrix)) {
            this.cache.clear();
            this._snapshotMatrix();
        }
    }

    /**
     * Load a pre-computed sparse SDF grid from the Rust backend.
     * Once set, all `distanceAt` / `isBlocked` / `segmentBlocked` calls
     * check this grid first — zero BVH overhead for pre-computed cells.
     * Cells outside the pre-computed shell still fall back to BVH.
     */
    loadPrecomputed(grid: PrecomputedSDFGrid): void {
        if (grid.cellSize !== this.cellSize) {
            console.warn(
                `SDFCache: precomputed cellSize ${grid.cellSize} != cache cellSize ${this.cellSize}. ` +
                `The precomputed grid will be used but quantisation may differ.`
            );
        }
        this.precomputedGrid = grid;
    }

    /**
     * Load a clearance heightmap from the Rust backend.
     * Enables O(1) straight-descent viability checks via {@link columnIsClear}
     * and provides the data for a tighter A* heuristic.
     */
    loadHeightmap(hm: ClearanceHeightmap): void {
        this.heightmap = hm;
    }

    /** True if a pre-computed grid has been loaded. */
    get hasPrecomputed(): boolean {
        return this.precomputedGrid !== null;
    }

    /** True if a clearance heightmap has been loaded. */
    get hasHeightmap(): boolean {
        return this.heightmap !== null;
    }

    /**
     * Returns true if a straight-down column from world-space (wx, wy, z)
     * to the build plate is clear of model geometry.  Uses the pre-computed
     * heightmap when available (O(1)); falls back to a full SDF column check.
     */
    columnIsClear(wx: number, wy: number, z: number): boolean {
        if (this.heightmap) {
            // Transform world → local for the heightmap lookup
            this._localPoint.set(wx, wy, z).applyMatrix4(this.inverseMatrix);
            return this.heightmap.columnIsClear(
                this._localPoint.x / this.worldScale,
                this._localPoint.y / this.worldScale,
                this._localPoint.z / this.worldScale,
            );
        }
        // Fallback: check the column with segmentBlocked
        return !this.segmentBlocked(wx, wy, z, wx, wy, 0, 0.001);
    }

    /**
     * Returns the highest blocked Z at a world-space XY position.
     * -Infinity means the column is entirely clear.  Returns NaN if
     * no heightmap is loaded.
     */
    getBlockedZ(wx: number, wy: number): number {
        if (!this.heightmap) return NaN;
        this._localPoint.set(wx, wy, 0).applyMatrix4(this.inverseMatrix);
        return this.heightmap.get(
            this._localPoint.x / this.worldScale,
            this._localPoint.y / this.worldScale,
        ) * this.worldScale;
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
        // Fast path: check pre-computed grid first (zero BVH overhead).
        const pg = this.precomputedGrid;
        if (pg) {
            const dist = this._lookupPrecomputed(wx, wy, wz, pg);
            if (dist !== undefined) return dist;
        }

        const cs = this.cellSize;
        const qx = quantize(wx, cs);
        const qy = quantize(wy, cs);
        const qz = quantize(wz, cs);
        const key = cellKey(qx, qy, qz);

        const cached = this.cache.get(key);
        if (cached !== undefined) return cached;

        const dist = this._computeSignedDistanceAtQuantizedCell(qx, qy, qz);
        this.cache.set(key, dist);
        return dist;
    }

    /**
     * Look up a signed distance in the pre-computed grid.
     * Transforms world-space coords to model-local, quantises, and
     * retrieves the pre-computed distance. Returns undefined if the
     * cell is outside the pre-computed shell.
     */
    private _lookupPrecomputed(
        wx: number, wy: number, wz: number,
        pg: PrecomputedSDFGrid,
    ): number | undefined {
        // Transform world → local
        this._localPoint.set(wx, wy, wz).applyMatrix4(this.inverseMatrix);
        const lx = this._localPoint.x;
        const ly = this._localPoint.y;
        const lz = this._localPoint.z;

        // Quantise in local space using the pre-computed cell size
        const cs = pg.cellSize;
        const qx = quantize(lx, cs);
        const qy = quantize(ly, cs);
        const qz = quantize(lz, cs);

        const dist = pg.get(qx, qy, qz);
        if (dist === undefined) return undefined;

        // Scale back to world-space mm
        return dist * this.worldScale;
    }

    private _getOrCreateQuantizedDistance(qx: number, qy: number, qz: number, maxDistance = Infinity): number {
        const key = cellKey(qx, qy, qz);
        const cached = this.cache.get(key);
        if (cached !== undefined) return cached;

        const cs = this.cellSize;
        const cX = qx * cs;
        const cY = qy * cs;
        const cZ = qz * cs;

        // Check pre-computed grid in local space
        const pg = this.precomputedGrid;
        if (pg) {
            this._localPoint.set(cX, cY, cZ).applyMatrix4(this.inverseMatrix);
            const lx = this._localPoint.x;
            const ly = this._localPoint.y;
            const lz = this._localPoint.z;
            const lqx = quantize(lx, pg.cellSize);
            const lqy = quantize(ly, pg.cellSize);
            const lqz = quantize(lz, pg.cellSize);
            const preDist = pg.get(lqx, lqy, lqz);
            if (preDist !== undefined) {
                const dist = preDist * this.worldScale;
                this.cache.set(key, dist);
                return dist;
            }
        }

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
            this.cache.set(key, dist);
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
        const qx = quantize(wx, cs);
        const qy = quantize(wy, cs);
        const qz = quantize(wz, cs);
        const key = cellKey(qx, qy, qz);

        const cached = this.cache.get(key);
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
            this.cache.set(key, dist);
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

    private _computeSignedDistanceAtQuantizedCell(qx: number, qy: number, qz: number, maxDistance = Infinity): number {
        const cs = this.cellSize;
        // Compute via BVH (local space)
        const cX = qx * cs;
        const cY = qy * cs;
        const cZ = qz * cs;

        this._localPoint.set(cX, cY, cZ).applyMatrix4(this.inverseMatrix);
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
        const dx = bx - ax;
        const dy = by - ay;
        const dz = bz - az;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 0.01) return this.distanceAt(ax, ay, az) < clearance;
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
            const px = ax + ux * t;
            const py = ay + uy * t;
            const pz = az + uz * t;
            const d = this.distanceAt(px, py, pz);
            if (d < clearance) return true;
            const safeAdvance = d - clearance;
            const step = safeAdvance > minStep ? safeAdvance : minStep;
            t += step;
            if (t >= len) break;
        }
        // Always check the exact endpoint — the adaptive loop may exit with
        // t > len before sampling the terminal cell.
        return this.distanceAt(bx, by, bz) < clearance;
    }

    /** Number of cached cells (for diagnostics). */
    get size(): number {
        return this.cache.size;
    }

    /** Drop the cache but keep the BVH reference. */
    clear(): void {
        this.cache.clear();
    }
}
