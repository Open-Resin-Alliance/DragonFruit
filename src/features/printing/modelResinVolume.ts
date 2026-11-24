/**
 * A model's own resin: the volume enclosed by its mesh, in millilitres.
 *
 * One implementation for every reader — the app's estimate and the stats card's
 * fallback used to carry identical copies, and the slicing panel carried a third,
 * bounding-box one that reported a box where the model has a shape. The method is
 * the signed tetrahedron sum around the origin (the divergence theorem), taken on
 * the geometry's own coordinates; the model's transform scale is applied by the
 * caller (see `scaleResinMl`), because a non-uniform scale is not a volume
 * property of the geometry.
 */

import type { BufferGeometry } from 'three';

/** The position attribute a geometry exposes; a subset of THREE.BufferAttribute. */
export interface ResinVolumePositionAttribute {
  getX(i: number): number;
  getY(i: number): number;
  getZ(i: number): number;
  count: number;
  version?: number;
  data?: { version?: number };
}

/** The index attribute a geometry exposes, when it has one. */
export interface ResinVolumeIndexAttribute {
  getX(i: number): number;
  count: number;
  version?: number;
}

export interface ResinVolumeGeometryInputs {
  position: ResinVolumePositionAttribute;
  index: ResinVolumeIndexAttribute | null;
  /** Content identity of the geometry, so a cache key invalidates on edits. */
  cacheKey: string;
}

/** Triangles between yields to the main thread; keeps a big mesh from freezing it. */
const YIELD_EVERY_TRIANGLES = 4096;

/**
 * Yields to the browser before continuing. `requestIdleCallback` where it exists,
 * a macrotask otherwise, so the chunked loop below never monopolises a frame.
 */
function yieldToMainThreadIdle(): Promise<void> {
  // Not Promise.withResolvers: it needs Safari 17.4, and macOS 12 runs WebKit 15.6.
  return new Promise<void>((resolve) => {
    if (typeof window === 'undefined') {
      setTimeout(resolve, 0);
      return;
    }
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    };
    if (typeof idleWindow.requestIdleCallback === 'function') {
      idleWindow.requestIdleCallback(() => resolve(), { timeout: 16 });
      return;
    }
    setTimeout(resolve, 0);
  });
}

/**
 * The geometry-side inputs of the volume: its position and index attributes, and
 * the cache key they hash to.
 *
 * The key is built from `resinVolumeSourceKey` — the geometry of a copy shares the
 * source's key, so N copies of one mesh are measured once — plus the two
 * attributes' versions, so an edit (a cut, a smoothing pass) invalidates it.
 */
export function resinVolumeGeometryInputs(geometry: BufferGeometry): ResinVolumeGeometryInputs | null {
  const positionAttr = geometry.getAttribute('position');
  if (!positionAttr) return null;

  const sourceKey = String(geometry.userData?.resinVolumeSourceKey ?? geometry.uuid);
  geometry.userData = {
    ...geometry.userData,
    resinVolumeSourceKey: sourceKey,
  };

  const position = positionAttr as unknown as ResinVolumePositionAttribute;
  const index = (geometry.getIndex() as unknown as ResinVolumeIndexAttribute | null) ?? null;

  const positionVersion = position.version ?? position.data?.version ?? 0;
  const indexVersion = index?.version ?? 0;

  return { position, index, cacheKey: `${sourceKey}:${positionVersion}:${indexVersion}` };
}

/**
 * One triangle's contribution to the signed volume, the divergence-theorem sum
 * around the origin. Positive for outward-facing winding.
 */
