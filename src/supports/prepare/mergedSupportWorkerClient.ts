/**
 * Main-thread client for `mergedSupport.worker.ts`.
 */

import type { ProxyModelGeometry } from '@/supports/SupportProxyMeshLayer';
import type { MergedSupportBuildData } from './mergedSupportBuild';
import type { MergedSupportBuildRequest, MergedSupportBuildResponse } from './mergedSupport.worker';

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, {
    resolve: (data: MergedSupportBuildData) => void;
    reject: (error: Error) => void;
}>();

function getWorker(): Worker | null {
    if (typeof Worker === 'undefined') return null;
    if (worker) return worker;
    try {
        worker = new Worker(new URL('./mergedSupport.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (event: MessageEvent<MergedSupportBuildResponse>) => {
            const response = event.data;
            const entry = pending.get(response.id);
            if (!entry) return;
            pending.delete(response.id);
            if (response.data) entry.resolve(response.data);
            else entry.reject(new Error(response.error ?? 'merged support build failed'));
        };
        worker.onerror = (event) => {
            const error = new Error(event.message || 'merged support worker failed');
            for (const entry of pending.values()) entry.reject(error);
            pending.clear();
        };
    } catch {
        worker = null;
    }
    return worker;
}

/** Return the merged arrays, or null when workers are unavailable. */
export function requestMergedSupportBuild(
    modelKey: string,
    generation: number,
    model: ProxyModelGeometry,
): Promise<MergedSupportBuildData> | null {
    const target = getWorker();
    if (!target) return null;

    const request: MergedSupportBuildRequest = { id: nextId++, modelKey, generation, model };
    return new Promise<MergedSupportBuildData>((resolve, reject) => {
        pending.set(request.id, { resolve, reject });
        try {
            target.postMessage(request);
        } catch (error) {
            pending.delete(request.id);
            reject(error instanceof Error ? error : new Error(String(error)));
        }
    });
}
