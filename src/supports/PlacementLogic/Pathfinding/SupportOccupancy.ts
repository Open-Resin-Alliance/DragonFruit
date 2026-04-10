/**
 * SupportOccupancy — Tracks placed support geometry as occupied cells
 *
 * Provides support-to-support collision avoidance by stamping cylindrical
 * shaft regions into a spatial hash. The A* pathfinder queries both the
 * mesh SDF and this occupancy grid to route around existing supports.
 */

import { Vec3 } from '../../types';

// ---------- Types ----------

export interface OccupancyOptions {
    /** Grid cell size in mm. Should match SDFCache.cellSize. Default 0.5. */
    cellSize?: number;
}

// ---------- Helpers ----------

function quantize(v: number, cellSize: number): number {
    return Math.round(v / cellSize);
}

function cellKey(qx: number, qy: number, qz: number): number {
    const ux = (qx + 0x4000) | 0;
    const uy = (qy + 0x4000) | 0;
    const uz = (qz + 0x4000) | 0;
    return (ux * 0x8000 + uy) * 0x8000 + uz;
}

// ---------- SupportOccupancy ----------

export class SupportOccupancy {
    readonly cellSize: number;

    /**
     * Set of occupied cell keys.
     * Map value is the support id that occupies the cell (for ignore-self queries).
     */
    private readonly cells = new Map<number, string>();

    constructor(opts?: OccupancyOptions) {
        this.cellSize = opts?.cellSize ?? 0.5;
    }

    // ---- Stamping ----

    /**
     * Stamps a cylindrical shaft segment into the occupancy grid.
     * Rasterises a conservative axis-aligned bounding cylinder around
     * the line segment with the given radius.
     */
    stampCylinder(
        ax: number, ay: number, az: number,
        bx: number, by: number, bz: number,
        radius: number,
        supportId: string,
    ): void {
        const cs = this.cellSize;
        const r = radius + cs * 0.5; // conservative padding

        // AABB of the segment + radius
        const minX = Math.min(ax, bx) - r;
        const maxX = Math.max(ax, bx) + r;
        const minY = Math.min(ay, by) - r;
        const maxY = Math.max(ay, by) + r;
        const minZ = Math.min(az, bz) - r;
        const maxZ = Math.max(az, bz) + r;

        const qMinX = quantize(minX, cs) - 1;
        const qMaxX = quantize(maxX, cs) + 1;
        const qMinY = quantize(minY, cs) - 1;
        const qMaxY = quantize(maxY, cs) + 1;
        const qMinZ = quantize(minZ, cs) - 1;
        const qMaxZ = quantize(maxZ, cs) + 1;

        // Segment vector
        const dx = bx - ax;
        const dy = by - ay;
        const dz = bz - az;
        const segLenSq = dx * dx + dy * dy + dz * dz;
        const invSegLenSq = segLenSq > 0.0001 ? 1 / segLenSq : 0;
        const rSq = radius * radius;

        for (let qx = qMinX; qx <= qMaxX; qx++) {
            const cx = qx * cs;
            for (let qy = qMinY; qy <= qMaxY; qy++) {
                const cy = qy * cs;
                for (let qz = qMinZ; qz <= qMaxZ; qz++) {
                    const cz = qz * cs;

                    // Distance from cell center to line segment (clamped)
                    const px = cx - ax;
                    const py = cy - ay;
                    const pz = cz - az;
                    const t = Math.max(0, Math.min(1, (px * dx + py * dy + pz * dz) * invSegLenSq));
                    const closestX = ax + dx * t;
                    const closestY = ay + dy * t;
                    const closestZ = az + dz * t;
                    const ex = cx - closestX;
                    const ey = cy - closestY;
                    const ez = cz - closestZ;

                    if (ex * ex + ey * ey + ez * ez <= rSq) {
                        this.cells.set(cellKey(qx, qy, qz), supportId);
                    }
                }
            }
        }
    }

    /**
     * Stamps a full support path (array of world-space waypoints) with
     * the given shaft radius.
     */
    stampPath(points: Vec3[], radius: number, supportId: string): void {
        for (let i = 0; i < points.length - 1; i++) {
            const a = points[i];
            const b = points[i + 1];
            this.stampCylinder(a.x, a.y, a.z, b.x, b.y, b.z, radius, supportId);
        }
    }

    // ---- Queries ----

    /**
     * Returns true if the cell is occupied by any support OTHER than
     * `ignoreSupportId`.
     */
    isOccupied(wx: number, wy: number, wz: number, ignoreSupportId?: string): boolean {
        const cs = this.cellSize;
        const key = cellKey(quantize(wx, cs), quantize(wy, cs), quantize(wz, cs));
        const owner = this.cells.get(key);
        if (owner === undefined) return false;
        if (ignoreSupportId && owner === ignoreSupportId) return false;
        return true;
    }

    /**
     * Returns true if any cell along the segment is occupied.
     */
    segmentOccupied(
        ax: number, ay: number, az: number,
        bx: number, by: number, bz: number,
        cellSize: number,
        ignoreSupportId?: string,
    ): boolean {
        const dx = bx - ax;
        const dy = by - ay;
        const dz = bz - az;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 0.01) return this.isOccupied(ax, ay, az, ignoreSupportId);

        const steps = Math.max(1, Math.ceil(len / cellSize));
        const inv = 1 / steps;
        for (let i = 0; i <= steps; i++) {
            const t = i * inv;
            if (this.isOccupied(ax + dx * t, ay + dy * t, az + dz * t, ignoreSupportId)) {
                return true;
            }
        }
        return false;
    }

    // ---- Maintenance ----

    /**
     * Removes all cells belonging to a specific support.
     * Call when a support is deleted or moved.
     */
    removeSupportById(supportId: string): void {
        for (const [key, owner] of this.cells) {
            if (owner === supportId) {
                this.cells.delete(key);
            }
        }
    }

    /** Total occupied cell count. */
    get size(): number {
        return this.cells.size;
    }

    clear(): void {
        this.cells.clear();
    }
}
