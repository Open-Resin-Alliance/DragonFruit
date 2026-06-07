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

    constructor(mesh: THREE.Mesh, opts?: SDFCacheOptions) {
        this.cellSize = opts?.cellSize ?? 0.5;
        this.mesh = mesh;

        const geom = mesh.geometry as THREE.BufferGeometry & { boundsTree?: MeshBVHLike };
        this.bvh = geom.boundsTree;
        if (!this.bvh) {
            throw new Error('SDFCache: mesh geometry has no boundsTree (BVH). Ensure BVH is computed before constructing the cache.');
        }

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
     * Accuracy is equivalent to fixed cellSize sampling (both use the same
     * cell-quantized cache), while open-space traversals that used to cost
     * ~50 queries for a 25mm segment now cost ~3–5. In tight regions the
     * adaptive step degrades gracefully to the cellSize floor, matching the
     * previous fixed-step accuracy.
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
