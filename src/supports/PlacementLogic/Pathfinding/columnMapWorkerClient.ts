/**
 * Main-thread client for `columnClearance.worker.ts`.
 *
 * Requests are deduplicated by mesh, geometry, pose and clearance, so a React
 * effect that reschedules the same warmup does not queue the same build twice.
 */

import * as THREE from 'three';
import { ColumnClearanceMap } from './ColumnClearanceMap';
import type { ColumnClearanceRequest, ColumnClearanceResponse } from './columnClearanceBuild';

interface PendingBuild {
    resolve: (map: ColumnClearanceMap | null) => void;
    reject: (error: Error) => void;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, PendingBuild>();
const inFlight = new Map<string, Promise<ColumnClearanceMap | null>>();
/** The pose whose positions the worker holds; it keeps one at a time. */
let lastSentPose: string | null = null;

function getWorker(): Worker | null {
    if (typeof Worker === 'undefined') return null;
    if (worker) return worker;
    try {
        worker = new Worker(new URL('./columnClearance.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (event: MessageEvent<ColumnClearanceResponse>) => {
            const response = event.data;
            const entry = pending.get(response.id);
            if (!entry) return;
            pending.delete(response.id);
            if (response.snapshot) {
                entry.resolve(ColumnClearanceMap.fromSnapshot(response.snapshot));
            } else {
                if (response.error) console.warn('[columnMapWorker] build failed', response.error);
                entry.resolve(null);
            }
        };
        worker.onerror = (event) => {
            const error = new Error(event.message || 'column map worker failed');
            for (const entry of pending.values()) entry.reject(error);
            pending.clear();
            lastSentPose = null;
        };
    } catch {
        worker = null;
    }
    return worker;
}

function poseKey(mesh: THREE.Mesh): string {
    const attribute = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    const version = attribute && 'version' in attribute ? attribute.version : 0;
    return `${mesh.uuid}|${mesh.geometry.uuid}|${version}|${mesh.matrixWorld.elements.join(',')}`;
}

function requestKey(mesh: THREE.Mesh, clearanceMm: number, cellMm: number): string {
    return `${poseKey(mesh)}|${clearanceMm}|${cellMm}`;
}

/**
 * Ask the worker for one map. Resolves null when workers are unavailable or the
 * build fails; the caller keeps the synchronous path as its fallback.
 */
export function requestColumnClearanceMap(
    mesh: THREE.Mesh,
    clearanceMm: number,
    cellMm: number,
): Promise<ColumnClearanceMap | null> {
    const key = requestKey(mesh, clearanceMm, cellMm);
    const existing = inFlight.get(key);
    if (existing) return existing;

    const target = getWorker();
    if (!target) return Promise.resolve(null);

    const pose = poseKey(mesh);
    const sendPositions = lastSentPose !== pose;
    const attribute = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    let positions: Float32Array | undefined;
    if (sendPositions) {
        const array = attribute.array;
        positions = array instanceof Float32Array
            ? array.slice()
            : Float32Array.from(array as ArrayLike<number>);
    }
    const request: ColumnClearanceRequest = {
        id: nextId++,
        poseKey: pose,
        positions,
        matrix: Array.from(mesh.matrixWorld.elements),
        clearanceMm,
        cellMm,
    };

    const promise = new Promise<ColumnClearanceMap | null>((resolve, reject) => {
        pending.set(request.id, { resolve, reject });
        try {
            if (positions) {
                target.postMessage(request, [positions.buffer]);
                lastSentPose = pose;
            } else {
                target.postMessage(request);
            }
        } catch (error) {
            pending.delete(request.id);
            reject(error instanceof Error ? error : new Error(String(error)));
        }
    }).catch(() => null).finally(() => {
        inFlight.delete(key);
    });

    inFlight.set(key, promise);
    return promise;
}

/** Forget the worker and every request it has not answered. */
export function disposeColumnMapWorker(): void {
    for (const entry of pending.values()) entry.resolve(null);
    pending.clear();
    inFlight.clear();
    lastSentPose = null;
    worker?.terminate();
    worker = null;
}
