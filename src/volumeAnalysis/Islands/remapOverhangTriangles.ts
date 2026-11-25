import * as THREE from 'three';
import type { OverhangRegion } from './types';

export interface IslandTransform {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
}

const CELL_MM = 0.01;
const cellKey = (x: number, y: number, z: number): string => (
  `${Math.round(x / CELL_MM)},${Math.round(y / CELL_MM)},${Math.round(z / CELL_MM)}`
);

/**
 * Remap scan triangle ids onto the rendered geometry by triangle centroid.
 *
 * The native scan is supposed to see the rendered triangle order, but a loader
 * that re-indexes or reorders its mesh (LYS in particular) can hand the overlay
 * ids that point at a different triangle. Centroids are invariant to that
 * ordering; this builds the rendered centroid map once and rewrites each
 * region's ids when every scanned centroid resolves. Unresolved regions keep
 * their ids rather than silently shading nothing.
 */
export function remapOverhangTriangleIds(
  regions: readonly OverhangRegion[],
  geometry: THREE.BufferGeometry | null | undefined,
  transform: IslandTransform,
): OverhangRegion[] {
  if (!geometry || regions.length === 0) return [...regions];
  const position = geometry.getAttribute('position');
  if (!position) return [...regions];
  const index = geometry.index;
  const triCount = index ? index.count / 3 : position.count / 3;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const center = geometry.boundingBox?.getCenter(new THREE.Vector3()) ?? new THREE.Vector3();
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(transform.position.x, transform.position.y, transform.position.z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(transform.rotation.x, transform.rotation.y, transform.rotation.z)),
    new THREE.Vector3(transform.scale.x, transform.scale.y, transform.scale.z),
  );
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const byCentroid = new Map<string, number[]>();
  for (let ti = 0; ti < triCount; ti++) {
    const i0 = index ? index.getX(ti * 3) : ti * 3;
    const i1 = index ? index.getX(ti * 3 + 1) : ti * 3 + 1;
    const i2 = index ? index.getX(ti * 3 + 2) : ti * 3 + 2;
    a.fromBufferAttribute(position, i0).sub(center).applyMatrix4(matrix);
    b.fromBufferAttribute(position, i1).sub(center).applyMatrix4(matrix);
    c.fromBufferAttribute(position, i2).sub(center).applyMatrix4(matrix);
    const key = cellKey((a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3, (a.z + b.z + c.z) / 3);
    const bucket = byCentroid.get(key);
    if (bucket) bucket.push(ti);
    else byCentroid.set(key, [ti]);
  }

  const find = (centroid: [number, number, number]): number | null => {
    const cx = centroid[0] / CELL_MM;
    const cy = centroid[1] / CELL_MM;
    const cz = centroid[2] / CELL_MM;
    const baseX = Math.round(cx);
    const baseY = Math.round(cy);
    const baseZ = Math.round(cz);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = byCentroid.get(`${baseX + dx},${baseY + dy},${baseZ + dz}`);
          if (bucket && bucket.length > 0) return bucket[0];
        }
      }
    }
    return null;
  };

  return regions.map((region) => {
    const centroids = region.triangleCentroids;
    if (!centroids || centroids.length === 0 || centroids.length !== region.triangleIds.length) {
      return region;
    }
    const remapped: number[] = [];
    let resolved = 0;
    for (const centroid of centroids) {
      const mapped = find(centroid);
      if (mapped === null) continue;
      resolved++;
      if (!remapped.includes(mapped)) remapped.push(mapped);
    }
    if (remapped.length === 0) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn(
          `[IslandsPerf] overhang remap failed for ${region.triangleIds.length} triangle(s) `
          + `on geometry ${geometry.uuid}; overlay will be hidden rather than drawn on wrong faces`,
        );
      }
      return { ...region, triangleIds: [] };
    }
    if (resolved < centroids.length && process.env.NODE_ENV !== 'production') {
      console.warn(
        `[IslandsPerf] overhang remap resolved ${resolved}/${centroids.length} triangle(s) `
        + `on geometry ${geometry.uuid}`,
      );
    }
    return { ...region, triangleIds: remapped };
  });
}
