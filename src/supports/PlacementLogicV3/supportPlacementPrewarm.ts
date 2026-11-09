/**
 * Warms what the first Support hover needs, without building it on that frame.
 *
 * The router's column map walks every mesh vertex and is the cold-start cost.
 * The map depends on the world pose and the shaft clearance, so it is built
 * from the loaded mesh after the model settles and installed into the pooled
 * distance field. The first hover then finds the map and only routes.
 */

import * as THREE from 'three';
import { getOrCreateSDFCache } from '../PlacementLogic/Pathfinding/SDFCachePool';
import { requestColumnClearanceMap } from '../PlacementLogic/Pathfinding/columnMapWorkerClient';
import {
    COLUMN_MAP_CELL_MM,
    prewarmSupportPlacement,
    supportColumnMapClearances,
} from './SmartPlacementV3';

/**
 * Build and install every map the active model can need.
 *
 * `isCancelled` is checked between builds: a mode switch, a model move or a new
 * geometry supersedes this warmup, and a stale map must not be installed.
 */
export async function prewarmSupportPlacementAsync(
    mesh: THREE.Mesh,
    isCancelled: () => boolean = () => false,
    options: { allClearances?: boolean } = {},
): Promise<void> {
    // A worker realm has no worker of its own; the synchronous path is the one
    // that auto-support placement uses there.
    if (typeof Worker === 'undefined') {
        if (!isCancelled()) prewarmSupportPlacement(mesh);
        return;
    }

    mesh.updateWorldMatrix(true, false);
    const geometry = mesh.geometry;
    const matrix = mesh.matrixWorld.clone();
    const position = geometry.getAttribute('position');
    const sdf = getOrCreateSDFCache(mesh);
    sdf.refreshMatrix();

    // Prepare warms only the clearance a placement can ask for right now; the
    // pinned presets' maps are a Support-mode convenience and are warmed there.
    const clearances = options.allClearances === false
        ? supportColumnMapClearances().slice(0, 1)
        : supportColumnMapClearances();
    for (const clearance of clearances) {
        if (isCancelled()) return;
        if (sdf.hasColumnMap(clearance, COLUMN_MAP_CELL_MM)) continue;
        const map = await requestColumnClearanceMap(mesh, clearance, COLUMN_MAP_CELL_MM);
        if (!map || isCancelled()) return;
        if (mesh.geometry !== geometry
            || mesh.geometry.getAttribute('position') !== position
            || !mesh.matrixWorld.equals(matrix)) {
            return;
        }
        sdf.installColumnMap(clearance, map);
    }
}
