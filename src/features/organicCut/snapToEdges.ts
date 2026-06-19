/**
 * Snap waypoints onto a model's sharp feature edges (creases + boundaries),
 * preferring corners — points where several edges converge.
 *
 * When the user places cut waypoints "in a crease" but a little off it, this
 * pulls each point onto the nearest sharp edge so the cut follows the fold
 * exactly. Where multiple feature edges meet in one spot (a box corner, a
 * crease junction), that corner is a stronger target than a lone edge — a point
 * near it is snapped to the corner itself rather than sliding onto one edge.
 *
 * It's a pure geometry helper: give it the loop points and the model geometry
 * (both in the SAME model-local space — they are, since waypoints are stored in
 * the geometry's local space; see OrganicCutTool) and it returns the
 * repositioned points.
 *
 * Sharp edges are found with THREE.EdgesGeometry, which emits an edge wherever
 * the two faces sharing it differ in orientation by more than a threshold angle
 * (a crease), plus every boundary (single-face) edge. The same primitive is
 * already used in this feature for the key-preview silhouette.
 */
import * as THREE from 'three';
import type { OrganicCutLoopPoint } from './types';

/**
 * Dihedral angle (degrees) above which a shared edge counts as a sharp
 * feature/crease. ~30° ignores the gentle facet-to-facet angles of a tessellated
 * curved surface (so points don't snap to tessellation noise) while still
 * catching real folds. Tune up to be stricter, down to catch shallower creases.
 */
export const FEATURE_EDGE_ANGLE_DEG = 30;

/** A vertex where at least this many feature edges meet is always a corner. */
const CORNER_MIN_DEGREE = 3;
/**
 * For a vertex where exactly TWO feature edges meet (a crease passing through),
 * it only counts as a corner if the crease turns by more than this angle — so a
 * genuine kink (an L-bend) is a corner but a gently curving crease's per-vertex
 * micro-turns are not (else points would quantize to mesh vertices along it).
 */
const CORNER_BEND_DEG = 60;
/**
 * How far we'll reach for a corner, as a fraction of the model's bbox diagonal —
 * measured ALONG the feature edges (geodesic / arc length), NOT straight-line.
 *
 * A point is first projected onto the nearest crease; from that foot we walk the
 * feature-edge graph and snap to a corner reachable within this arc length. Using
 * arc length is the whole point: a corner on the far side of a rounded ridge can
 * be straight-line-close yet far along the crease (you'd have to travel over the
 * hump to get there), so the curve's length keeps it out of reach and the point
 * stays on the nearer corner. Tune up to grab corners from farther along a crease,
 * down to keep snapping local.
 */
const CORNER_GEODESIC_REACH_FRACTION = 0.06;
/**
 * Max "detour" allowed when reaching a corner: the ratio of the along-edge arc
 * to the straight-line distance from the projection's foot to that corner.
 *
 * This is the scale-INVARIANT guard against over-reaching on small features.
 * A corner straight ahead along the crease (a ridge tip, a bend you're walking
 * toward) has arc ≈ straight line → ratio ≈ 1 → kept. A corner reached only by
 * curving far around — the far side of a small bulge, over a rounded radius — has
 * an arc much longer than the straight line → ratio high → rejected, no matter
 * how the feature compares in size to the model. ~1.3 lets gently-curved
 * approaches through while cutting paths that wrap past ~a quarter-turn.
 */
const CORNER_MAX_DETOUR = 1.3;

export interface SnapResult {
  /** New points, each projected onto the nearest feature edge (or corner). */
  points: OrganicCutLoopPoint[];
  /** How many points actually moved (position changed beyond epsilon). */
  movedCount: number;
  /** Feature-edge segments found on the model. 0 → nothing to snap to (no-op). */
  edgeCount: number;
  /** Corners (edge junctions / sharp kinks) found on the model. */
  cornerCount: number;
  /** How many points snapped to a corner (vs slid onto a plain edge). */
  cornerSnapCount: number;
}

/**
 * Extract the model's sharp feature edges as a flat segment list (model-local):
 * `[ax,ay,az, bx,by,bz, ...]`, 6 floats per segment. Empty when the model has no
 * creases or boundaries above the threshold (e.g. a smooth closed sphere).
 */
