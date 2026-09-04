import * as THREE from 'three';
import type { CutPlane } from './cutPlane';

/**
 * The exact curve where a plane meets a mesh surface — the seam a flat cut
 * actually produces.
 *
 * The plane cut has no use for the geodesic seam: the cut doesn't follow the
 * points the user placed, it follows the plane those points define. So the
 * truthful preview is this intersection, not a surface-following curve through
 * the waypoints.
 *
 * A plane through a model can meet it in SEVERAL closed loops (slice a pair of
 * legs and you get two), so this returns a list. All of them are real seams of
 * the same cut and all should be drawn.
 *
 * Everything is in the mesh's own local space, matching how waypoints are stored.
 */

/** Points closer than this (mm) are treated as the same vertex when chaining. */
const WELD_EPSILON = 1e-4;

/** A vertex is treated as lying ON the plane inside this band (mm). */
const ON_PLANE_EPSILON = 1e-6;

/**
 * One intersection curve: a flat `[x,y,z, x,y,z, …]` polyline in model-local
 * space, matching the layout the tool already renders for the geodesic seam.
 */
export interface PlaneMeshCurve {
  points: Float32Array;
  /** True when the curve closes back on itself (the usual case on a solid). */
  closed: boolean;
}

/** Quantised key for welding endpoints that should be the same point. */
function weldKey(x: number, y: number, z: number): string {
  const q = 1 / WELD_EPSILON;
  return `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;
}

/**
 * Intersects one triangle with the plane, appending the crossing segment (if
 * any) to `out` as six floats.
 *
 * Signed distances decide the case. A triangle contributes a segment only when
 * its vertices straddle the plane; triangles fully on one side contribute
 * nothing. Vertices sitting exactly on the plane count as crossings so a seam
 * that runs along an edge still chains up.
 */
function intersectTriangle(
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  normal: THREE.Vector3,
  offset: number,
  out: number[],
): void {
  const da = normal.dot(a) - offset;
  const db = normal.dot(b) - offset;
  const dc = normal.dot(c) - offset;

  // Wholly on one side (and not grazing) → no crossing.
  if (da > ON_PLANE_EPSILON && db > ON_PLANE_EPSILON && dc > ON_PLANE_EPSILON) return;
  if (da < -ON_PLANE_EPSILON && db < -ON_PLANE_EPSILON && dc < -ON_PLANE_EPSILON) return;

  const hits: THREE.Vector3[] = [];
  const edge = (p: THREE.Vector3, q: THREE.Vector3, dp: number, dq: number) => {
    const pOn = Math.abs(dp) <= ON_PLANE_EPSILON;
    const qOn = Math.abs(dq) <= ON_PLANE_EPSILON;
    if (pOn) hits.push(p.clone());
    // `q` is picked up as the next edge's `p`, so only handle a true crossing here.
    if (!pOn && !qOn && ((dp > 0) !== (dq > 0))) {
      const t = dp / (dp - dq);
      hits.push(new THREE.Vector3().lerpVectors(p, q, t));
    }
  };
  edge(a, b, da, db);
  edge(b, c, db, dc);
  edge(c, a, dc, da);

  if (hits.length < 2) return;
  // A triangle lying IN the plane yields three hits; its edges are covered by the
  // neighbouring triangles, so take the two extremes and let welding sort it out.
  const p0 = hits[0];
  let p1 = hits[1];
  if (hits.length > 2) {
    let best = p0.distanceToSquared(hits[1]);
    for (let i = 2; i < hits.length; i++) {
      const d = p0.distanceToSquared(hits[i]);
      if (d > best) {
        best = d;
        p1 = hits[i];
      }
    }
  }
  if (p0.distanceToSquared(p1) < WELD_EPSILON * WELD_EPSILON) return; // degenerate
  out.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
}

/**
 * Chains loose segments into polylines by walking shared endpoints.
 *
 * Segments come out of the triangle pass in arbitrary order, so this welds their
 * endpoints into nodes, then walks each connected run end to end. A run that
 * returns to its start is a closed loop; anything else (an open mesh, or a seam
 * running off a boundary) stays an open polyline.
 */
function chainSegments(segments: number[]): PlaneMeshCurve[] {
  const nodes = new Map<string, number>(); // weld key → node index
  const nodePos: number[] = []; // xyz per node
  const adjacency: number[][] = []; // node index → connected node indices

  const nodeFor = (x: number, y: number, z: number): number => {
    const key = weldKey(x, y, z);
    const found = nodes.get(key);
    if (found !== undefined) return found;
    const idx = nodePos.length / 3;
    nodes.set(key, idx);
    nodePos.push(x, y, z);
    adjacency.push([]);
    return idx;
  };

  for (let i = 0; i < segments.length; i += 6) {
    const n0 = nodeFor(segments[i], segments[i + 1], segments[i + 2]);
    const n1 = nodeFor(segments[i + 3], segments[i + 4], segments[i + 5]);
    if (n0 === n1) continue;
    if (!adjacency[n0].includes(n1)) adjacency[n0].push(n1);
    if (!adjacency[n1].includes(n0)) adjacency[n1].push(n0);
  }

  const visited = new Set<number>();
  const curves: PlaneMeshCurve[] = [];

  // Walk from every endpoint (degree 1) first so open runs come out whole,
  // then from anything still unvisited to pick up the closed loops.
  const starts = [
    ...adjacency.map((a, i) => (a.length === 1 ? i : -1)).filter((i) => i >= 0),
    ...adjacency.map((_, i) => i),
  ];

  for (const start of starts) {
    if (visited.has(start) || adjacency[start].length === 0) continue;
    const path: number[] = [];
    let current = start;
    let previous = -1;
    for (;;) {
      path.push(current);
      visited.add(current);
      const next = adjacency[current].find((n) => n !== previous && !visited.has(n));
      if (next === undefined) {
        // Closing back onto the start means this run is a loop.
        const closesLoop = adjacency[current].includes(start) && path.length > 2;
        const pts = new Float32Array(path.length * 3);
        for (let i = 0; i < path.length; i++) {
          pts[i * 3] = nodePos[path[i] * 3];
          pts[i * 3 + 1] = nodePos[path[i] * 3 + 1];
          pts[i * 3 + 2] = nodePos[path[i] * 3 + 2];
        }
        if (path.length >= 2) curves.push({ points: pts, closed: closesLoop });
        break;
      }
      previous = current;
      current = next;
    }
  }

  return curves;
}

/**
 * Every curve where `plane` meets `geometry`, in the geometry's local space.
 *
 * Returns an empty array when the plane misses the mesh entirely. Curves shorter
 * than three points are dropped as numerical noise.
 */
export function planeMeshIntersection(
  geometry: THREE.BufferGeometry,
  plane: CutPlane,
): PlaneMeshCurve[] {
  const position = geometry.getAttribute('position');
  if (!position) return [];

  const index = geometry.getIndex();
  const triangleCount = index ? index.count / 3 : position.count / 3;
  const segments: number[] = [];

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();

  for (let t = 0; t < triangleCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(position, i0);
    b.fromBufferAttribute(position, i1);
    c.fromBufferAttribute(position, i2);
    intersectTriangle(a, b, c, plane.normal, plane.offset, segments);
  }

  return chainSegments(segments).filter((curve) => curve.points.length >= 9);
}
