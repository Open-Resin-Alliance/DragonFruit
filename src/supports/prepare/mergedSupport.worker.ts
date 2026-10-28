/**
 * Builds one model's merged support arrays off the main thread.
 *
 * A merge is ~50 ms for a dense model, which is longer than a frame. The walk
 * stays on the main thread because it reads the support stores; the geometry
 * packing, which is the expensive part, runs here.
 */

import type { ProxyModelGeometry } from '@/supports/SupportProxyMeshLayer';
import { buildMergedSupportData, type MergedSupportBuildData } from './mergedSupportBuild';

export interface MergedSupportBuildRequest {
    id: number;
    modelKey: string;
    generation: number;
    model: ProxyModelGeometry;
}

export type MergedSupportBuildResponse =
    | { id: number; modelKey: string; generation: number; data: MergedSupportBuildData }
    | { id: number; modelKey: string; generation: number; data: null; error?: string };

const scope = self as unknown as {
    onmessage: ((event: MessageEvent<MergedSupportBuildRequest>) => void) | null;
    postMessage: (message: MergedSupportBuildResponse, transfer?: Transferable[]) => void;
};

scope.onmessage = (event) => {
    const request = event.data;
    try {
        const data = buildMergedSupportData(request.model);
        scope.postMessage(
            { id: request.id, modelKey: request.modelKey, generation: request.generation, data },
            [data.positions.buffer, data.normals.buffer, data.indices.buffer],
        );
    } catch (error) {
        scope.postMessage({
            id: request.id,
            modelKey: request.modelKey,
            generation: request.generation,
            data: null,
            error: String(error),
        });
    }
};
