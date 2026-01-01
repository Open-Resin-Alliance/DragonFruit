import * as THREE from 'three';
import type { FootprintProfile } from '../RaftTypes';
import { insetConvexPolygon } from './insetConvexPolygon';

export function generatePerimeterBorderBeam(
  profile: FootprintProfile,
  settings: {
    widthMm: number;
    heightMm: number;
    chamferAngleDeg: number;
  }
): THREE.Mesh {
  const width = Math.max(0, settings.widthMm);
  const height = Math.max(0, settings.heightMm);
  const angleDeg = Math.min(90, Math.max(45, settings.chamferAngleDeg));

  if (!profile || profile.length < 3 || width === 0 || height === 0) {
    return new THREE.Mesh(new THREE.BufferGeometry());
  }

  const innerTop = insetConvexPolygon(profile, width);
  if (!innerTop || innerTop.length < 3) {
    return new THREE.Mesh(new THREE.BufferGeometry());
  }

  // Chamfer semantics match solid raft base:
  // Top uses the full outer profile. Bottom is inset so the outer face slopes outward (top wider than bottom).
  const chamferInset = height * Math.tan((Math.PI / 180) * (90 - angleDeg));
  const outerBottom = chamferInset > 0 ? insetConvexPolygon(profile, chamferInset) : profile;
  if (!outerBottom || outerBottom.length < 3) {
    return new THREE.Mesh(new THREE.BufferGeometry());
  }

  // Inner wall stays vertical: same inner loop top and bottom.
  const innerBottom = innerTop;

  const n = profile.length;
  if (outerBottom.length !== n || innerTop.length !== n) {
    return new THREE.Mesh(new THREE.BufferGeometry());
  }

  // Vertex layout:
  // 0..n-1: outerTop (z=height)
  // n..2n-1: innerTop (z=height)
  // 2n..3n-1: outerBottom (z=0)
  // 3n..4n-1: innerBottom (z=0)
  const positions: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i < n; i++) {
    const p = profile[i];
    positions.push(p.x, p.y, height);
  }
  for (let i = 0; i < n; i++) {
    const p = innerTop[i];
    positions.push(p.x, p.y, height);
  }
  for (let i = 0; i < n; i++) {
    const p = outerBottom[i];
    positions.push(p.x, p.y, 0);
  }
  for (let i = 0; i < n; i++) {
    const p = innerBottom[i];
    positions.push(p.x, p.y, 0);
  }

  // Outer wall (connect outerTop to outerBottom)
  for (let i = 0; i < n; i++) {
    const iNext = (i + 1) % n;
    const a = i; // outerTop i
    const b = iNext; // outerTop next
    const c = 2 * n + iNext; // outerBottom next
    const d = 2 * n + i; // outerBottom i
    indices.push(a, c, b);
    indices.push(a, d, c);
  }

  // Inner wall (connect innerBottom to innerTop). Wind so normals face inward toward the hole.
  for (let i = 0; i < n; i++) {
    const iNext = (i + 1) % n;
    const a = 3 * n + i; // innerBottom i
    const b = 3 * n + iNext; // innerBottom next
    const c = n + iNext; // innerTop next
    const d = n + i; // innerTop i
    indices.push(a, c, b);
    indices.push(a, d, c);
  }

  // Top cap: outerTop to innerTop
  for (let i = 0; i < n; i++) {
    const iNext = (i + 1) % n;
    const a = i; // outerTop i
    const b = iNext; // outerTop next
    const c = n + iNext; // innerTop next
    const d = n + i; // innerTop i
    indices.push(a, b, c);
    indices.push(a, c, d);
  }

  // Bottom cap: outerBottom to innerBottom (reverse winding)
  for (let i = 0; i < n; i++) {
    const iNext = (i + 1) % n;
    const a = 2 * n + i; // outerBottom i
    const b = 2 * n + iNext; // outerBottom next
    const c = 3 * n + iNext; // innerBottom next
    const d = 3 * n + i; // innerBottom i
    indices.push(a, c, b);
    indices.push(a, d, c);
  }

  const allFinite = positions.every((v) => Number.isFinite(v));
  if (!allFinite) {
    return new THREE.Mesh(new THREE.BufferGeometry());
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();

  return new THREE.Mesh(geom);
}
