import * as THREE from 'three';

type Triangle = [number, number, number];

type InternalPoint = { x: number; y: number };

function circumcircleContains(a: InternalPoint, b: InternalPoint, c: InternalPoint, p: InternalPoint): boolean {
  // Uses determinant test. Assumes a,b,c are not colinear.
  const ax = a.x - p.x;
  const ay = a.y - p.y;
  const bx = b.x - p.x;
  const by = b.y - p.y;
  const cx = c.x - p.x;
  const cy = c.y - p.y;

  const det =
    (ax * ax + ay * ay) * (bx * cy - by * cx) -
    (bx * bx + by * by) * (ax * cy - ay * cx) +
    (cx * cx + cy * cy) * (ax * by - ay * bx);

  // Orientation affects sign. Normalize by triangle orientation.
  const orient = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return orient > 0 ? det > 1e-10 : det < -1e-10;
}

function triEdges(t: Triangle): Array<[number, number]> {
  const [i, j, k] = t;
  return [
    [i, j],
    [j, k],
    [k, i],
  ];
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

export function delaunayTriangulate2d(points: THREE.Vector2[]): Triangle[] {
  if (points.length < 3) return [];

  const pts: InternalPoint[] = points.map((p) => ({ x: p.x, y: p.y }));

  // Super-triangle
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const dx = maxX - minX;
  const dy = maxY - minY;
  const dmax = Math.max(dx, dy);
  const midx = (minX + maxX) / 2;
  const midy = (minY + maxY) / 2;

  const p0: InternalPoint = { x: midx - 20 * dmax, y: midy - dmax };
  const p1: InternalPoint = { x: midx, y: midy + 20 * dmax };
  const p2: InternalPoint = { x: midx + 20 * dmax, y: midy - dmax };

  const i0 = pts.length;
  const i1 = pts.length + 1;
  const i2 = pts.length + 2;
  pts.push(p0, p1, p2);

  let triangles: Triangle[] = [[i0, i1, i2]];

  for (let pi = 0; pi < points.length; pi++) {
    const p = pts[pi];

    const bad: Triangle[] = [];
    for (const t of triangles) {
      const a = pts[t[0]];
      const b = pts[t[1]];
      const c = pts[t[2]];
      if (circumcircleContains(a, b, c, p)) bad.push(t);
    }

    // Boundary polygon edges are edges that occur exactly once among bad triangles
    const edgeCount = new Map<string, { a: number; b: number; count: number }>();
    for (const t of bad) {
      for (const [ea, eb] of triEdges(t)) {
        const key = edgeKey(ea, eb);
        const prev = edgeCount.get(key);
        if (!prev) edgeCount.set(key, { a: ea, b: eb, count: 1 });
        else prev.count += 1;
      }
    }

    triangles = triangles.filter((t) => !bad.includes(t));

    const boundary = Array.from(edgeCount.values()).filter((e) => e.count === 1);
    for (const e of boundary) {
      triangles.push([e.a, e.b, pi]);
    }
  }

  // Remove triangles connected to super-triangle vertices
  triangles = triangles.filter((t) => t[0] < points.length && t[1] < points.length && t[2] < points.length);

  return triangles;
}
