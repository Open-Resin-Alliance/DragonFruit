import * as THREE from 'three';
import type { AutoSupportContactCandidate, AutoSupportExclusion } from './types';

export const SURFACE_FILL_VOLUME_ID = -1;

// Stacked overhangs (an arm above a leg) live in the same XY cell; banding by
// z lets each get its own sample.
const Z_BAND_FACTOR = 1.5;

function isExcluded(x: number, y: number, z: number, exclusions: AutoSupportExclusion[]): boolean {
  return exclusions.some((exclusion) => {
    const dx = x - exclusion.x;
    const dy = y - exclusion.y;
    const dz = z - exclusion.z;
    return dx * dx + dy * dy + dz * dz < exclusion.radiusMm * exclusion.radiusMm;
  });
}

/**
 * Sample support contacts across downward-facing model surface on a spacing
 * grid. Islands catch geometry that appears in mid-air; this catches connected
 * overhangs that droop or peel without intermediate support.
 */
export function sampleOverhangContacts(args: {
  mesh: THREE.Mesh;
  spacingMm: number;
  /** Faces qualify when their world normal z is at or below this (e.g. -0.7 ≈ 45° overhang). */
  maxDownNormalZ: number;
  /** Skip samples at or below this world z — plate-adhesion zone. */
  minZ: number;
  exclusions?: AutoSupportExclusion[];
  maxSamples: number;
}): AutoSupportContactCandidate[] {
  const geometry = args.mesh.geometry;
  const positions = geometry?.getAttribute?.('position');
  if (!positions) return [];

  const matrix = args.mesh.matrixWorld;
  const index = geometry.getIndex();
  const triangleCount = (index ? index.count : positions.count) / 3;
  const spacing = Math.max(0.5, args.spacingMm);
  const zBand = spacing * Z_BAND_FACTOR;

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const normal = new THREE.Vector3();

  const cells = new Map<string, { x: number; y: number; z: number; nx: number; ny: number; nz: number }>();

  for (let tri = 0; tri < triangleCount; tri++) {
    const i0 = index ? index.getX(tri * 3) : tri * 3;
    const i1 = index ? index.getX(tri * 3 + 1) : tri * 3 + 1;
    const i2 = index ? index.getX(tri * 3 + 2) : tri * 3 + 2;
    a.fromBufferAttribute(positions, i0).applyMatrix4(matrix);
    b.fromBufferAttribute(positions, i1).applyMatrix4(matrix);
    c.fromBufferAttribute(positions, i2).applyMatrix4(matrix);

    normal.copy(ab.subVectors(b, a)).cross(ac.subVectors(c, a));
    const lengthSq = normal.lengthSq();
    if (lengthSq < 1e-12) continue;
    normal.multiplyScalar(1 / Math.sqrt(lengthSq));
    if (normal.z > args.maxDownNormalZ) continue;

    const considerPoint = (px: number, py: number, pz: number) => {
      if (pz <= args.minZ) return;
      const key = `${Math.floor(px / spacing)},${Math.floor(py / spacing)},${Math.floor(pz / zBand)}`;
      const current = cells.get(key);
      if (
        !current
        || pz < current.z
        || (pz === current.z && (px < current.x || (px === current.x && py < current.y)))
      ) {
        cells.set(key, { x: px, y: py, z: pz, nx: normal.x, ny: normal.y, nz: normal.z });
      }
    };

    // Dense scan meshes have sub-spacing triangles where the centroid is
    // enough; large flat triangles (low-poly geometry) are rasterized on a
    // barycentric lattice so wide faces still get grid coverage.
    const maxEdge = Math.sqrt(Math.max(a.distanceToSquared(b), b.distanceToSquared(c), c.distanceToSquared(a)));
    const steps = Math.min(64, Math.ceil(maxEdge / spacing));
    if (steps <= 1) {
      considerPoint((a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3, (a.z + b.z + c.z) / 3);
    } else {
      for (let i = 0; i <= steps; i++) {
        for (let j = 0; j <= steps - i; j++) {
          const u = i / steps;
          const v = j / steps;
          const w = 1 - u - v;
          considerPoint(
            a.x * w + b.x * u + c.x * v,
            a.y * w + b.y * u + c.y * v,
            a.z * w + b.z * u + c.z * v,
          );
        }
      }
    }
  }

  const exclusions = args.exclusions ?? [];
  const samples = Array.from(cells.values())
    .filter((sample) => !isExcluded(sample.x, sample.y, sample.z, exclusions))
    .sort((left, right) => left.z - right.z || left.x - right.x || left.y - right.y)
    .slice(0, Math.max(0, args.maxSamples));

  return samples.map((sample, indexInList) => ({
    id: `surface:${indexInList}`,
    volumeId: SURFACE_FILL_VOLUME_ID,
    position: { x: sample.x, y: sample.y, z: sample.z },
  }));
}
