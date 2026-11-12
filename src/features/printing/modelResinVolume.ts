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
  const { promise, resolve } = Promise.withResolvers<void>();
  if (typeof window === 'undefined') {
    setTimeout(resolve, 0);
    return promise;
  }
  const idleWindow = window as Window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  };
  if (typeof idleWindow.requestIdleCallback === 'function') {
    idleWindow.requestIdleCallback(() => resolve(), { timeout: 16 });
    return promise;
  }
  setTimeout(resolve, 0);
  return promise;
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
 * The enclosed volume of one geometry in millilitres, or null when the sum is not
 * a finite number (a mesh with NaN coordinates).
 */
export async function computeModelBaseResinMl(
  position: ResinVolumePositionAttribute,
  index: ResinVolumeIndexAttribute | null,
): Promise<number | null> {
  let signedVolume = 0;

  const vax = { x: 0, y: 0, z: 0 };
  const vbx = { x: 0, y: 0, z: 0 };
  const vcx = { x: 0, y: 0, z: 0 };

  const readVertex = (i: number, out: { x: number; y: number; z: number }) => {
    out.x = position.getX(i);
    out.y = position.getY(i);
    out.z = position.getZ(i);
  };

  const addTriangle = (ia: number, ib: number, ic: number) => {
    readVertex(ia, vax);
    readVertex(ib, vbx);
    readVertex(ic, vcx);

    signedVolume += (
      vax.x * (vbx.y * vcx.z - vbx.z * vcx.y)
      - vax.y * (vbx.x * vcx.z - vbx.z * vcx.x)
      + vax.z * (vbx.x * vcx.y - vbx.y * vcx.x)
    ) / 6;
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
