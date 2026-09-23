/**
 * Auto-support worker client.
 *
 * The placement run is seconds of synchronous work on a model that needs a few
 * hundred supports, which is why the UI used to lock up while it ran. This
 * runs the same plan on a worker thread and commits the result here, so the
 * main thread only pays the serialization and the single store write.
 *
 * Falls back to the in-process run when `Worker` is unavailable (tests, plain
 * browser), so callers never have to know which path they got.
 */

import type { DetectedIsland } from '@/volumeAnalysis/Islands/types';
import { getSettings } from '../Settings/state';
import { getSnapshot } from '../state';
import { commitAutoPlacePlan, runAutoPlace } from './autoPlace';
import { getModelMesh } from './meshStore';
import type { AutoSupportSettings } from './settings';
import type { AutoPlaceResult, AutoSupportPlan } from './types';
import {
    modelMeshKey,
    serializeIsland,
    serializeModelMesh,
    type AutoPlaceWorkerPayload,
    type AutoPlaceWorkerResponse,
    type SerializedModelMesh,
} from './autoPlace.worker.shared';

let worker: Worker | null = null;
let requestSeq = 1;
const pending = new Map<number, {
    resolve: (plan: AutoSupportPlan | null) => void;
    reject: (error: Error) => void;
    /** Cleared by the worker's ack; fires if the worker never gets that far. */
    startupTimer: ReturnType<typeof setTimeout>;
}>();

/**
 * How long to wait for the worker's ack. Module evaluation is what this covers,
 * and it is quick — the mesh BVH build happens after the ack. Without it a
 * worker that dies loading its import graph (an unguarded DOM access, say)
 * leaves the caller waiting forever, which is what "Generating Supports just
 * hangs" looked like.
 */
export const AUTO_PLACE_WORKER_STARTUP_TIMEOUT_MS = 10_000;

/** Last mesh sent, so a repeat run does not re-copy megabytes of geometry. */
let meshCache: { key: string; mesh: SerializedModelMesh } | null = null;

/**
 * Set once the worker has failed in a way that is not about the plan itself
 * (it never started, or it died mid-run). Everything after that runs
 * in-process: a run that blocks the UI beats a run that does nothing, and the
 * failure is logged loudly rather than silently retried on every Generate.
 */
let workerUnusable = false;

const dropWorker = (target: Worker) => {
    try {
        target.terminate();
    } catch {
        // Already gone.
    }
    if (worker === target) worker = null;
};

const failAll = (error: Error) => {
    for (const entry of pending.values()) {
        clearTimeout(entry.startupTimer);
        entry.reject(error);
    }
    pending.clear();
};

const ensureWorker = (): Worker | null => {
    if (typeof Worker === 'undefined' || workerUnusable) return null;
    if (worker) return worker;

    try {
        const target = new Worker(new URL('./autoPlace.worker.ts', import.meta.url), { type: 'module' });
        target.onmessage = (event: MessageEvent<AutoPlaceWorkerResponse>) => {
            const msg = event.data;
            const entry = msg ? pending.get(msg.requestId) : undefined;
            if (!msg || !entry) return;
            if (msg.type === 'started') {
                clearTimeout(entry.startupTimer);
                return;
            }
            pending.delete(msg.requestId);
            clearTimeout(entry.startupTimer);
            if (msg.type === 'error') {
                const error = new Error(msg.error);
                // The worker's own stack, not this one: it names the module that
                // failed inside the run.
                if (msg.stack) error.stack = `${msg.error}\n  --- from the worker ---\n${msg.stack}`;
                entry.reject(error);
            } else {
                entry.resolve(msg.plan);
            }
        };
        target.onerror = (event) => {
            console.error('[AutoSupport] worker failed:', event.message);
            workerUnusable = true;
            failAll(new Error(event.message || 'auto-support worker failed'));
            dropWorker(target);
        };
        worker = target;
    } catch (error) {
        console.warn('[AutoSupport] worker unavailable, running in-process:', error);
        worker = null;
    }

    return worker;
};

/**
 * Forget a worker that was retired after a failure, so the next run tries one
 * again. For tests, and for a caller that knows the cause is fixed.
 */
export function resetAutoPlaceWorker(): void {
    workerUnusable = false;
    if (worker) dropWorker(worker);
}

const serializeMeshForModel = (modelId: string): { mesh?: SerializedModelMesh; meshKey?: string } => {
    const mesh = getModelMesh(modelId);
    if (!mesh) return {};

    const key = modelMeshKey(mesh);
    if (meshCache?.key === key) return { mesh: meshCache.mesh, meshKey: key };

    const serialized = serializeModelMesh(mesh);
    meshCache = { key, mesh: serialized };
    return { mesh: serialized, meshKey: key };
};

const requestPlan = (target: Worker, payload: AutoPlaceWorkerPayload): Promise<AutoSupportPlan | null> => {
    const requestId = requestSeq++;
    return new Promise((resolve, reject) => {
        const startupTimer = setTimeout(() => {
            pending.delete(requestId);
            workerUnusable = true;
            dropWorker(target);
            reject(new Error(
                'auto-support worker did not start. It failed while loading its module graph — ' +
                'check the console for the module error (a DOM access at module scope will do it). ' +
                'Run auto-supports again to retry.',
            ));
        }, AUTO_PLACE_WORKER_STARTUP_TIMEOUT_MS);

        pending.set(requestId, { resolve, reject, startupTimer });
        target.postMessage({ type: 'run', requestId, payload });
    });
};

/**
 * Run auto-placement on the worker and commit the plan. Same result and same
 * history entry as `runAutoPlace`, without blocking the main thread.
 *
 * A worker failure falls back to the in-process run rather than leaving the
 * caller with nothing: the worker is an optimisation, and a run that blocks the
 * UI for a while beats a run that does nothing. The fallback is loud and
 * one-way (the worker stays retired for the session), so a broken worker cannot
 * quietly become the normal path.
 */
export async function runAutoPlaceInWorker(
    islands: DetectedIsland[],
    modelId: string,
    settingsOverride?: Partial<AutoSupportSettings>,
): Promise<AutoPlaceResult> {
    const target = ensureWorker();
    if (!target) {
        // No worker in this environment (tests, plain browser), or one that has
        // already failed: the plan is still correct, it just runs on this thread.
        return runAutoPlace(islands, modelId, settingsOverride);
    }

    let plan: AutoSupportPlan | null;
    try {
        plan = await requestPlan(target, {
            modelId,
            islands: islands.map(serializeIsland),
            settingsOverride,
            appSettings: getSettings(),
            baseState: getSnapshot(),
            ...serializeMeshForModel(modelId),
        });
    } catch (error) {
        console.error(
            '[AutoSupport] worker run failed, falling back to the in-process run. ' +
            'Later runs this session go straight to in-process.',
            error,
        );
        return runAutoPlace(islands, modelId, settingsOverride);
    }

    return commitAutoPlacePlan(plan);
}
