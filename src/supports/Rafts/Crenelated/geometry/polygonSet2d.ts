import * as THREE from 'three';
import ClipperLib from 'clipper-lib';
import { signedArea2d } from './signedArea2d';

/**
 * Shared 2D polygon-set helpers (union / difference / offset / triangulation
 * shapes) built on clipper-lib.
 *
 * The raft footprint is a *set* of polygons once the model clearance is cut out
 * of it: the cut can split the convex hull into several lobes and leave holes.
 * Every generator that used to assume one convex ring goes through this module
 * instead of re-deriving Clipper plumbing.
 *
 * Conventions:
 * - Rings are lists of world-XY points (millimetres).
 * - A `PolygonWithHoles` keeps the outer ring CCW and its holes CW. That winding
 *   is what Clipper emits and what `offsetPolygonSet` needs to tell an outward
 *   edge from an inward one, so it is preserved rather than normalised away.
 * - Offsets are positive-outward: `offsetPolygonSet(polys, +d)` grows the solid
 *   (outers expand, holes shrink), `-d` shrinks it (outers shrink, holes grow).
 */

/** Clipper works in integers; 1000 steps per millimetre = micrometre precision. */
export const CLIPPER_SCALE = 1000;

export type IntPoint = { X: number; Y: number };

export type PolygonWithHoles = {
  outer: THREE.Vector2[];
  holes: THREE.Vector2[][];
};

export function ringToPolygon(ring: THREE.Vector2[]): PolygonWithHoles {
  return { outer: ring, holes: [] };
}

export function toIntPoint(p: THREE.Vector2): IntPoint {
  return { X: Math.round(p.x * CLIPPER_SCALE), Y: Math.round(p.y * CLIPPER_SCALE) };
}

export function toIntPath(ring: readonly THREE.Vector2[]): IntPoint[] {
  return ring.map(toIntPoint);
}

export function fromIntPath(path: readonly IntPoint[]): THREE.Vector2[] {
  return path.map((p) => new THREE.Vector2(p.X / CLIPPER_SCALE, p.Y / CLIPPER_SCALE));
}

/** Copy of `ring` wound so that its signed area is positive when `ccw`. */
export function orientRing(ring: readonly THREE.Vector2[], ccw: boolean): THREE.Vector2[] {
  const copy = ring.map((p) => p.clone());
  if ((signedArea2d(copy) > 0) === ccw) return copy;
  return copy.reverse();
}

/* clipper-lib ships without types (`declare module 'clipper-lib'`), so the slice
 * of its surface this module touches is declared once, here. */
type PolyTreeNode = {
  Contour?: IntPoint[];
  m_polygon?: IntPoint[];
  m_Contour?: IntPoint[];
  Childs?: PolyTreeNode[] | (() => PolyTreeNode[]);
  m_Childs?: PolyTreeNode[];
  IsHole?: (() => boolean) | boolean;
  m_IsHole?: boolean;
  GetFirst?: () => PolyTreeNode | null;
  GetNext?: () => PolyTreeNode | null;
};

type ClipperApi = {
  ClipType: { ctUnion: number; ctDifference: number };
  PolyType: { ptSubject: number; ptClip: number };
  PolyFillType: { pftNonZero: number };
  JoinType: { jtMiter: number };
  EndType: { etClosedPolygon: number };
  Clipper: new () => {
    StrictlySimple: boolean;
    AddPaths(paths: IntPoint[][], polyType: number, closed: boolean): void;
    Execute(clipType: number, solution: PolyTreeNode, subjFill: number, clipFill: number): boolean;
  };
  ClipperOffset: new (miterLimit: number, arcTolerance: number) => {
    AddPaths(paths: IntPoint[][], joinType: number, endType: number): void;
    Execute(solution: IntPoint[][], delta: number): void;
  };
  PolyTree: new () => PolyTreeNode;
};

const Clipper = ClipperLib as unknown as ClipperApi;

/**
 * Paths must already carry their winding (outer CCW, holes CW).
 *
 * `strictlySimple` makes Clipper split self-touching output into simple
 * polygons. It is what keeps earcut (the caps) happy, but it is also *very* slow
 * on thousands of overlapping inputs, so the batched bulk of a big union runs
 * without it and the small result is finished with it on.
 */
