import * as THREE from 'three';
import { orientRing, type PolygonWithHoles } from './polygonSet2d';

/**
 * Boolean region of a soup of overlapping 2D polygons, computed on a raster grid.
 *
 * Clipper is the wrong tool for this input: the model's plate footprint arrives as
 * one polygon per tessellated triangle (thousands of them, sharing edges), and
 * Clipper's sweep is superlinear in overlapping paths — a single union of ~2700
 * sphere triangles takes seconds, which is a frozen frame in the viewport. A grid
 * is linear in the covered area instead (milliseconds), at the cost of a boundary
 * quantised to the cell size, which Douglas–Peucker then smooths.
 *
 * The result is a set of simple, correctly nested rings (outer counter-clockwise,
 * holes clockwise) — what earcut and Clipper downstream both want.
 */

/**
 * Grid target: cells across the region's longest side. Every pass is linear in
 * the cell count, so this is the speed/quantisation dial: 1024 across a 200 mm
 * model is a 0.2 mm cell, well inside the 1 mm clearance the cut is grown by.
 */
const TARGET_CELLS_ACROSS = 1024;
const MIN_CELL_MM = 0.05;
const MAX_CELL_MM = 0.25;

/** Grow the mask by one cell so diagonal touches cannot pinch a traced loop. */
const DILATE_CELLS = 1;

export function resolveRasterCellMm(widthMm: number, heightMm: number): number {
  const longest = Math.max(widthMm, heightMm);
  if (!Number.isFinite(longest) || longest <= 0) return MIN_CELL_MM;
  return Math.min(MAX_CELL_MM, Math.max(MIN_CELL_MM, longest / TARGET_CELLS_ACROSS));
}

type Grid = {
  cellMm: number;
  originX: number;
  originY: number;
  width: number;
  height: number;
  mask: Uint8Array;
};

function boundsOfPolygons(polygons: readonly (readonly THREE.Vector2[])[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const polygon of polygons) {
    for (const point of polygon) {
      if (point.x < minX) minX = point.x;
      if (point.x > maxX) maxX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.y > maxY) maxY = point.y;
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/**
 * Cells the polygon's edges pass through, so a sliver cannot fall between cell
 * centres. Sampled at cell steps: this only has to *add* cells, the region grows
 * by a cell afterwards anyway.
 */
function rasterizeEdges(grid: Grid, polygon: readonly THREE.Vector2[]) {
  const { cellMm, originX, originY, width, height, mask } = grid;

  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) / cellMm));
    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps;
      const ix = Math.floor((a.x + (b.x - a.x) * t - originX) / cellMm);
      const iy = Math.floor((a.y + (b.y - a.y) * t - originY) / cellMm);
      if (ix < 0 || iy < 0 || ix >= width || iy >= height) continue;
      mask[iy * width + ix] = 1;
    }
  }
}

/** Crossing buffer reused across rows and polygons — this runs once per triangle. */
const rowCrossings: number[] = [];

/** Scanline fill, sampling cell centres. */
function rasterizeInterior(grid: Grid, polygon: readonly THREE.Vector2[]) {
  const { cellMm, originX, originY, width, height, mask } = grid;

  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of polygon) {
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }

  const rowStart = Math.max(0, Math.floor((minY - originY) / cellMm));
  const rowEnd = Math.min(height - 1, Math.ceil((maxY - originY) / cellMm));
  const corners = polygon.length;

  for (let iy = rowStart; iy <= rowEnd; iy += 1) {
    const y = originY + (iy + 0.5) * cellMm;
    rowCrossings.length = 0;

    for (let i = 0; i < corners; i += 1) {
      const a = polygon[i];
      const b = polygon[(i + 1) % corners];
      if ((a.y > y) === (b.y > y)) continue;
      rowCrossings.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    const count = rowCrossings.length;
    if (count < 2) continue;

    if (count === 2) {
      if (rowCrossings[1] < rowCrossings[0]) {
        const swap = rowCrossings[0];
        rowCrossings[0] = rowCrossings[1];
        rowCrossings[1] = swap;
      }
    } else {
      rowCrossings.sort((left, right) => left - right);
    }

    const rowOffset = iy * width;
    for (let c = 0; c + 1 < count; c += 2) {
      const from = Math.max(0, Math.ceil((rowCrossings[c] - originX) / cellMm - 0.5));
      const to = Math.min(width - 1, Math.floor((rowCrossings[c + 1] - originX) / cellMm - 0.5));
      for (let ix = from; ix <= to; ix += 1) mask[rowOffset + ix] = 1;
    }
  }
}

