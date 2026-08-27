/**
 * An island's contact footprint, stored as flat typed arrays.
 *
 * The natural shape is `{ x, y, z? }[]`, and that is what this replaced. On a
 * tall model the island scan produces around ten million contact voxels, and
 * one object per voxel put roughly a hundred million live objects on the JS
 * heap — WebKit's own statistics at the moment it killed the process read
 * `javascript_gc_object_count: 99,593,201` against a hard 16 GB ceiling for the
 * content process.
 *
 * Two floats in a shared buffer cost eight bytes and nothing for the collector
 * to trace. Coordinates are millimetres in world space, well inside the range
 * where `Float32Array` keeps sub-micron precision.
 */
export interface VoxelFootprint {
    /** Interleaved x, y pairs: voxel `i` is at `xy[i * 2]`, `xy[i * 2 + 1]`. */
    readonly xy: Float32Array;
    /** Per-voxel surface Z, or null when the detector produced none. */
    readonly z: Float32Array | null;
    /** Number of voxels, not the length of `xy`. */
    readonly count: number;
}

export function footprintX(footprint: VoxelFootprint, index: number): number {
    return footprint.xy[index * 2];
}

export function footprintY(footprint: VoxelFootprint, index: number): number {
    return footprint.xy[index * 2 + 1];
}

/** Surface Z for a voxel, or null when this footprint carries no Z data. */
export function footprintZ(footprint: VoxelFootprint, index: number): number | null {
    return footprint.z ? footprint.z[index] : null;
}

export function isEmptyFootprint(footprint: VoxelFootprint | undefined): boolean {
    return !footprint || footprint.count === 0;
}

/**
 * Accumulates voxels when the count is not known up front.
 *
 * Grows geometrically like a plain array would, but over one buffer instead of
 * one object per element.
 */
export class VoxelFootprintBuilder {
    private xy: Float32Array;
    private z: Float32Array | null;
    private size = 0;

    constructor(initialCapacity = 64, withZ = false) {
        const capacity = Math.max(1, initialCapacity);
        this.xy = new Float32Array(capacity * 2);
        this.z = withZ ? new Float32Array(capacity) : null;
    }

    get count(): number {
        return this.size;
    }

    push(x: number, y: number, z?: number): void {
        if (this.size * 2 >= this.xy.length) this.grow();
        this.xy[this.size * 2] = x;
        this.xy[this.size * 2 + 1] = y;
        if (this.z) this.z[this.size] = z ?? 0;
        this.size++;
    }

    private grow(): void {
        const nextCapacity = Math.max(1, this.xy.length);
        const nextXy = new Float32Array(nextCapacity * 2);
        nextXy.set(this.xy);
        this.xy = nextXy;
        if (this.z) {
            const nextZ = new Float32Array(nextCapacity);
            nextZ.set(this.z);
            this.z = nextZ;
        }
    }

    /** Trims to size. The builder must not be used afterwards. */
    build(): VoxelFootprint {
        return {
            xy: this.xy.subarray(0, this.size * 2),
            z: this.z ? this.z.subarray(0, this.size) : null,
            count: this.size,
        };
    }
}

/** Builds a footprint from coordinate pairs, for tests and small call sites. */
export function footprintFromPoints(points: Array<{ x: number; y: number; z?: number }>): VoxelFootprint {
    const withZ = points.some((point) => point.z != null);
    const builder = new VoxelFootprintBuilder(points.length, withZ);
    for (const point of points) builder.push(point.x, point.y, point.z);
    return builder.build();
}

/** Concatenates footprints; the result carries Z only if every input does. */
export function concatFootprints(footprints: VoxelFootprint[]): VoxelFootprint {
    const total = footprints.reduce((sum, f) => sum + f.count, 0);
    const withZ = footprints.length > 0 && footprints.every((f) => f.z !== null);
    const xy = new Float32Array(total * 2);
    const z = withZ ? new Float32Array(total) : null;

    let offset = 0;
    for (const footprint of footprints) {
        xy.set(footprint.xy.subarray(0, footprint.count * 2), offset * 2);
        if (z && footprint.z) z.set(footprint.z.subarray(0, footprint.count), offset);
        offset += footprint.count;
    }
    return { xy, z, count: total };
}

/**
 * Materialises a footprint as point objects.
 *
 * For the transient boundary with algorithms that want `{ x, y, z? }` — the
 * auto-support placement helpers, which are unit-tested against plain arrays
 * and whose output lives only for the duration of a placement run. Never store
 * the result on an island: the packed form exists precisely so that millions of
 * voxels are not millions of objects.
 */
export function footprintToPoints(footprint: VoxelFootprint): Array<{ x: number; y: number; z?: number }> {
    const points: Array<{ x: number; y: number; z?: number }> = new Array(footprint.count);
    for (let i = 0; i < footprint.count; i++) {
        points[i] = footprint.z
            ? { x: footprint.xy[i * 2], y: footprint.xy[i * 2 + 1], z: footprint.z[i] }
            : { x: footprint.xy[i * 2], y: footprint.xy[i * 2 + 1] };
    }
    return points;
}
