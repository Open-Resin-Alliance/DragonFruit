/**
 * The app's voxel island detector, run in this process.
 *
 * `detectVoxelIslands` fans a per-layer loop out over module workers so a scan
 * does not block the thread that paints. A harness has no browser, so this
 * installs a `Worker` stand-in that evaluates the *same* worker file in-thread:
 * message in, handler, message back, with the ordering a real worker guarantees
 * (the worker script runs before any message arrives, and `self` exists while it
 * runs).
 *
 * The other two island families the app runs, `scan_mesh_minima` and
 * `scan_overhangs`, are Tauri commands over the Rust scanners. A Node host
 * cannot call them, so a model measured through this module carries voxel
 * islands only, and the harness says so in its output.
 *
 * Resolution defaults follow the app's island panel: `pxMm` 0.1 and the print's
 * own layer height. Detection at those settings costs seconds per model; raise
 * `pxMm` or `layerHeightMm` when measuring a large part.
 */

import type { BufferGeometry } from 'three';
import { detectVoxelIslands } from '../src/volumeAnalysis/Islands/detect';
import type { DetectedIsland } from '../src/volumeAnalysis/Islands/types';

export interface DetectOptions {
    pxMm: number;
    layerHeightMm: number;
    supportBufferMm: number;
    minAreaMm2: number;
    connectivity: 4 | 8;
}

/** What the app's Islands panel starts from. */
export const DEFAULT_DETECT_OPTIONS: DetectOptions = {
    pxMm: 0.1,
    layerHeightMm: 0.05,
    supportBufferMm: 0.6,
    minAreaMm2: 0.02,
    connectivity: 4,
};

interface WorkerShim {
    postMessage: (message: unknown) => void;
    addEventListener: (type: string, listener: (event: { data: unknown }) => void) => void;
    removeEventListener: (type: string, listener: (event: { data: unknown }) => void) => void;
    terminate: () => void;
}

/**
 * The stand-in worker. Delivery is synchronous, so the reply goes to the shim
 * whose message is being handled: the worker file calls `self.postMessage`, and
 * that is pointed at the calling shim for the duration of its own handler.
 */
function createWorkerShim(): WorkerShim {
    const listeners = new Set<(event: { data: unknown }) => void>();
    return {
        postMessage: (message: unknown) => {
            const globals = globalThis as unknown as {
                onmessage?: (event: { data: unknown }) => void;
                postMessage?: (data: unknown) => void;
            };
            if (!globals.onmessage) {
                throw new Error('the scanline worker module is not loaded; await installInProcessWorkers() first');
            }
            globals.postMessage = (data: unknown) => {
                for (const listener of listeners) listener({ data });
            };
            globals.onmessage({ data: message });
        },
        addEventListener: (type, listener) => {
            if (type === 'message') listeners.add(listener);
        },
        removeEventListener: (type, listener) => {
            if (type === 'message') listeners.delete(listener);
        },
        terminate: () => listeners.clear(),
    };
}

let installed: Promise<void> | null = null;

/**
 * Points the detector's worker call at an in-thread stand-in, once per process.
 * Awaited before any scan: the worker file assigns `self.onmessage`, and a real
 * worker receives nothing until its script has run.
 */
export async function installInProcessWorkers(): Promise<void> {
    installed ??= (async () => {
        const globals = globalThis as unknown as { self?: unknown; Worker?: unknown };
        globals.self = globalThis;
        // Dynamic on purpose: this module has to be evaluated *after* `self`
        // exists, which a hoisted static import would not allow. It assigns
        // `self.onmessage`, so evaluating it early is the whole failure mode.
        await import('../src/volumeAnalysis/IslandScan/scanlineScan.worker');
        globals.Worker = function InProcessWorker() {
            return createWorkerShim();
        };
    })();
    return installed;
}

/** Islands this mesh presents, from the app's own slice-growth detector. */
export async function detectIslands(
    geometry: BufferGeometry,
    options: DetectOptions = DEFAULT_DETECT_OPTIONS,
): Promise<DetectedIsland[]> {
    await installInProcessWorkers();
    geometry.computeBoundingBox();
    const positions = geometry.getAttribute('position').array;
    return detectVoxelIslands(
        {
            positions: positions instanceof Float32Array ? positions : new Float32Array(Array.from(positions)),
            bbox: geometry.boundingBox!.clone(),
        },
        options.layerHeightMm,
        {
            pxMm: options.pxMm,
            supportBufferMm: options.supportBufferMm,
            connectivity: options.connectivity,
            minAreaMm2: options.minAreaMm2,
        },
    );
}