function dilateRows(grid: Grid, radius: number) {
  const { mask, width, height } = grid;
  for (let iy = 0; iy < height; iy += 1) {
    const row = iy * width;
    let runStart = -1;
    for (let ix = 0; ix <= width; ix += 1) {
      const filled = ix < width && mask[row + ix] === 1;
      if (filled && runStart < 0) runStart = ix;
      if (!filled && runStart >= 0) {
        for (let x = Math.max(0, runStart - radius); x <= Math.min(width - 1, ix - 1 + radius); x += 1) {
          mask[row + x] = 1;
        }
        runStart = -1;
      }
    }
  }
}

function dilateColumns(grid: Grid, radius: number) {
  const { mask, width, height } = grid;
  for (let ix = 0; ix < width; ix += 1) {
    const runs: Array<[number, number]> = [];
    let runStart = -1;
    for (let iy = 0; iy <= height; iy += 1) {
      const filled = iy < height && mask[iy * width + ix] === 1;
      if (filled && runStart < 0) runStart = iy;
      if (!filled && runStart >= 0) {
        runs.push([runStart, iy - 1]);
        runStart = -1;
      }
    }
    for (const [start, end] of runs) {
      for (let y = Math.max(0, start - radius); y <= Math.min(height - 1, end + radius); y += 1) {
        mask[y * width + ix] = 1;
      }
    }
  }
}

/**
 * Trace the mask boundary as loops of cell corners. Edges are directed so the
 * filled region stays on their left, which makes outers counter-clockwise and
 * holes clockwise; the one-cell dilation above guarantees no corner is shared by
 * two outgoing edges.
 */
function traceMaskLoops(grid: Grid): THREE.Vector2[][] {
  const { mask, width, height, cellMm, originX, originY } = grid;
  const edges = new Map<string, [number, number]>();

  const cornerKey = (x: number, y: number) => `${x},${y}`;
  const addEdge = (fromX: number, fromY: number, toX: number, toY: number) => {
    edges.set(cornerKey(fromX, fromY), [toX, toY]);
  };

  for (let iy = 0; iy < height; iy += 1) {
    for (let ix = 0; ix < width; ix += 1) {
      if (mask[iy * width + ix] !== 1) continue;
      const left = ix > 0 && mask[iy * width + ix - 1] === 1;
      const right = ix + 1 < width && mask[iy * width + ix + 1] === 1;
      const below = iy > 0 && mask[(iy - 1) * width + ix] === 1;
      const above = iy + 1 < height && mask[(iy + 1) * width + ix] === 1;

      if (!left) addEdge(ix, iy + 1, ix, iy);
      if (!right) addEdge(ix + 1, iy, ix + 1, iy + 1);
      if (!below) addEdge(ix, iy, ix + 1, iy);
      if (!above) addEdge(ix + 1, iy + 1, ix, iy + 1);
    }
  }

  const loops: THREE.Vector2[][] = [];
  for (const startKey of edges.keys()) {
    if (!edges.has(startKey)) continue;

    const [startX, startY] = startKey.split(',').map(Number);
    const loop: THREE.Vector2[] = [];
    let current: [number, number] | undefined = [startX, startY];
    let guard = edges.size + 1;

    while (current && guard-- > 0) {
      const key = cornerKey(current[0], current[1]);
      const next = edges.get(key);
      if (!next) break;
      edges.delete(key);
      loop.push(new THREE.Vector2(originX + current[0] * cellMm, originY + current[1] * cellMm));
      current = next;
      if (current[0] === startX && current[1] === startY) break;
    }

    if (loop.length >= 4) loops.push(loop);
  }

  return loops;
}

/** Ramer–Douglas–Peucker over an open chain, endpoints kept. */
function simplifyChain(points: readonly THREE.Vector2[], tolerance: number): THREE.Vector2[] {
  if (points.length <= 2) return points.map((p) => p.clone());

  const first = points[0];
  const last = points[points.length - 1];
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const length = Math.hypot(dx, dy);

  let worst = -1;
  let worstDistance = tolerance;
  for (let i = 1; i < points.length - 1; i += 1) {
    const point = points[i];
    const distance = length <= 1e-9
      ? point.distanceTo(first)
      : Math.abs(dy * point.x - dx * point.y + last.x * first.y - last.y * first.x) / length;
    if (distance > worstDistance) {
      worstDistance = distance;
      worst = i;
    }
  }

  if (worst < 0) return [first.clone(), last.clone()];
  return [
    ...simplifyChain(points.slice(0, worst + 1), tolerance).slice(0, -1),
    ...simplifyChain(points.slice(worst), tolerance),
  ];
}

