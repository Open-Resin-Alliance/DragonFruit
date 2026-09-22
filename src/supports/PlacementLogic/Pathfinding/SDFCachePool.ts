/**
 * SDFCachePool — one cached distance field per mesh, shared by everything that
 * needs collision answers.
 *
 * This is infrastructure, not routing: the SDF is the oracle the routers ask
 * questions of, so it outlives any particular router. It used to live in the
 * trunk router itself, which is why `CollisionAvoidance` and the model
 * lifecycle had to reach into a pathfinder to clear a cache.
 *
 * The pool is first-caller-wins on cell size: a mesh's accuracy must not depend
 * on which subsystem happened to touch it first.
 */

import * as THREE from 'three';
import { SDFCache } from './SDFCache';

const sdfCachePool = new Map<string, SDFCache>();

/**
 * Single source of truth for the lazy SDF grid resolution. Gates whose margins
 * are finer than the cell-centre substitution error (~cellSize·√3/2) must use
 * `SDFCache.exactSignedDistanceAt` instead of relying on grid resolution; the
 * contact-cone gate does.
 */
export const SDF_DEFAULT_CELL_SIZE_MM = 0.5;

/** The cached distance field for a mesh, built on first use. */
export function getOrCreateSDFCache(mesh: THREE.Mesh): SDFCache {
    const existing = sdfCachePool.get(mesh.uuid);
    if (existing) return existing;

    const cache = new SDFCache(mesh, { cellSize: SDF_DEFAULT_CELL_SIZE_MM });
    sdfCachePool.set(mesh.uuid, cache);
    return cache;
}

/** Drop one mesh's cache (call when the mesh is removed or replaced). */
export function clearSDFCacheForMesh(meshUuid: string): void {
    const cache = sdfCachePool.get(meshUuid);
    if (cache) {
        cache.clear();
        sdfCachePool.delete(meshUuid);
    }
}

/** Drop every mesh's cache. */
export function clearAllSDFCaches(): void {
    for (const cache of sdfCachePool.values()) cache.clear();
    sdfCachePool.clear();
}
