import * as THREE from 'three';

/**
 * Shoelace area of a closed polygon. Positive when the winding is
 * counter-clockwise, negative when clockwise.
 */
export function signedArea2d(poly: THREE.Vector2[]): number {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    area += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
  }
  return area * 0.5;
}