function simplifyLoop(loop: readonly THREE.Vector2[], tolerance: number): THREE.Vector2[] {
  if (loop.length <= 4) return loop.map((p) => p.clone());

  // Split the closed loop at its farthest point so DP sees two open chains.
  let farthest = 0;
  let farthestDistance = -1;
  for (let i = 1; i < loop.length; i += 1) {
    const distance = loop[0].distanceToSquared(loop[i]);
    if (distance > farthestDistance) {
      farthestDistance = distance;
      farthest = i;
    }
  }

  const firstChain = loop.slice(0, farthest + 1);
  const secondChain = [...loop.slice(farthest), loop[0]];
  const simplified = [
    ...simplifyChain(firstChain, tolerance).slice(0, -1),
    ...simplifyChain(secondChain, tolerance).slice(0, -1),
  ];
  return simplified.length >= 3 ? simplified : loop.map((p) => p.clone());
}

function ringContainsPoint(ring: readonly THREE.Vector2[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Nest traced loops: a loop inside an odd number of others is a hole. Loops are
 * oriented for their role, which is what the Clipper and earcut consumers expect.
 */
function nestLoops(loops: readonly THREE.Vector2[][]): PolygonWithHoles[] {
  const withArea = loops.map((ring, index) => ({
    ring,
    index,
    area: Math.abs(ring.reduce((total, point, i) => {
      const next = ring[(i + 1) % ring.length];
      return total + point.x * next.y - next.x * point.y;
    }, 0) / 2),
  }));
  withArea.sort((left, right) => right.area - left.area);

  const depth = withArea.map((entry, i) => {
    const point = entry.ring[0];
    let inside = 0;
    for (let j = 0; j < i; j += 1) {
      if (ringContainsPoint(withArea[j].ring, point.x, point.y)) inside += 1;
    }
    return inside;
  });

  const polygons: PolygonWithHoles[] = [];
  const created = new Map<number, PolygonWithHoles>();

  for (let i = 0; i < withArea.length; i += 1) {
    if (depth[i] % 2 !== 0) continue;
    const polygon: PolygonWithHoles = { outer: orientRing(withArea[i].ring, true), holes: [] };
    polygons.push(polygon);
    created.set(i, polygon);
  }

  for (let i = 0; i < withArea.length; i += 1) {
    if (depth[i] % 2 === 0) continue;
    // Loops are sorted largest first, so the first enclosing outer at the
    // preceding depth is the hole's immediate parent.
    let parent = -1;
    for (let j = 0; j < i; j += 1) {
      if (depth[j] !== depth[i] - 1) continue;
      if (ringContainsPoint(withArea[j].ring, withArea[i].ring[0].x, withArea[i].ring[0].y)) {
        parent = j;
        break;
      }
    }
    created.get(parent)?.holes.push(orientRing(withArea[i].ring, false));
  }

  return polygons.filter((poly) => poly.outer.length >= 3);
}

/** Rasterise a polygon soup into simple, nested rings. */
export function rasterizePolygonsToRegion(
  polygons: readonly (readonly THREE.Vector2[])[],
): PolygonWithHoles[] {
  const bounds = boundsOfPolygons(polygons);
  if (!bounds) return [];

  const widthMm = bounds.maxX - bounds.minX;
  const heightMm = bounds.maxY - bounds.minY;
  const cellMm = resolveRasterCellMm(widthMm, heightMm);
  const margin = cellMm * 4;

  const grid: Grid = {
    cellMm,
    originX: bounds.minX - margin,
    originY: bounds.minY - margin,
    width: Math.max(1, Math.ceil((widthMm + margin * 2) / cellMm)),
    height: Math.max(1, Math.ceil((heightMm + margin * 2) / cellMm)),
    mask: new Uint8Array(0),
  };
  grid.mask = new Uint8Array(grid.width * grid.height);

  for (const polygon of polygons) {
    if (polygon.length < 3) continue;
    rasterizeEdges(grid, polygon);
    rasterizeInterior(grid, polygon);
  }

  dilateRows(grid, DILATE_CELLS);
  dilateColumns(grid, DILATE_CELLS);

  return nestLoops(traceMaskLoops(grid).map((loop) => simplifyLoop(loop, cellMm)));

}