export function extractFeatureEdges(
  geometry: THREE.BufferGeometry,
  thresholdDeg: number = FEATURE_EDGE_ANGLE_DEG,
): Float32Array {
  const edges = new THREE.EdgesGeometry(geometry, thresholdDeg);
  const pos = edges.getAttribute('position') as THREE.BufferAttribute | undefined;
  const out = pos ? (pos.array as Float32Array).slice() : new Float32Array(0);
  edges.dispose();
  return out;
}

/** A corner: a welded edge endpoint, its position, how many edges meet there. */
interface Corner {
  x: number;
  y: number;
  z: number;
  degree: number;
  /** This corner's node id in the feature-edge graph (for the geodesic walk). */
  node: number;
}

interface FeatureGraph {
  /** All qualifying corners (junctions + sharp kinks). */
  corners: Corner[];
  /**
   * Graph node id at a welded position, or undefined if no edge touches it. Uses
   * the SAME weld bucket as the build, so a feature-edge segment endpoint (the
   * exact floats) reliably resolves to its node.
   */
  nodeAt: (x: number, y: number, z: number) => number | undefined;
  /** Neighbours of a node: connected node + the edge's length (arc weight). */
  neighbors: (node: number) => ReadonlyArray<{ to: number; w: number }>;
  /** The corner sitting at a node, if that node is a corner. */
  cornerByNode: Map<number, Corner>;
}

/**
 * Build the feature-edge graph: weld coincident endpoints into nodes, record the
 * incident edges (with their lengths) as a weighted adjacency list, and flag the
 * corners (junctions degree ≥ 3 or sharp 2-edge kinks). The weighted graph is
 * what lets a snap measure distance to a corner ALONG the creases (geodesic),
 * not as a straight line. `diag` (model bbox diagonal) sets the weld tolerance.
 */
function buildFeatureGraph(seg: Float32Array, diag: number): FeatureGraph {
  const weldEps = Math.max(diag * 1e-5, 1e-9);
  const cosBendLimit = Math.cos(((180 - CORNER_BEND_DEG) * Math.PI) / 180);

  // Per welded vertex: position + the unit direction of each incident edge,
  // pointing AWAY from the vertex (used to measure how sharply a crease turns).
  const verts = new Map<string, { x: number; y: number; z: number; dirs: number[][] }>();
  const keyOf = (x: number, y: number, z: number) =>
    `${Math.round(x / weldEps)},${Math.round(y / weldEps)},${Math.round(z / weldEps)}`;

  // Weighted adjacency list keyed by a dense node id (one per welded position).
  const nodeId = new Map<string, number>();
  const adj: { to: number; w: number }[][] = [];
  const nodeOf = (k: string): number => {
    let id = nodeId.get(k);
    if (id === undefined) {
      id = adj.length;
      nodeId.set(k, id);
      adj.push([]);
    }
    return id;
  };

  const addIncidence = (x: number, y: number, z: number, dx: number, dy: number, dz: number) => {
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-12) return;
    const k = keyOf(x, y, z);
    let v = verts.get(k);
    if (!v) {
      v = { x, y, z, dirs: [] };
      verts.set(k, v);
    }
    v.dirs.push([dx / len, dy / len, dz / len]);
  };

  for (let i = 0; i < seg.length; i += 6) {
    const ax = seg[i];
    const ay = seg[i + 1];
    const az = seg[i + 2];
    const bx = seg[i + 3];
    const by = seg[i + 4];
    const bz = seg[i + 5];
    addIncidence(ax, ay, az, bx - ax, by - ay, bz - az);
    addIncidence(bx, by, bz, ax - bx, ay - by, az - bz);
    const na = nodeOf(keyOf(ax, ay, az));
    const nb = nodeOf(keyOf(bx, by, bz));
    const w = Math.hypot(bx - ax, by - ay, bz - az);
    if (w > 1e-12 && na !== nb) {
      adj[na].push({ to: nb, w });
      adj[nb].push({ to: na, w });
    }
  }

  const corners: Corner[] = [];
  const cornerByNode = new Map<number, Corner>();
  const keep = (v: { x: number; y: number; z: number }, degree: number) => {
    const node = nodeOf(keyOf(v.x, v.y, v.z));
    const c: Corner = { x: v.x, y: v.y, z: v.z, degree, node };
    corners.push(c);
    cornerByNode.set(node, c);
  };
  for (const v of verts.values()) {
    const degree = v.dirs.length;
    if (degree >= CORNER_MIN_DEGREE) {
      keep(v, degree);
    } else if (degree === 2) {
      // Two edges meet: a corner only if the crease kinks. dot of the two
      // outgoing dirs ≈ -1 when straight (they point opposite); a sharp turn
      // raises it. Above cos(180-bend) → kink → corner.
      const [d0, d1] = v.dirs;
      const dot = d0[0] * d1[0] + d0[1] * d1[1] + d0[2] * d1[2];
      if (dot > cosBendLimit) keep(v, degree);
    }
  }
  return {
    corners,
    nodeAt: (x, y, z) => nodeId.get(keyOf(x, y, z)),
    neighbors: (node) => adj[node] ?? [],
    cornerByNode,
  };
}

