import * as THREE from 'three';
import { FootprintProfile, RaftSettings } from '../RaftTypes';

/**
 * Generate the base plate mesh from a 2D footprint profile.
 * - Footprint profile is assumed to be CCW and non-self-intersecting.
 * - Extrudes upward along +Z by settings.thickness.
 * - Returns a mesh with geometry translated so bottom sits at Z=0.
 */
export function generateBasePlate(
  profile: FootprintProfile,
  settings: Pick<RaftSettings, 'thickness'>
): THREE.Mesh {
  if (!profile || profile.length < 3) {
    // Return empty placeholder mesh
    return new THREE.Mesh(new THREE.BufferGeometry());
  }

  // Build a THREE.Shape from the profile
  const shape = new THREE.Shape();
  shape.moveTo(profile[0].x, profile[0].y);
  for (let i = 1; i < profile.length; i++) {
    shape.lineTo(profile[i].x, profile[i].y);
  }
  shape.closePath();

  const extrudeSettings: THREE.ExtrudeGeometryOptions = {
    depth: Math.max(0, settings.thickness),
    bevelEnabled: false,
    curveSegments: 24,
  };

  const geom = new THREE.ExtrudeGeometry(shape, extrudeSettings);
  geom.computeVertexNormals();
  geom.computeBoundingBox();

  // Ensure bottom is at Z=0 (ExtrudeGeometry already extrudes along +Z from Z=0)
  // But translate slightly to avoid negative zeros
  if (geom.boundingBox) {
    const minZ = geom.boundingBox.min.z;
    if (minZ !== 0) {
      geom.translate(0, 0, -minZ);
    }
  }

  const mesh = new THREE.Mesh(geom);
  return mesh;
}