function runUnion(paths: IntPoint[][], strictlySimple = true): PolygonWithHoles[] {
  const usable = paths.filter((path) => path.length >= 3);
  if (usable.length === 0) return [];

  const c = new Clipper.Clipper();
  c.StrictlySimple = strictlySimple;
  c.AddPaths(usable, Clipper.PolyType.ptSubject, true);

  const tree = new Clipper.PolyTree();
  c.Execute(
    Clipper.ClipType.ctUnion,
    tree,
    Clipper.PolyFillType.pftNonZero,
    Clipper.PolyFillType.pftNonZero,
  );

  return polygonsFromPolyTree(tree);
}

function polygonSetPaths(polys: readonly PolygonWithHoles[]): IntPoint[][] {
  const paths: IntPoint[][] = [];
  for (const poly of polys) {
    if (poly.outer.length >= 3) paths.push(toIntPath(orientRing(poly.outer, true)));
    for (const hole of poly.holes) {
      if (hole.length >= 3) paths.push(toIntPath(orientRing(hole, false)));
    }
  }
  return paths;
}

/** Union of polygon sets, keeping holes as holes. */
export function unionPolygonSets(sets: readonly PolygonWithHoles[]): PolygonWithHoles[] {
  return runUnion(polygonSetPaths(sets));
}

export function unionRings(rings: readonly THREE.Vector2[][]): PolygonWithHoles[] {
  return runUnion(
    rings.filter((ring) => ring.length >= 3).map((ring) => toIntPath(orientRing(ring, true))),
  );
}

/** `subject` minus `clip`, both as polygon sets with holes. */
export function differencePolygonSets(
  subject: readonly PolygonWithHoles[],
  clip: readonly PolygonWithHoles[],
): PolygonWithHoles[] {
  const subjectPaths = polygonSetPaths(subject);
  if (subjectPaths.length === 0) return [];
  const clipPaths = polygonSetPaths(clip);
  if (clipPaths.length === 0) return runUnion(subjectPaths);

  const c = new Clipper.Clipper();
  c.StrictlySimple = true;
  c.AddPaths(subjectPaths, Clipper.PolyType.ptSubject, true);
  c.AddPaths(clipPaths, Clipper.PolyType.ptClip, true);

  const tree = new Clipper.PolyTree();
  c.Execute(
    Clipper.ClipType.ctDifference,
    tree,
    Clipper.PolyFillType.pftNonZero,
    Clipper.PolyFillType.pftNonZero,
  );

  return polygonsFromPolyTree(tree);
}

/**
 * Offset a polygon set by `deltaMm` (positive grows the solid). Unlike the
 * per-vertex inset used for convex rings this resolves self-intersections, so it
 * is safe on the concave clearance cut and on holes.
 */
export function offsetPolygonSet(
  polys: readonly PolygonWithHoles[],
  deltaMm: number,
): PolygonWithHoles[] {
  const paths = polygonSetPaths(polys);
  if (paths.length === 0) return [];

  const co = new Clipper.ClipperOffset(2, 2);
  co.AddPaths(paths, Clipper.JoinType.jtMiter, Clipper.EndType.etClosedPolygon);

  const solution: IntPoint[][] = [];
  co.Execute(solution, deltaMm * CLIPPER_SCALE);

  // ClipperOffset reports outers as positive-area paths and holes as negative,
  // so the union keeps the nesting instead of filling the holes.
  return runUnion(solution);
}

/**
 * Flatten a Clipper PolyTree into outers with their holes. Nodes alternate
 * outer/hole by depth, and an island inside a hole is another outer — dropping
 * that level would silently delete raft islands that sit inside a ring-shaped
 * model footprint.
 *
 * `IsHole` is honoured rather than inferred from depth: after a difference,
 * Clipper (with StrictlySimple) can also emit the subtracted region as a bare
 * top-level hole node, and taking that for an outer would hand the caller back
 * exactly the material it just cut out.
 */
