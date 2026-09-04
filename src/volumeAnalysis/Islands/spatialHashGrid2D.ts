/**
 * Uniform 2D spatial hash.
 *
 * Cells are keyed by a single number rather than a `"cx,cy"` string. The string
 * form is the idiomatic one and reads better, but in the island pipeline this
 * grid is filled with every contact voxel of every island, and a template
 * literal allocates a rope string per insert and per probe. Profiling the
 * island scan showed roughly a third of the time going to garbage collection,
 * sweeping exactly those temporary keys. A number hashes without allocating.
 */

/**
 * Cell coordinates are folded into one number as `(cx + OFFSET) * STRIDE + cy`.
 * With OFFSET = 2^20 the addressable range is ±1,048,576 cells on each axis —
 * 100 metres at a 0.1 mm cell — and the largest key stays below 2^42, well
 * inside the range where integers are exact.
 */
const CELL_OFFSET = 1 << 20;
const CELL_STRIDE = 1 << 21;

export function cellKey(cx: number, cy: number): number {
  return (cx + CELL_OFFSET) * CELL_STRIDE + (cy + CELL_OFFSET);
}

export class SpatialHashGrid2D<T> {
  private cellSize: number;
  private grid: Map<number, T[]>;

  constructor(cellSize: number) {
    this.cellSize = cellSize;
    this.grid = new Map();
  }

  private getKey(x: number, y: number): number {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    return cellKey(cx, cy);
  }

  insert(x: number, y: number, item: T): void {
    const key = this.getKey(x, y);
    let cell = this.grid.get(key);
    if (!cell) {
      cell = [];
      this.grid.set(key, cell);
    }
    cell.push(item);
  }

  query(x: number, y: number, radius: number): T[] {
    const minX = Math.floor((x - radius) / this.cellSize);
    const maxX = Math.floor((x + radius) / this.cellSize);
    const minY = Math.floor((y - radius) / this.cellSize);
    const maxY = Math.floor((y + radius) / this.cellSize);
    const results: T[] = [];
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cy = minY; cy <= maxY; cy++) {
        const cell = this.grid.get(cellKey(cx, cy));
        if (!cell) continue;
        // Appended one by one rather than with `push(...cell)`: a dense cell can
        // hold more items than the engine's argument limit.
        for (const item of cell) {
          results.push(item);
        }
      }
    }
    return results;
  }

  clear(): void {
    this.grid.clear();
  }
}
