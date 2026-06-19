/**
 * PrecomputedSDFGrid — deserialises the binary SDF blob from Rust.
 *
 * The wire format matches `dragonfruit-sdf`'s `SparseSdfGrid::to_bytes()`:
 *
 *   Header (20 bytes):
 *     magic:     u32 LE  = 0x46445344 ("DSDF")
 *     version:   u32 LE  = 1
 *     cell_size: f32 LE
 *     reserved:  u64 LE  = 0
 *
 *   Body:
 *     cell_count: u32 LE
 *     for each cell (11 bytes):
 *       qx:  i16 LE   quantised X cell coordinate
 *       qy:  i16 LE   quantised Y cell coordinate
 *       qz:  i16 LE   quantised Z cell coordinate
 *       pad: u8       = 0
 *       dist: f32 LE  signed distance in mm (+ve = outside, -ve = inside)
 *
 * The cell key hash matches `SDFCache.cellKey()` exactly, so the same
 * Cantor-style 3D integer hash is used on both sides.
 */

const MAGIC = 0x46445344; // "DSDF"
const VERSION = 1;
const HEADER_BYTES = 20;
const CELL_BYTES = 11;
const CELL_KEY_MASK = 0x7FFF;

function cellKey(qx: number, qy: number, qz: number): number {
    const ux = (qx + 0x4000) | 0;
    const uy = (qy + 0x4000) | 0;
    const uz = (qz + 0x4000) | 0;
    return (ux * 0x8000 + uy) * 0x8000 + uz;
}

export class PrecomputedSDFGrid {
    readonly cellSize: number;
    readonly cellCount: number;

    /** cellKey → signed distance (mm). +ve = outside, -ve = inside. */
    private readonly cells: Map<number, number>;

    private constructor(cellSize: number, cells: Map<number, number>) {
        this.cellSize = cellSize;
        this.cells = cells;
        this.cellCount = cells.size;
    }

    /**
     * Look up the signed distance at a quantised cell coordinate in
     * model-local space. Returns `undefined` if the cell is outside
     * the pre-computed shell (implicitly far from the surface).
     */
    get(qx: number, qy: number, qz: number): number | undefined {
        const key = cellKey(qx, qy, qz);
        return this.cells.get(key);
    }

    /**
     * Returns true if the cell at quantised coords is within `clearance`
     * of the mesh surface.
     */
    isBlocked(qx: number, qy: number, qz: number, clearance: number): boolean {
        const d = this.get(qx, qy, qz);
        return d !== undefined && d < clearance;
    }

    /**
     * Deserialise from the Rust binary wire format.
     * Returns `null` if the header is invalid or the buffer is too short.
     */
    static fromBytes(buffer: ArrayBuffer): PrecomputedSDFGrid | null {
        const bytes = new Uint8Array(buffer);
        const view = new DataView(buffer);

        if (bytes.length < HEADER_BYTES + 4) return null;

        const magic = view.getUint32(0, true);
        if (magic !== MAGIC) return null;

        const version = view.getUint32(4, true);
        if (version !== VERSION) return null;

        const cellSize = view.getFloat32(8, true);
        // bytes 12..20: reserved

        const cellCount = view.getUint32(20, true);
        const expectedLen = HEADER_BYTES + 4 + cellCount * CELL_BYTES;
        if (bytes.length < expectedLen) return null;

        const cells = new Map<number, number>();
        let offset = 24; // after header + cell_count

        for (let i = 0; i < cellCount; i++) {
            const qx = view.getInt16(offset, true);
            const qy = view.getInt16(offset + 2, true);
            const qz = view.getInt16(offset + 4, true);
            // offset + 6: padding byte
            const dist = view.getFloat32(offset + 7, true);

            const key = cellKey(qx, qy, qz);
            cells.set(key, dist);

            offset += CELL_BYTES;
        }

        return new PrecomputedSDFGrid(cellSize, cells);
    }
}
