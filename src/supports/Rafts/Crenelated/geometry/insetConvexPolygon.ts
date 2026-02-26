import * as THREE from 'three';

function signedArea(poly: THREE.Vector2[]): number {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    area += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
  }
  return area * 0.5;
}

/**
 * Compute an inward offset (inset) of a convex polygon by distance d.
 * Input polygon must be CCW, non-self-intersecting, convex.
 * Returns a new CCW polygon of same vertex count.
 */
export function insetConvexPolygon(poly: THREE.Vector2[], d: number): THREE.Vector2[] {
  if (poly.length < 3 || Math.abs(d) < 1e-5) return poly.map(p => p.clone());

  // Normalize winding so the "left normal" is consistently inward.
  // Convex hull generators typically return CCW, but imported/derived profiles
  // can occasionally be CW.
  const isCcw = signedArea(poly) > 0;
  const workPoly = isCcw ? poly : [...poly].reverse();

  const n = workPoly.length;

  // Build offset lines for each edge
  const linePoints: THREE.Vector2[] = new Array(n);
  const lineDirs: THREE.Vector2[] = new Array(n);
  const inwardNormals: THREE.Vector2[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const a = workPoly[i];
    const b = workPoly[(i + 1) % n];
    const dir = new THREE.Vector2().subVectors(b, a);
    // Left normal points inward for CCW polygon
    const inward = new THREE.Vector2(-dir.y, dir.x);
    const len = inward.length();
    if (len === 0) {
      linePoints[i] = a.clone();
      lineDirs[i] = new THREE.Vector2(1, 0);
      inwardNormals[i] = new THREE.Vector2(0, 0);
      continue;
    }
    inward.multiplyScalar(1 / len);
    inwardNormals[i] = inward.clone();
    // Shift the edge line inward by distance d
    const pShift = new THREE.Vector2(a.x + inward.x * d, a.y + inward.y * d);
    linePoints[i] = pShift;
    lineDirs[i] = dir.clone().normalize();
  }

  // Intersect consecutive offset lines to get inset vertices
  const inset: THREE.Vector2[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const iPrev = (i - 1 + n) % n;
    const p1 = linePoints[iPrev];
    const d1 = lineDirs[iPrev];
    const p2 = linePoints[i];
    const d2 = lineDirs[i];
    const v = intersectLines(p1, d1, p2, d2);
    if (v) {
      inset[i] = v;
      continue;
    }

    // Near-parallel adjacent edges: avoid falling back to the original vertex,
    // which can collapse local ring thickness to nearly zero.
    const prevInward = inwardNormals[iPrev] ?? new THREE.Vector2(0, 0);
    const currInward = inwardNormals[i] ?? new THREE.Vector2(0, 0);
    const avgInward = new THREE.Vector2().addVectors(prevInward, currInward);

    if (avgInward.lengthSq() > 1e-12) {
      avgInward.normalize();
      inset[i] = new THREE.Vector2(
        workPoly[i].x + avgInward.x * d,
        workPoly[i].y + avgInward.y * d,
      );
    } else if (currInward.lengthSq() > 1e-12) {
      inset[i] = new THREE.Vector2(
        workPoly[i].x + currInward.x * d,
        workPoly[i].y + currInward.y * d,
      );
    } else {
      inset[i] = workPoly[i].clone();
    }
  }

  return isCcw ? inset : inset.reverse();
}

function intersectLines(p1: THREE.Vector2, d1: THREE.Vector2, p2: THREE.Vector2, d2: THREE.Vector2): THREE.Vector2 | null {
  // Solve p1 + t d1 = p2 + u d2
  const denom = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(denom) < 1e-8) {
    return null; // Parallel or nearly parallel
  }
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const t = (dx * d2.y - dy * d2.x) * (1 / denom);
  return new THREE.Vector2(p1.x + t * d1.x, p1.y + t * d1.y);
}
