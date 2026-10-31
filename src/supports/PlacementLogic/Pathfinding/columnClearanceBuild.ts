/**
 * The column-map build that runs inside the worker, kept separate from the
 * worker shell so it can be tested without a browser worker.
 */

import * as THREE from 'three';
import { ColumnClearanceMap, type ColumnClearanceMapSnapshot } from './ColumnClearanceMap';

export interface ColumnClearanceRequest {
    id: number;
    /** Pose identity the worker caches the position array under. */
    poseKey: string;
    /** Sent only on the first request for a pose; later requests reuse it. */
    positions?: Float32Array;
    matrix: number[];
    clearanceMm: number;
    cellMm: number;
}

/** The request with its position array resolved, as the builder needs it. */
export type ResolvedColumnClearanceRequest = ColumnClearanceRequest & { positions: Float32Array };

export type ColumnClearanceResponse =
    | { id: number; snapshot: ColumnClearanceMapSnapshot }
    | { id: number; snapshot: null; error?: string };

export function buildColumnClearanceSnapshot(request: ResolvedColumnClearanceRequest): ColumnClearanceMapSnapshot | null {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(request.positions, 3));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.matrixWorld.fromArray(request.matrix);
    const map = ColumnClearanceMap.build(mesh, request.clearanceMm, request.cellMm);
    return map ? map.snapshot() : null;
}
