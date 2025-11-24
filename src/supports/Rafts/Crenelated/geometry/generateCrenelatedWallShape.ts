import * as THREE from 'three';
import { FootprintProfile, RaftSettings } from '../RaftTypes';
import { insetConvexPolygon } from './insetConvexPolygon';

/**
 * Generate a crenelated wall by building a THREE.Shape with rectangular holes
 * placed only on straight runs of the outer profile. Curved spans remain solid.
 *
 * - Rectangles are aligned perpendicular to the wall (orthogonal faces)
 * - Width = crenulationGapWidth along tangent
 * - Depth = wallThickness (slightly reduced by eps) along inward normal
 */
export function generateCrenelatedWallShape(
  topProfile: FootprintProfile,
  settings: Pick<RaftSettings, 'thickness' | 'wallThickness' | 'wallHeight' | 'crenulationGapWidth' | 'crenulationSpacing'>
): THREE.Mesh {
  const wallHeight = Math.max(0, settings.wallHeight);
  const wallThickness = Math.max(0, settings.wallThickness);
  const gapW = Math.max(0, settings.crenulationGapWidth);
  if (!topProfile || topProfile.length < 3 || wallHeight === 0 || wallThickness === 0) {
    return new THREE.Mesh(new THREE.BufferGeometry());
  }

  // Build outer and inner boundaries
  const outer = topProfile;
  const inner = insetConvexPolygon(outer, wallThickness);

  // Construct outer shape path
  const outerShape = new THREE.Shape();
  outerShape.moveTo(outer[0].x, outer[0].y);
  for (let i = 1; i < outer.length; i++) outerShape.lineTo(outer[i].x, outer[i].y);
  outerShape.closePath();

  // Determine outer orientation (signed area > 0 => CCW)
  const outerArea = (() => {
    let a = 0;
    for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
      a += (outer[j].x * outer[i].y - outer[i].x * outer[j].y);
    }
    return a / 2;
  })();
  const outerIsCCW = outerArea > 0;

  // Add inner hole for the wall ring
  const innerPath = new THREE.Path();
  innerPath.moveTo(inner[0].x, inner[0].y);
  for (let i = 1; i < inner.length; i++) innerPath.lineTo(inner[i].x, inner[i].y);
  innerPath.closePath();
  outerShape.holes.push(innerPath);

  // Identify straight runs by checking edge-to-edge angle changes
  // A truly straight run will have very small angle changes between consecutive edges
  const n = outer.length;
  const edges: Array<{ dir: THREE.Vector2; len: number }> = [];
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    const dir = new THREE.Vector2().subVectors(outer[next], outer[i]);
    const len = dir.length();
    dir.normalize();
    edges.push({ dir, len });
  }

  // Mark edges that are part of straight runs (small angle change from previous edge)
  const straightTolDeg = 15.0; // More tolerant for discretized polygons
  const isStraightEdge = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    const iPrev = (i - 1 + n) % n;
    const dot = THREE.MathUtils.clamp(edges[iPrev].dir.dot(edges[i].dir), -1, 1);
    const ang = Math.acos(dot) * 180 / Math.PI;
    isStraightEdge[i] = ang <= straightTolDeg;
  }

  // Gather consecutive straight edges into runs
  const straightRuns: Array<{ start: number; end: number; length: number }>= [];
  let i = 0;
  while (i < n) {
    if (!isStraightEdge[i]) { i++; continue; }
    const start = i;
    let totalLen = 0;
    let j = i;
    while (j < i + n && isStraightEdge[j % n]) {
      totalLen += edges[j % n].len;
      j++;
    }
    const end = (j - 1) % n;
    const count = j - i;
    // Relaxed: at least 2 edges and 3mm total length
    if (count >= 2 && totalLen > 3.0) {
      straightRuns.push({ start: start % n, end, length: totalLen });
    }
    i = j;
  }
  
  console.log(`[Crenelations] Found ${straightRuns.length} straight runs:`, straightRuns.map(r => ({ 
    start: r.start, 
    end: r.end, 
    length: r.length.toFixed(2) 
  })));

  // Helper to get point along polyline between vertex indices (walk edges)
  function edgeVec(a: THREE.Vector2, b: THREE.Vector2) { return new THREE.Vector2().subVectors(b, a); }

  // For each straight run, place rectangular holes
  const cornerMargin = 1.0; // mm from corners
  const epsInset = Math.min(0.05, wallThickness * 0.1); // ensure hole inside the wall (larger safety)

  let holesPlaced = 0;
  for (const run of straightRuns) {
    // Use the first edge direction as the tangent for the entire run
    const tangent = edges[run.start].dir.clone();
    const len = run.length;
    
    if (len < gapW + 2 * cornerMargin) continue;
    
    // Inward normal (perpendicular to tangent, pointing into the polygon)
    // For CCW polygon, rotate tangent 90° clockwise gives inward
    const inward = new THREE.Vector2(-tangent.y, tangent.x);
    
    // Starting point of the run
    const A = outer[run.start];

    // Fixed count per straight run: 3 holes
    const count = 3;
    const usableLen = Math.max(0, len - 2 * cornerMargin);
    if (usableLen < gapW) continue;
    const segmentLen = usableLen / count;
    const halfW = gapW / 2;
    const depth = Math.max(0, wallThickness - epsInset);

    for (let k = 0; k < count; k++) {
      const sCenter = cornerMargin + segmentLen * (k + 0.5);
      const center = new THREE.Vector2(A.x + tangent.x * sCenter, A.y + tangent.y * sCenter);
      // Rectangle corners (centered, width along tangent, depth along inward)
      const p0 = new THREE.Vector2(
        center.x - tangent.x * halfW,
        center.y - tangent.y * halfW
      );
      const p1 = new THREE.Vector2(
        center.x + tangent.x * halfW,
        center.y + tangent.y * halfW
      );
      const p2 = new THREE.Vector2(
        p1.x + inward.x * depth,
        p1.y + inward.y * depth
      );
      const p3 = new THREE.Vector2(
        p0.x + inward.x * depth,
        p0.y + inward.y * depth
      );

      const hole = new THREE.Path();
      if (outerIsCCW) {
        // Holes must be CW relative to CCW outer
        hole.moveTo(p0.x, p0.y);
        hole.lineTo(p3.x, p3.y);
        hole.lineTo(p2.x, p2.y);
        hole.lineTo(p1.x, p1.y);
      } else {
        // Outer is CW, use CCW holes
        hole.moveTo(p0.x, p0.y);
        hole.lineTo(p1.x, p1.y);
        hole.lineTo(p2.x, p2.y);
        hole.lineTo(p3.x, p3.y);
      }
      hole.closePath();
      outerShape.holes.push(hole);
      holesPlaced++;
    }
  }
  
  console.log(`[Crenelations] Placed ${holesPlaced} holes total`);

  // Fallback: if no holes placed but we have straight runs long enough, place one centered gap on the longest run
  if (holesPlaced === 0 && straightRuns.length > 0) {
    let best = straightRuns[0];
    for (const run of straightRuns) {
      if (run.length > best.length) best = run;
    }
    
    if (best.length >= gapW + 2 * cornerMargin) {
      const tangent = edges[best.start].dir.clone();
      const inward = new THREE.Vector2(-tangent.y, tangent.x);
      const depth = Math.max(0, wallThickness - epsInset);
      const A = outer[best.start];
      const sCenter = best.length / 2;
      const center = new THREE.Vector2(A.x + tangent.x * sCenter, A.y + tangent.y * sCenter);
      const halfW = gapW / 2;
      
      const p0 = new THREE.Vector2(center.x - tangent.x * halfW, center.y - tangent.y * halfW);
      const p1 = new THREE.Vector2(center.x + tangent.x * halfW, center.y + tangent.y * halfW);
      const p2 = new THREE.Vector2(p1.x + inward.x * depth, p1.y + inward.y * depth);
      const p3 = new THREE.Vector2(p0.x + inward.x * depth, p0.y + inward.y * depth);
      
      const hole = new THREE.Path();
      if (outerIsCCW) {
        hole.moveTo(p0.x, p0.y);
        hole.lineTo(p3.x, p3.y);
        hole.lineTo(p2.x, p2.y);
        hole.lineTo(p1.x, p1.y);
      } else {
        hole.moveTo(p0.x, p0.y);
        hole.lineTo(p1.x, p1.y);
        hole.lineTo(p2.x, p2.y);
        hole.lineTo(p3.x, p3.y);
      }
      hole.closePath();
      outerShape.holes.push(hole);
    }
  }

  // Extrude
  const extrudeSettings: THREE.ExtrudeGeometryOptions = {
    depth: wallHeight,
    bevelEnabled: false,
    curveSegments: 24,
  };
  const geom = new THREE.ExtrudeGeometry(outerShape, extrudeSettings);
  geom.computeVertexNormals();
  geom.translate(0, 0, Math.max(0, settings.thickness));

  return new THREE.Mesh(geom);
}