/**
 * Tiny binary min-heap of (distance, node) pairs for the geodesic Dijkstra walk.
 * Parallel arrays keep it allocation-light; only the ops the walk needs exist.
 */
class MinHeap {
  private dist: number[] = [];
  private node: number[] = [];

  get size(): number {
    return this.dist.length;
  }

  push(dist: number, node: number): void {
    this.dist.push(dist);
    this.node.push(node);
    let i = this.dist.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.dist[parent] <= this.dist[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): { dist: number; node: number } {
    const dist = this.dist[0];
    const node = this.node[0];
    const last = this.dist.length - 1;
    this.swap(0, last);
    this.dist.pop();
    this.node.pop();
    const len = this.dist.length;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < len && this.dist[l] < this.dist[m]) m = l;
      if (r < len && this.dist[r] < this.dist[m]) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
    return { dist, node };
  }

  private swap(a: number, b: number): void {
    const td = this.dist[a];
    this.dist[a] = this.dist[b];
    this.dist[b] = td;
    const tn = this.node[a];
    this.node[a] = this.node[b];
    this.node[b] = tn;
  }
}

/**
 * Snap every waypoint onto the model's nearest feature edge, preferring a corner
 * (edge junction / sharp kink) when the point is near one ALONG the creases. Each
 * position is projected onto the closest crease/boundary segment; from that foot
 * we walk the feature-edge graph and, if a qualifying corner lies within a modest
 * arc length, snap to it instead (the corner with the MOST edges meeting it wins
 * when several are comparably near). Measuring distance along the edges — not as a
 * straight line — is what stops a point from leaping over a rounded ridge to a
 * corner that's Euclidean-close but far along the crease. Normals are left
 * untouched (the membrane recompute re-fits the seam to the surface from the new
 * positions). A no-op returning the points unchanged when the model has no
 * feature edges.
 */
