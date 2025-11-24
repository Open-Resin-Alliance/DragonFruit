import * as THREE from 'three';
import { FootprintProfile, RaftSettings } from '../RaftTypes';
import { insetConvexPolygon } from './insetConvexPolygon';

/**
 * Generate a perimeter wall around the raft footprint.
 * Current MVP: solid continuous ring (no crenulations yet).
 * - Outer profile is the original top profile (convex, CCW)
 * - Inner profile is inset by wallThickness
 * - Extruded upward by wallHeight
 */
export function generatePerimeterWall(
  topProfile: FootprintProfile,
  settings: Pick<RaftSettings, 'wallThickness' | 'wallHeight' | 'thickness'>
): THREE.Mesh {
  const wallHeight = Math.max(0, settings.wallHeight);
  const wallThickness = Math.max(0, settings.wallThickness);
  if (!topProfile || topProfile.length < 3 || wallHeight === 0 || wallThickness === 0) {
    return new THREE.Mesh(new THREE.BufferGeometry());
  }

  // For a CCW convex polygon, inward inset creates inner wall face
  const innerProfile = insetConvexPolygon(topProfile, wallThickness);

  // Build a shape with a hole: outer = topProfile, inner = innerProfile
  const outer = new THREE.Shape();
  outer.moveTo(topProfile[0].x, topProfile[0].y);
  for (let i = 1; i < topProfile.length; i++) outer.lineTo(topProfile[i].x, topProfile[i].y);
  outer.closePath();

  const hole = new THREE.Path();
  hole.moveTo(innerProfile[0].x, innerProfile[0].y);
  for (let i = 1; i < innerProfile.length; i++) hole.lineTo(innerProfile[i].x, innerProfile[i].y);
  hole.closePath();
  outer.holes.push(hole);

  const extrudeSettings: THREE.ExtrudeGeometryOptions = {
    depth: wallHeight,
    bevelEnabled: false,
    curveSegments: 24,
  };

  const geom = new THREE.ExtrudeGeometry(outer, extrudeSettings);
  geom.computeVertexNormals();
  // Position wall so its bottom sits on top of the base plate at Z = thickness
  geom.translate(0, 0, Math.max(0, settings.thickness));

  return new THREE.Mesh(geom);
}
