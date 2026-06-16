/**
 * ClearanceHeightmap — deserialises the 2D heightmap binary blob from Rust.
 *
 * The wire format matches `dragonfruit-sdf`'s `ClearanceHeightmap::to_bytes()`:
 *
 *   Header (24 bytes):
 *     magic:       u32 LE  = 0x484D4150 ("HMAP")
 *     version:     u32 LE  = 1
 *     width:       u32 LE
 *     height:      u32 LE
 *     cell_size:   f32 LE
 *     clearance:   f32 LE
 *
 *   Body:
 *     width × height f32 LE values (row-major, Y-major)
 *     Each value = highest blocked Z in model-local mm.
 *     -Infinity = column is entirely clear.
 */

const MAGIC = 0x484D4150; // "HMAP"
const VERSION = 1;
const HEADER_BYTES = 24;

export class ClearanceHeightmap {
    readonly cellSize: number;
    readonly clearance: number;
    readonly width: number;
    readonly height: number;
    readonly originX: number = 0;
    readonly originY: number = 0;

    /** Row-major f32 array: data[y * width + x] = highest blocked Z. */
    private readonly data: Float32Array;

    private constructor(
        cellSize: number,
        clearance: number,
        width: number,
        height: number,
        data: Float32Array,
    ) {
        this.cellSize = cellSize;
        this.clearance = clearance;
        this.width = width;
        this.height = height;
        this.data = data;
    }

    /**
     * Look up the highest blocked Z at a model-local XY position (mm).
     * Returns -Infinity if the column is entirely clear or out of bounds.
     */
    get(wx: number, wy: number): number {
        const cx = Math.floor((wx - this.originX) / this.cellSize);
        const cy = Math.floor((wy - this.originY) / this.cellSize);
        if (cx < 0 || cy < 0 || cx >= this.width || cy >= this.height) {
            return -Infinity;
        }
        return this.data[cy * this.width + cx];
    }

    /**
     * Returns true if a straight-down column from (wx, wy, z) to Z=0
     * is clear of model geometry.
     */
    columnIsClear(wx: number, wy: number, z: number): boolean {
        return z > this.get(wx, wy);
    }

    get cellCount(): number {
        return this.width * this.height;
    }

    /**
     * Deserialise from the Rust binary wire format.
     * Returns null if the header is invalid or the buffer is too short.
     */
    static fromBytes(buffer: ArrayBuffer): ClearanceHeightmap | null {
        const bytes = new Uint8Array(buffer);
        const view = new DataView(buffer);

        if (bytes.length < HEADER_BYTES) return null;

        const magic = view.getUint32(0, true);
        if (magic !== MAGIC) return null;

        const version = view.getUint32(4, true);
        if (version !== VERSION) return null;

        const width = view.getUint32(8, true);
        const height = view.getUint32(12, true);
        const cellSize = view.getFloat32(16, true);
        const clearance = view.getFloat32(20, true);

        const cellCount = width * height;
        const expectedLen = HEADER_BYTES + cellCount * 4;
        if (bytes.length < expectedLen) return null;

        const data = new Float32Array(cellCount);
        let offset = HEADER_BYTES;
        for (let i = 0; i < cellCount; i++) {
            data[i] = view.getFloat32(offset, true);
            offset += 4;
        }

        return new ClearanceHeightmap(cellSize, clearance, width, height, data);
    }
}
