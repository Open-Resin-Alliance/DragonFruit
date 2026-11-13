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
import { getRaftStateSnapshot } from '../Rafts/Crenelated/RaftState';
import { getRegisteredMeshesForAutoBrace } from '../autoBracing/meshGeometryStore';
import { SUPPORT_TYPES, type SupportCollectionKey } from '../supportTypeRegistry';
import type { SupportState } from '../types';
import { commitAutoPlacePlan, logAutoPlaceTimings, runAutoPlace } from './autoPlace';
import * as THREE from 'three';
import { getModelMesh } from './meshStore';
import { resolvedSizingBandsForRun } from './parameterSizing';
import type { AutoSupportSettings } from './settings';
import type { AutoPlaceResult, AutoSupportPlan } from './types';
import {
    modelMeshKey,
    serializeIsland,
    serializeModelMesh,
    type AutoPlaceWorkerPayload,
    type AutoPlaceWorkerResponse,
    type AutoPlaceWorkerSiblingMesh,
    type SerializedModelMesh,
} from './autoPlace.worker.shared';

let worker: Worker | null = null;
let requestSeq = 1;
const pending = new Map<number, {
    resolve: (plan: AutoSupportPlan | null) => void;
    reject: (error: Error) => void;
    /** Cleared by the worker's ack; fires if the worker never gets that far. */
    startupTimer: ReturnType<typeof setTimeout>;
    /** Called for each progress message the run posts. */
    onProgress?: (progress: { phase: string; done: number; total: number }) => void;
}>();

/**
 * How long to wait for the worker's ack. Module evaluation is what this covers,
 * and it is quick — the mesh BVH build happens after the ack. Without it a
 * worker that dies loading its import graph (an unguarded DOM access, say)
 * leaves the caller waiting forever, which is what "Generating Supports just
 * hangs" looked like.
 */
export const AUTO_PLACE_WORKER_STARTUP_TIMEOUT_MS = 10_000;

/**
 * Per-worker-session mesh keys already delivered to the active worker, so
 * consecutive runs omit unchanged geometry arrays from `postMessage`.
 */
const confirmedMeshKeys = new Map<string, string>();
const confirmedCavityMeshKeys = new Map<string, string>();

const clearWorkerSessionCaches = (): void => {
    confirmedMeshKeys.clear();
    confirmedCavityMeshKeys.clear();
};

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
    if (worker === target) {
        worker = null;
        clearWorkerSessionCaches();
    }
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

    clearWorkerSessionCaches();
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
            if (msg.type === 'progress') {
                entry.onProgress?.(msg);
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
        clearWorkerSessionCaches();
    }

    return worker;
};

/**
 * Forget a worker that was retired after a failure, so the next run tries one
 * again. For tests, and for a caller that knows the cause is fixed.
 */
export function resetAutoPlaceWorker(): void {
    workerUnusable = false;
    clearWorkerSessionCaches();
    if (worker) dropWorker(worker);
}

/** Pose the cavity geometry exactly like the model mesh the run uses: the
 *  cavity surface is in model-local space, contacts are world-space. */
const poseCavityMesh = (
    pose: THREE.Mesh,
    cavityGeometry: THREE.BufferGeometry,
): THREE.Mesh => {
    const mesh = new THREE.Mesh(cavityGeometry);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(pose.matrixWorld);
    mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
    mesh.updateMatrixWorld(true);
    return mesh;
};

const encodeMeshForWorker = (
    targetModelId: string,
    mesh: THREE.Mesh | null | undefined,
): { mesh?: SerializedModelMesh; meshKey?: string } => {
    if (!mesh) {
        confirmedMeshKeys.delete(targetModelId);
        return {};
    }
    const meshKey = modelMeshKey(mesh);
    if (confirmedMeshKeys.get(targetModelId) === meshKey) {
        return { mesh: undefined, meshKey };
    }
    const serialized = serializeModelMesh(mesh);
    confirmedMeshKeys.set(targetModelId, meshKey);
    return { mesh: serialized, meshKey };
};

const encodeCavityForWorker = (
    targetModelId: string,
    primaryMesh: THREE.Mesh | null | undefined,
    cavityGeometry: THREE.BufferGeometry | null | undefined,
): { cavityMesh?: SerializedModelMesh; cavityMeshKey?: string | null } => {
    if (!cavityGeometry || !primaryMesh) {
        const hadConfirmed = confirmedCavityMeshKeys.delete(targetModelId);
        return hadConfirmed ? { cavityMeshKey: null } : {};
    }
    const posedCavity = poseCavityMesh(primaryMesh, cavityGeometry);
    const cavityMeshKey = modelMeshKey(posedCavity);
    if (confirmedCavityMeshKeys.get(targetModelId) === cavityMeshKey) {
        return { cavityMesh: undefined, cavityMeshKey };
    }
    const serialized = serializeModelMesh(posedCavity);
    confirmedCavityMeshKeys.set(targetModelId, cavityMeshKey);
    return { cavityMesh: serialized, cavityMeshKey };
};