function signedTetraVolume(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number {
  return (
    ax * (by * cz - bz * cy)
    - ay * (bx * cz - bz * cx)
    + az * (bx * cy - by * cx)
  ) / 6;
}

/**
 * The enclosed volume of a geometry in mm³, without yielding.
 *
 * For the small meshes the app builds itself (the raft's base, wall and line
 * beams), which are the same triangles the slicer gets. A model's own geometry
 * goes through `computeModelBaseResinMl`, which yields so an import does not
 * freeze the frame.
 */
export function geometryVolumeMm3(geometry: BufferGeometry): number {
  const position = geometry.getAttribute('position') as unknown as ResinVolumePositionAttribute | undefined;
  if (!position) return 0;
  const index = geometry.getIndex() as unknown as ResinVolumeIndexAttribute | null;

  let signedVolume = 0;

  const addTriangle = (ia: number, ib: number, ic: number) => {
    signedVolume += signedTetraVolume(
      position.getX(ia), position.getY(ia), position.getZ(ia),
      position.getX(ib), position.getY(ib), position.getZ(ib),
      position.getX(ic), position.getY(ic), position.getZ(ic),
    );
  };

  if (index) {
    for (let i = 0; i < index.count; i += 3) addTriangle(index.getX(i), index.getX(i + 1), index.getX(i + 2));
  } else {
    for (let i = 0; i < position.count; i += 3) addTriangle(i, i + 1, i + 2);
  }

  return Math.abs(signedVolume);
}

export interface Vec3Mm {
  x: number;
  y: number;
  z: number;
}

/**
 * The geometry's own volume centroid in local coordinates, or null when the mesh
 * encloses no volume (an open shell) or the sum is not finite.
 *
 * Same tetrahedron decomposition as `geometryVolumeMm3`: each triangle forms a
 * tetrahedron with the origin and its signed volume weights its own centroid, so
 * the result is independent of where the origin sits. The caller applies the
 * model's matrix (`mesh.matrixWorld`) to get the world center of mass.
 */
export function geometryCentroidMm(geometry: BufferGeometry): Vec3Mm | null {
  const position = geometry.getAttribute('position') as unknown as ResinVolumePositionAttribute | undefined;
  if (!position) return null;
  const index = geometry.getIndex() as unknown as ResinVolumeIndexAttribute | null;

  let volume = 0;
  let momentX = 0;
  let momentY = 0;
  let momentZ = 0;

  const addTriangle = (ia: number, ib: number, ic: number) => {
    const ax = position.getX(ia);
    const ay = position.getY(ia);
    const az = position.getZ(ia);
    const bx = position.getX(ib);
    const by = position.getY(ib);
    const bz = position.getZ(ib);
    const cx = position.getX(ic);
    const cy = position.getY(ic);
    const cz = position.getZ(ic);
    const signedVolume = signedTetraVolume(ax, ay, az, bx, by, bz, cx, cy, cz);
    volume += signedVolume;
    momentX += signedVolume * (ax + bx + cx) * 0.25;
    momentY += signedVolume * (ay + by + cy) * 0.25;
    momentZ += signedVolume * (az + bz + cz) * 0.25;
  };

  if (index) {
    for (let i = 0; i < index.count; i += 3) addTriangle(index.getX(i), index.getX(i + 1), index.getX(i + 2));
  } else {
    for (let i = 0; i < position.count; i += 3) addTriangle(i, i + 1, i + 2);
  }

  const scale = Math.abs(volume) > 1e-9 && Number.isFinite(volume) ? 1 / volume : 0;
  if (scale === 0) return null;
  const x = momentX * scale;
  const y = momentY * scale;
  const z = momentZ * scale;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z };
}

/**
 * The enclosed volume of one geometry in millilitres, or null when the sum is not
 * a finite number (a mesh with NaN coordinates).
 */
export async function computeModelBaseResinMl(
  position: ResinVolumePositionAttribute,
  index: ResinVolumeIndexAttribute | null,
): Promise<number | null> {
  let signedVolume = 0;

  const addTriangle = (ia: number, ib: number, ic: number) => {
    signedVolume += signedTetraVolume(
      position.getX(ia), position.getY(ia), position.getZ(ia),
      position.getX(ib), position.getY(ib), position.getZ(ib),
      position.getX(ic), position.getY(ic), position.getZ(ic),
    );
  };

  let processedTriangles = 0;

  if (index) {
    for (let i = 0; i < index.count; i += 3) {
      addTriangle(index.getX(i), index.getX(i + 1), index.getX(i + 2));
      processedTriangles += 1;
      if (processedTriangles % YIELD_EVERY_TRIANGLES === 0) {
        await yieldToMainThreadIdle();
      }
    }
  } else {
    for (let i = 0; i < position.count; i += 3) {
      addTriangle(i, i + 1, i + 2);
      processedTriangles += 1;
      if (processedTriangles % YIELD_EVERY_TRIANGLES === 0) {
        await yieldToMainThreadIdle();
      }
    }
  }

  const baseVolumeMm3 = Math.abs(signedVolume);
  return Number.isFinite(baseVolumeMm3) ? (baseVolumeMm3 / 1000) : null;
}

/**
 * The geometry's volume as the model prints it: each axis scales the volume by its
 * own factor, and the sign of a mirrored scale does not make resin negative.
 */
export function scaleResinMl(
  baseMl: number,
  scale: { x: number; y: number; z: number },
): number {
  const sx = Math.abs(scale.x || 1);
  const sy = Math.abs(scale.y || 1);
  const sz = Math.abs(scale.z || 1);
  return baseMl * sx * sy * sz;
}