export function polygonsFromPolyTree(polyTree: PolyTreeNode): PolygonWithHoles[] {
  const result: PolygonWithHoles[] = [];

  const childrenOf = (node: PolyTreeNode): PolyTreeNode[] => {
    if (Array.isArray(node.Childs)) return node.Childs;
    if (typeof node.Childs === 'function') {
      const value = node.Childs();
      return Array.isArray(value) ? value : [];
    }
    if (Array.isArray(node.m_Childs)) return node.m_Childs;
    return [];
  };

  const contourOf = (node: PolyTreeNode): IntPoint[] => {
    if (Array.isArray(node.m_polygon)) return node.m_polygon;
    if (Array.isArray(node.Contour)) return node.Contour;
    if (Array.isArray(node.m_Contour)) return node.m_Contour;
    return [];
  };

  const isHoleNode = (node: PolyTreeNode): boolean => {
    if (typeof node.IsHole === 'function') return node.IsHole();
    if (typeof node.IsHole === 'boolean') return node.IsHole;
    if (typeof node.m_IsHole === 'boolean') return node.m_IsHole;
    return false;
  };

  const visit = (node: PolyTreeNode, parent: PolygonWithHoles | null) => {
    const contour = fromIntPath(contourOf(node));
    const children = childrenOf(node);

    if (contour.length < 3) {
      for (const child of children) visit(child, parent);
      return;
    }

    if (isHoleNode(node)) {
      if (parent) parent.holes.push(contour);
      // An island inside a hole is filled material in its own right.
      for (const child of children) visit(child, null);
      return;
    }

    const polygon: PolygonWithHoles = { outer: contour, holes: [] };
    result.push(polygon);
    for (const child of children) visit(child, polygon);
  };

  if (typeof polyTree.GetFirst === 'function') {
    let node = polyTree.GetFirst();
    while (node) {
      visit(node, null);
      node = typeof node.GetNext === 'function' ? node.GetNext() : null;
    }
  } else {
    for (const child of childrenOf(polyTree)) visit(child, null);
  }

  return result;
}

/** Distance from a point to a segment, in mm. */
export function pointToSegmentMm(
  x: number,
  y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq <= 1e-12 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSq));
  return Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
}

/** Ray-cast containment over a polygon set, holes subtracted. */
export function polygonSetContains(polys: readonly PolygonWithHoles[], x: number, y: number): boolean {
  for (const poly of polys) {
    let inside = false;
    for (const ring of [poly.outer, ...poly.holes]) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i];
        const b = ring[j];
        if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
          inside = !inside;
        }
      }
    }
    if (inside) return true;
  }
  return false;
}

/**
 * A uniform grid over a polygon set's edges, so a segment can be tested against
 * the edges near it instead of every edge in the set.
 *
 * The raft footprint clustering asks "does this pair of roots pass within a
 * micron of the model's plate outline" for every pair of roots. Answered against
 * every edge that is O(roots^2 x edges): on a scene with 1109 roots and a
 * footprint set of a few thousand edges that is billions of distance calls, and
 * it measured 19 seconds for one model selection. Answered against a grid, a
 * pair's segment (a few millimetres, two roots apart) touches a handful of cells
 * and a handful of edges.
 *
 * Keys are numeric, not strings: a string key per cell lookup allocates a rope
 * string per query, and that allocation shows up in the GC as much as the lookup
 * itself (see docs/dev/performance-debugging.md).
 */
export type ClearanceEdgeGrid = {
  cellSize: number;
  minX: number;
  minY: number;
  cells: Map<number, number[]>;
  /** Flat edge list: [ax, ay, bx, by] per edge. */
  edges: Float64Array;
};

/** How far a query's box grows, so an edge a micron away is still found. */
const EDGE_QUERY_EPS_MM = 0.001;

