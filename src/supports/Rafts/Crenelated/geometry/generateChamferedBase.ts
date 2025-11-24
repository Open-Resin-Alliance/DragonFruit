import * as THREE from 'three';
import { FootprintProfile, RaftSettings } from '../RaftTypes';
import { insetConvexPolygon } from './insetConvexPolygon';

/**
 * Generate a chamfered raft base given a convex footprint profile.
 * Top face uses the original profile at Z = thickness.
 * Bottom face uses an inward-inset profile at Z = 0 so that the outer wall flares outward (top > bottom).
 * Chamfer amount is computed from thickness and chamferAngle (degrees, 45..90).
 */
export function generateChamferedBase(
  profile: FootprintProfile,
  settings: Pick<RaftSettings, 'thickness' | 'chamferAngle'>
): THREE.Mesh {
  if (!profile || profile.length < 3) {
    // Return empty placeholder mesh
    return new THREE.Mesh(new THREE.BufferGeometry());
  }

  const thickness = Math.max(0, settings.thickness);
  if (thickness === 0) {
    return new THREE.Mesh(new THREE.BufferGeometry());
  }

  const angleDeg = Math.min(90, Math.max(45, settings.chamferAngle));
  // outward angle (wider at top). Bottom should be inset by d so top > bottom.
  // For a right triangle: tan(90 - angle) = adjacent/opposite = (inset) / (thickness)
  const inset = thickness * Math.tan((Math.PI / 180) * (90 - angleDeg));

  // Compute bottom profile by insetting the convex polygon
  const bottomProfile = insetConvexPolygon(profile, inset);

  // Build geometry by stitching top and bottom rings and capping
  const topZ = thickness;
  const bottomZ = 0;
  const n = profile.length;

  // Positions: top ring then bottom ring
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  // Helper to push vertex
  const pushV = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => {
    positions.push(x, y, z);
    normals.push(nx, ny, nz);
    uvs.push(0, 0);
  };

  // Add top ring vertices (approx normal +Z initially)
  for (let i = 0; i < n; i++) {
    const p = profile[i];
    pushV(p.x, p.y, topZ, 0, 0, 1);
  }
  // Add bottom ring vertices (approx normal -Z initially)
  for (let i = 0; i < n; i++) {
    const p = bottomProfile[i];
    pushV(p.x, p.y, bottomZ, 0, 0, -1);
  }

  // Side faces: connect rings (quad per edge -> two triangles)
  for (let i = 0; i < n; i++) {
    const iNext = (i + 1) % n;
    const a = i;              // top i
    const b = iNext;          // top next
    const c = n + iNext;      // bottom next
    const d = n + i;          // bottom i
    // Tri 1: a, c, b  (ensure outward-facing normals)
    indices.push(a, c, b);
    // Tri 2: a, d, c
    indices.push(a, d, c);
  }

  // Cap top (fan from vertex 0)
  for (let i = 1; i < n - 1; i++) {
    indices.push(0, i, i + 1);
  }

  // Cap bottom (fan from bottom 0), note winding reversed for bottom
  for (let i = 1; i < n - 1; i++) {
    // bottom ring starts at index n
    indices.push(n, n + i + 1, n + i);
  }

  // Validate numeric arrays to avoid NaNs
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
