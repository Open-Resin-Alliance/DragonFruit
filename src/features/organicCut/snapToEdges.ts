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
 * Prefer a corner over the nearest edge when the corner is no farther than this
 * multiple of the nearest-edge distance. Near a corner both distances are small
 * and comparable, so the corner wins; far along a crease the nearest corner is
 * much farther than the edge, so the edge wins and the point stays put.
 */
const CORNER_REL_BIAS = 2.0;
/**
 * ...and always prefer a corner that's within this fraction of the model's
 * bbox diagonal, even if an edge is marginally closer (grab a corner the point
 * is already sitting right next to).
 */
const CORNER_SNAP_FRACTION = 0.02;

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

/** A corner: a welded edge endpoint, its position, and how many edges meet there. */
interface Corner {
  x: number;
  y: number;
  z: number;
  degree: number;
}

/**
 * Find corners from the feature-edge segments: weld coincident endpoints, count
 * how many edges meet at each, and keep those that are junctions (degree ≥ 3) or
 * sharp 2-edge kinks. `diag` (model bbox diagonal) sets the weld tolerance.
 */
function buildCorners(seg: Float32Array, diag: number): Corner[] {
  const weldEps = Math.max(diag * 1e-5, 1e-9);
  const cosBendLimit = Math.cos(((180 - CORNER_BEND_DEG) * Math.PI) / 180);

  // Per welded vertex: position + the unit direction of each incident edge,
  // pointing AWAY from the vertex (used to measure how sharply a crease turns).
  const verts = new Map<string, { x: number; y: number; z: number; dirs: number[][] }>();
  const keyOf = (x: number, y: number, z: number) =>
    `${Math.round(x / weldEps)},${Math.round(y / weldEps)},${Math.round(z / weldEps)}`;

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
  }

  const corners: Corner[] = [];
  for (const v of verts.values()) {
    const degree = v.dirs.length;
    if (degree >= CORNER_MIN_DEGREE) {
      corners.push({ x: v.x, y: v.y, z: v.z, degree });
    } else if (degree === 2) {
      // Two edges meet: a corner only if the crease kinks. dot of the two
      // outgoing dirs ≈ -1 when straight (they point opposite); a sharp turn
      // raises it. Above cos(180-bend) → kink → corner.
      const [d0, d1] = v.dirs;
      const dot = d0[0] * d1[0] + d0[1] * d1[1] + d0[2] * d1[2];
      if (dot > cosBendLimit) corners.push({ x: v.x, y: v.y, z: v.z, degree });
    }
  }
  return corners;
}

/**
 * Snap every waypoint onto the model's nearest feature edge, preferring a corner
 * (edge junction / sharp kink) when the point is near one. Each position is
 * projected onto the closest crease/boundary segment; if a qualifying corner is
 * about as close — or the point is sitting right next to it — the point snaps to
 * that corner instead, choosing the corner with the MOST edges meeting it when
 * several are in range. Normals are left untouched (the geodesic/membrane
 * recompute re-fits the seam to the surface from the new positions). A no-op
 * returning the points unchanged when the model has no feature edges.
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
  const cornerRadius = diag * CORNER_SNAP_FRACTION;

  const corners = buildCorners(seg, diag);

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
    for (let i = 0; i < seg.length; i += 6) {
      const ax = seg[i];
      const ay = seg[i + 1];
      const az = seg[i + 2];
      const abx = seg[i + 3] - ax;
      const aby = seg[i + 4] - ay;
      const abz = seg[i + 5] - az;
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
      }
    }
    const bestEdgeDist = Math.sqrt(bestEdgeD);

    // 2) Among corners IN RANGE (no farther than CORNER_REL_BIAS× the nearest
    // edge, or within an absolute grab radius), pick by a distance score that
    // discounts higher-degree corners: `dist / sqrt(degree - 1)`. This is the
    // "more edges in the same spot" preference — a junction beats a closer plain
    // kink when they're comparably near — without letting a far junction yank a
    // point past a much closer corner. Corners win over the plain edge point.
    const rangeDist = Math.max(bestEdgeDist * CORNER_REL_BIAS, cornerRadius);
    let chosen: Corner | null = null;
    let chosenScore = Infinity;
    for (const c of corners) {
      const dx = c.x - px;
      const dy = c.y - py;
      const dz = c.z - pz;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > rangeDist) continue;
      const score = dist / Math.sqrt(c.degree - 1);
      if (score < chosenScore) {
        chosen = c;
        chosenScore = score;
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