export function buildClearanceEdgeGrid(
  clearance: readonly PolygonWithHoles[],
  cellSize = 4,
): ClearanceEdgeGrid | null {
  const edgeCoords: number[] = [];
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const poly of clearance) {
    for (const ring of [poly.outer, ...poly.holes]) {
      for (let i = 0; i < ring.length; i += 1) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        edgeCoords.push(a.x, a.y, b.x, b.y);
        if (a.x < minX) minX = a.x;
        if (a.y < minY) minY = a.y;
      }
    }
  }
  if (edgeCoords.length === 0) return null;

  const edges = Float64Array.from(edgeCoords);
  const cells = new Map<number, number[]>();
  const cellOf = (value: number, min: number) => Math.max(0, Math.floor((value - min) / cellSize));
  const key = (cx: number, cy: number) => cy * 100000 + cx;

  for (let e = 0; e < edges.length; e += 4) {
    const x0 = Math.min(edges[e], edges[e + 2]);
    const x1 = Math.max(edges[e], edges[e + 2]);
    const y0 = Math.min(edges[e + 1], edges[e + 3]);
    const y1 = Math.max(edges[e + 1], edges[e + 3]);
    const cx0 = cellOf(x0, minX);
    const cx1 = cellOf(x1, minX);
    const cy0 = cellOf(y0, minY);
    const cy1 = cellOf(y1, minY);
    for (let cy = cy0; cy <= cy1; cy += 1) {
      for (let cx = cx0; cx <= cx1; cx += 1) {
        const k = key(cx, cy);
        const bucket = cells.get(k);
        if (bucket) bucket.push(e);
        else cells.set(k, [e]);
      }
    }
  }

  return { cellSize, minX, minY, cells, edges };
}

/** Whether `segmentDistanceMm` between the query segment and any edge is <= `epsilon`. */
export function gridSegmentBlocked(
  grid: ClearanceEdgeGrid,
  ax: number, ay: number, bx: number, by: number,
  epsilon = EDGE_QUERY_EPS_MM,
): boolean {
  const cellOf = (value: number, min: number) => Math.max(0, Math.floor((value - min) / grid.cellSize));
  const cx0 = cellOf(Math.min(ax, bx) - epsilon, grid.minX);
  const cx1 = cellOf(Math.max(ax, bx) + epsilon, grid.minX);
  const cy0 = cellOf(Math.min(ay, by) - epsilon, grid.minY);
  const cy1 = cellOf(Math.max(ay, by) + epsilon, grid.minY);

  for (let cy = cy0; cy <= cy1; cy += 1) {
    for (let cx = cx0; cx <= cx1; cx += 1) {
      const bucket = grid.cells.get(cy * 100000 + cx);
      if (!bucket) continue;
      for (const e of bucket) {
        if (segmentDistanceMm(ax, ay, bx, by, grid.edges[e], grid.edges[e + 1], grid.edges[e + 2], grid.edges[e + 3]) <= epsilon) {
          return true;
        }
      }
    }
  }
  return false;
}

/** Closest approach of two segments, in mm. */
export function segmentDistanceMm(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): number {
  const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return 0;

  return Math.min(
    pointToSegmentMm(ax, ay, cx, cy, dx, dy),
    pointToSegmentMm(bx, by, cx, cy, dx, dy),
    pointToSegmentMm(cx, cy, ax, ay, bx, by),
    pointToSegmentMm(dx, dy, ax, ay, bx, by),
  );
}

/** THREE.Shape list (with holes) so ExtrudeGeometry can consume the set. */
export function polygonSetToShapes(polys: readonly PolygonWithHoles[]): THREE.Shape[] {
  const shapes: THREE.Shape[] = [];
  for (const poly of polys) {
    if (poly.outer.length < 3) continue;
    const shape = new THREE.Shape(poly.outer.map((p) => p.clone()));
    for (const hole of poly.holes) {
      if (hole.length < 3) continue;
      const path = new THREE.Path(hole.map((p) => p.clone()));
      path.closePath();
      shape.holes.push(path);
    }
    shapes.push(shape);
  }
  return shapes;
}

/** Net area of the set in mm² (holes subtracted). */
export function polygonSetAreaMm2(polys: readonly PolygonWithHoles[]): number {
  let area = 0;
  for (const poly of polys) {
    area += Math.abs(signedArea2d(poly.outer));
    for (const hole of poly.holes) area -= Math.abs(signedArea2d(hole));
  }
  return area;
}