export function snapPointsToFeatureEdges(
  points: OrganicCutLoopPoint[],
  geometry: THREE.BufferGeometry,
  thresholdDeg: number = FEATURE_EDGE_ANGLE_DEG,
): SnapResult {
  const seg = extractFeatureEdges(geometry, thresholdDeg);
  const edgeCount = seg.length / 6;
  if (edgeCount === 0 || points.length === 0) {
    return { points, movedCount: 0, edgeCount, cornerCount: 0, cornerSnapCount: 0 };
  }

  const bbox =
    geometry.boundingBox ??
    new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position') as THREE.BufferAttribute);
  const diag = bbox.getSize(new THREE.Vector3()).length() || 1;
  const maxGeo = diag * CORNER_GEODESIC_REACH_FRACTION;

  const { corners, nodeAt, neighbors, cornerByNode } = buildFeatureGraph(seg, diag);

  // Treat a sub-epsilon move as "didn't move" so a point already on an edge
  // doesn't count toward movedCount (and the loop isn't churned for nothing).
  const EPS_SQ = (diag * 1e-7) ** 2;
  let movedCount = 0;
  let cornerSnapCount = 0;

  const nextPoints = points.map((p) => {
    const px = p.position[0];
    const py = p.position[1];
    const pz = p.position[2];

    // 1) Nearest point over all segments: project p onto each [a,b], clamp to
    // the segment, keep the closest. Brute force — fine for the modest
    // feature-edge count of a typical part and a loop of a few dozen waypoints.
    let edgeX = px;
    let edgeY = py;
    let edgeZ = pz;
    let bestEdgeD = Infinity;
    // Endpoints of the winning segment — the entry nodes for the geodesic walk.
    let segAx = 0;
    let segAy = 0;
    let segAz = 0;
    let segBx = 0;
    let segBy = 0;
    let segBz = 0;
    for (let i = 0; i < seg.length; i += 6) {
      const ax = seg[i];
      const ay = seg[i + 1];
      const az = seg[i + 2];
      const bx = seg[i + 3];
      const by = seg[i + 4];
      const bz = seg[i + 5];
      const abx = bx - ax;
      const aby = by - ay;
      const abz = bz - az;
      const lenSq = abx * abx + aby * aby + abz * abz;
      let t = 0;
      if (lenSq > 1e-12) {
        t = ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / lenSq;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
      }
      const cx = ax + abx * t;
      const cy = ay + aby * t;
      const cz = az + abz * t;
      const dx = cx - px;
      const dy = cy - py;
      const dz = cz - pz;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestEdgeD) {
        bestEdgeD = d;
        edgeX = cx;
        edgeY = cy;
        edgeZ = cz;
        segAx = ax;
        segAy = ay;
        segAz = az;
        segBx = bx;
        segBy = by;
        segBz = bz;
      }
    }
    // 2) Geodesic corner preference. The foot lies on the winning segment, whose
    // two endpoints are graph nodes; seed a Dijkstra there with the foot's
    // distance to each endpoint, then walk the feature-edge graph accumulating
    // ALONG-EDGE distance. A corner reached within maxGeo is a candidate, scored
    // by `arc / sqrt(degree - 1)` — the "more edges in the same spot" preference
    // (a junction beats a comparably-near plain kink) over arc length, not
    // straight line. Because the cost is measured along the creases, a corner on
    // the far side of a rounded ridge is far (its hump adds arc length) even when
    // it's Euclidean-close, so the point won't jump the ridge to reach it.
    let chosen: Corner | null = null;
    let chosenScore = Infinity;
    const nodeA = nodeAt(segAx, segAy, segAz);
    const nodeB = nodeAt(segBx, segBy, segBz);
    if (nodeA !== undefined || nodeB !== undefined) {
      const best = new Map<number, number>(); // node → shortest arc from the foot
      const heap = new MinHeap();
      const seed = (node: number | undefined, footDist: number) => {
        if (node === undefined || footDist > maxGeo) return;
        if (footDist < (best.get(node) ?? Infinity)) {
          best.set(node, footDist);
          heap.push(footDist, node);
        }
      };
      seed(nodeA, Math.hypot(edgeX - segAx, edgeY - segAy, edgeZ - segAz));
      seed(nodeB, Math.hypot(edgeX - segBx, edgeY - segBy, edgeZ - segBz));

      while (heap.size > 0) {
        const { dist, node } = heap.pop();
        if (dist > (best.get(node) ?? Infinity)) continue; // stale heap entry
        if (dist > maxGeo) break; // min-ordered: everything left is farther
        const c = cornerByNode.get(node);
        if (c) {
          // Detour gate: reject a corner reached by curving far around (the far
          // side of a small bulge, over a rounded radius) — its along-edge arc
          // far exceeds the straight line to it. Scale-invariant, so a small
          // feature on a big model is judged by its path shape, not the reach.
          const straight = Math.hypot(c.x - edgeX, c.y - edgeY, c.z - edgeZ);
          if (straight <= 1e-9 || dist <= straight * CORNER_MAX_DETOUR) {
            const score = dist / Math.sqrt(c.degree - 1);
            if (score < chosenScore) {
              chosen = c;
              chosenScore = score;
            }
          }
        }
        for (const { to, w } of neighbors(node)) {
          const nd = dist + w;
          if (nd > maxGeo) continue;
          if (nd < (best.get(to) ?? Infinity)) {
            best.set(to, nd);
            heap.push(nd, to);
          }
        }
      }
    }

    const tx = chosen ? chosen.x : edgeX;
    const ty = chosen ? chosen.y : edgeY;
    const tz = chosen ? chosen.z : edgeZ;
    if (chosen) cornerSnapCount += 1;

    const mdx = tx - px;
    const mdy = ty - py;
    const mdz = tz - pz;
    if (mdx * mdx + mdy * mdy + mdz * mdz > EPS_SQ) movedCount += 1;

    return {
      position: [tx, ty, tz] as [number, number, number],
      normal: p.normal,
    };
  });

  return { points: nextPoints, movedCount, edgeCount, cornerCount: corners.length, cornerSnapCount };
}
