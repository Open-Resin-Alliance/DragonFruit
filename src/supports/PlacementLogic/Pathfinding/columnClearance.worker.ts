/**
 * Worker shell for `buildColumnClearanceSnapshot`. The build walks every mesh
 * vertex and is measured in tens to hundreds of milliseconds on a detailed
 * part; it must not run on the frame that needs the map.
 */

import type { ColumnClearanceRequest, ColumnClearanceResponse } from './columnClearanceBuild';
import { buildColumnClearanceSnapshot } from './columnClearanceBuild';

const scope = self as unknown as {
    onmessage: ((event: MessageEvent<ColumnClearanceRequest>) => void) | null;
    postMessage: (message: ColumnClearanceResponse, transfer?: Transferable[]) => void;
};

/**
 * The active pose's position array. The client sends it once per pose and then
 * asks for each clearance by key, so a preset warmup does not copy the mesh
 * seven times.
 */
let cachedPoseKey: string | null = null;
let cachedPositions: Float32Array | null = null;

scope.onmessage = (event) => {
    const request = event.data;
    try {
        if (request.positions) {
            cachedPoseKey = request.poseKey;
            cachedPositions = request.positions;
        }
        if (cachedPoseKey !== request.poseKey || !cachedPositions) {
            scope.postMessage({ id: request.id, snapshot: null, error: 'missing positions for pose' });
            return;
        }
        const snapshot = buildColumnClearanceSnapshot({
            ...request,
            positions: cachedPositions,
        });
        if (!snapshot) {
            scope.postMessage({ id: request.id, snapshot: null });
            return;
        }
        scope.postMessage({ id: request.id, snapshot }, [snapshot.lowestZ.buffer]);
    } catch (error) {
        scope.postMessage({ id: request.id, snapshot: null, error: String(error) });
    }
};
