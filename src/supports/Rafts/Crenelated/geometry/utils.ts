import * as THREE from 'three';

export function dedupePolygon(poly: THREE.Vector2[], eps = 1e-6): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    if (p.distanceTo(q) > eps) out.push(p.clone());
  }
  return out.length >= 3 ? out : poly.slice();
}

/**
 * Conservative max inset distance for a convex polygon.
 * Uses centroid and edge half-planes; returns min distance from centroid to any edge.
 */
export function maxInsetForConvex(poly: THREE.Vector2[]): number {
  if (poly.length < 3) return 0;
  const centroid = poly.reduce((acc, p) => acc.add(new THREE.Vector2(p.x, p.y)), new THREE.Vector2()).multiplyScalar(1 / poly.length);
  let minDist = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const edge = new THREE.Vector2().subVectors(b, a);
    const n = new THREE.Vector2(-edge.y, edge.x).normalize(); // inward for CCW
    const dist = n.dot(new THREE.Vector2().subVectors(centroid, a));
    if (dist < minDist) minDist = dist;
  }
  return Math.max(0, minDist);
}