const collectActiveSiblingModelIds = (
    baseState: SupportState,
    primaryModelId: string,
): string[] => {
    const siblingIds = new Set<string>();
    for (const root of Object.values(baseState.roots ?? {})) {
        if (root.modelId && root.modelId !== primaryModelId) {
            siblingIds.add(root.modelId);
        }
    }
    for (const descriptor of SUPPORT_TYPES) {
        const collection = baseState[descriptor.location.key as SupportCollectionKey] as unknown as Record<string, {
            modelId?: string;
            rootId?: string;
        }>;
        for (const entity of Object.values(collection ?? {})) {
            const entityModelId = entity.modelId
                ?? (typeof entity.rootId === 'string' ? baseState.roots?.[entity.rootId]?.modelId : undefined);
            if (entityModelId && entityModelId !== primaryModelId) {
                siblingIds.add(entityModelId);
            }
        }
    }
    for (const entity of Object.values(baseState.supports ?? {})) {
        if (entity.modelId && entity.modelId !== primaryModelId) {
            siblingIds.add(entity.modelId);
        }
    }
    for (const knot of Object.values(baseState.knots ?? {})) {
        const knotModelId = (knot as { modelId?: string }).modelId;
        if (knotModelId && knotModelId !== primaryModelId) {
            siblingIds.add(knotModelId);
        }
    }
    return [...siblingIds].sort();
};

export function buildAutoPlaceWorkerPayload(
    islands: DetectedIsland[],
    modelId: string,
    settingsOverride?: Partial<AutoSupportSettings>,
    cavityGeometry?: THREE.BufferGeometry | null,
): AutoPlaceWorkerPayload {
    const appSettings = getSettings();
    const baseState = getSnapshot();
    const raftState = getRaftStateSnapshot();
    const primaryMesh = getModelMesh(modelId);
    const encodedPrimary = encodeMeshForWorker(modelId, primaryMesh);
    const encodedCavity = encodeCavityForWorker(modelId, primaryMesh, cavityGeometry);

    const registeredAutoBraceMeshes = getRegisteredMeshesForAutoBrace();
    const siblingMeshes: AutoPlaceWorkerSiblingMesh[] = [];
    for (const sibModelId of collectActiveSiblingModelIds(baseState, modelId)) {
        const sibMesh = getModelMesh(sibModelId) ?? registeredAutoBraceMeshes.get(sibModelId) ?? null;
        if (!sibMesh) {
            confirmedMeshKeys.delete(sibModelId);
            continue;
        }
        const encodedSibling = encodeMeshForWorker(sibModelId, sibMesh);
        if (encodedSibling.meshKey) {
            siblingMeshes.push({
                modelId: sibModelId,
                meshKey: encodedSibling.meshKey,
                ...(encodedSibling.mesh ? { mesh: encodedSibling.mesh } : {}),
            });
        }
    }

    return {
        modelId,
        islands: islands.map(serializeIsland),
        settingsOverride,
        // The worker has no storage, so it cannot resolve a Support Studio preset
        // the user made: every band the run can name is resolved here, where the
        // preset table is, and handed over with the request.
        sizingBands: resolvedSizingBandsForRun(
            settingsOverride?.sizingPreset ?? appSettings.autoSupport.sizingPreset,
        ),
        appSettings,
        raftState,
        baseState,
        ...(encodedPrimary.mesh ? { mesh: encodedPrimary.mesh } : {}),
        ...(encodedPrimary.meshKey ? { meshKey: encodedPrimary.meshKey } : {}),
        ...(encodedCavity.cavityMesh ? { cavityMesh: encodedCavity.cavityMesh } : {}),
        ...(encodedCavity.cavityMeshKey !== undefined ? { cavityMeshKey: encodedCavity.cavityMeshKey } : {}),
        siblingMeshes,
    };
}

const requestPlan = (
    target: Worker,
    payload: AutoPlaceWorkerPayload,
    onProgress?: (progress: { phase: string; done: number; total: number }) => void,
): Promise<AutoSupportPlan | null> => {
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

        pending.set(requestId, { resolve, reject, startupTimer, onProgress });
        // Serialising the mesh and structured-cloning the payload happen
        // before the worker can report anything. Put the bar up now.
        onProgress?.({ phase: 'Preparing model', done: 0, total: 1 });
        try {
            target.postMessage({ type: 'run', requestId, payload });
        } catch (err) {
            clearTimeout(startupTimer);
            pending.delete(requestId);
            clearWorkerSessionCaches();
            reject(err instanceof Error ? err : new Error(String(err)));
        }
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
    onProgress?: (progress: { phase: string; done: number; total: number }) => void,
    cavityGeometry?: THREE.BufferGeometry | null,
    beforeOverride?: SupportState,
): Promise<AutoPlaceResult> {
    const target = ensureWorker();
    const cavityPose = cavityGeometry ? getModelMesh(modelId) : null;
    const cavityMesh = cavityGeometry && cavityPose
        ? poseCavityMesh(cavityPose, cavityGeometry)
        : undefined;
    if (!target) {
        // No worker in this environment (tests, plain browser), or one that has
        // already failed: the plan is still correct, it just runs on this thread.
        return runAutoPlace(islands, modelId, settingsOverride, cavityMesh, beforeOverride);
    }

    let plan: AutoSupportPlan | null;
    try {
        const payload = buildAutoPlaceWorkerPayload(
            islands,
            modelId,
            settingsOverride,
            cavityGeometry,
        );
        plan = await requestPlan(target, payload, onProgress);
    } catch (error) {
        clearWorkerSessionCaches();
        console.error(
            '[AutoSupport] worker run failed, falling back to the in-process run. ' +
            'Later runs this session go straight to in-process.',
            error,
        );
        return runAutoPlace(islands, modelId, settingsOverride, cavityMesh, beforeOverride);
    }

    // The worker's own logs do not reach `dragonfruit.log`, and the run's
    // timing breakdown is the whole point of having it: log it here, where the
    // log bridge can see it.
    logAutoPlaceTimings(plan?.analytics.timings);

    return commitAutoPlacePlan(plan, beforeOverride);
}

