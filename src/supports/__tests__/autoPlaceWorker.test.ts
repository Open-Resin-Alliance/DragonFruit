import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { footprintFromPoints } from '@/volumeAnalysis/Islands/voxelFootprint';
import { initializeBVH, accelerateGeometry } from '@/utils/bvh';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';
import type { AutoSupportSettings } from '../autoSupport/settings';
import { getSettings, setSettings } from '../Settings/state';
import { createDefaultSettings } from '../Settings/types';
import { clearHistory } from '../../history/historyStore';
import { getSnapshot, resetKickstandsInState, resetStore } from '../state';
import { registerSupportHistoryHandlers } from '../history/useSupportHistoryHandlers';
import { computeAutoSupportPlan, runAutoPlace } from '../autoSupport/autoPlace';
import { setModelMesh } from '../autoSupport/meshStore';
import {
    modelMeshKey,
    runAutoPlaceRequest,
    serializeIsland,
    serializeModelMesh,
    type AutoPlaceWorkerPayload,
} from '../autoSupport/autoPlace.worker.shared';
import {
    AUTO_PLACE_WORKER_STARTUP_TIMEOUT_MS,
    resetAutoPlaceWorker,
    runAutoPlaceInWorker,
} from '../autoSupport/autoPlaceWorkerClient';

/**
 * The worker runs the same plan as the main thread only because every piece of
 * module state the plan reads is seeded from the payload first: the settings
 * store, the support snapshot and the model mesh (which also feeds the brace
 * clearance check). These tests pin that equality, so a future store read
 * inside the plan cannot silently make the two threads disagree.
 */

const MODEL = 'model-a';

/**
 * Two runs never share ids: roots and some trunks are minted with `uuidv4()`.
 * Compare the placement, not the identity, by collapsing every UUID to one
 * token before stringifying.
 */
const shape = (value: unknown): string =>
    JSON.stringify(value).replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
        'U',
    );

/** A 20 mm box rotated 30° about X, with the rotated underside as an island. */
function rotatedUnderside(): { mesh: THREE.Mesh; island: DetectedIsland } {
    initializeBVH();
    const geometry = new THREE.BoxGeometry(20, 20, 20);
    geometry.rotateX(THREE.MathUtils.degToRad(30));
    geometry.translate(0, 0, 20);
    accelerateGeometry(geometry);
    const mesh = new THREE.Mesh(geometry);
    mesh.updateMatrixWorld(true);

    const voxels: { x: number; y: number; z?: number }[] = [];
    for (let x = -10; x <= 10; x += 0.25) {
        for (let y = -3.66; y <= 13.66; y += 0.25) {
            voxels.push({ x, y, z: 0.577 * y + 8.45 });
        }
    }
    const island: DetectedIsland = {
        id: 'o0',
        source: 'overhang',
        contact: new THREE.Vector3(0, 5, 11.33),
        baseZ: 6.34,
        areaMm2: 400 * (Math.sqrt(3) / 2),
        surfaceNormal: { x: 0, y: 0.5, z: -Math.sqrt(3) / 2 },
        overhangAngleDeg: 30,
        triangleIds: [10, 11],
        contactVoxels: footprintFromPoints(voxels),
    };
    return { mesh, island };
}

function withStore<T>(mesh: THREE.Mesh | null, body: () => T): T {
    resetStore();
    resetKickstandsInState();
    clearHistory();
    const dispose = registerSupportHistoryHandlers();
    initializeBVH();
    const previous = getSettings();
    setSettings(createDefaultSettings());
    setModelMesh(MODEL, mesh);
    try {
        return body();
    } finally {
        setModelMesh(MODEL, null);
        setSettings(previous);
        dispose();
    }
}

/** Capture console.error output (the fallback and the worker error both land there). */
function captureConsoleError(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
        lines.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : String(a))).join(' '));
    };
    return { lines, restore: () => { console.error = original; } };
}

/** Install a stub `Worker`; returns the stub and a restore function. */
type WorkerStub = {
    postMessage: (message: { requestId: number }) => void;
    terminate: () => void;
    onmessage: ((event: { data: unknown }) => void) | null;
    onerror: unknown;
};

function stubWorker(behaviour: { postMessage: (message: { requestId: number }) => void }): { stub: WorkerStub; restore: () => void } {
    const globals = globalThis as { Worker?: unknown };
    const original = globals.Worker;
    const stub: WorkerStub = {
        postMessage: behaviour.postMessage,
        terminate: () => { /* nothing to stop */ },
        onmessage: null,
        onerror: null,
    };
    globals.Worker = function WorkerStub() { return stub; };
    return { stub, restore: () => { globals.Worker = original; } };
}

/** What the client would put on the wire for this run. */
function payloadFor(
    island: DetectedIsland,
    mesh: THREE.Mesh,
    settingsOverride: Partial<AutoSupportSettings> = { debugSkipAutoBracing: true, stabilizationEnabled: false },
): AutoPlaceWorkerPayload {
    return {
        modelId: MODEL,
        islands: [serializeIsland(island)],
        settingsOverride,
        appSettings: getSettings(),
        baseState: getSnapshot(),
        mesh: serializeModelMesh(mesh),
        meshKey: modelMeshKey(mesh),
    };
}

test('the worker produces the same plan as an in-process run', () => {
    const { mesh, island } = rotatedUnderside();

    const inProcess = withStore(mesh, () =>
        computeAutoSupportPlan([island], MODEL, { debugSkipAutoBracing: true, stabilizationEnabled: false }, undefined, mesh));

    const inWorker = withStore(null, () =>
        runAutoPlaceRequest(structuredClone(payloadFor(island, mesh))));

    assert.ok(inProcess, 'in-process plan computed');
    assert.ok(inWorker, 'worker plan computed');
    assert.equal(inWorker.result.changed, inProcess.result.changed);
    assert.deepEqual(inWorker.result.placed, inProcess.result.placed, 'per-type counts match');
    assert.deepEqual(inWorker.result.rejectedCandidates, inProcess.result.rejectedCandidates);
    assert.equal(shape(inWorker.support), shape(inProcess.support), 'the committed support state is identical');
    assert.equal(shape(inWorker.analytics), shape(inProcess.analytics), 'analytics match, coverage included');
});

test('the worker plan survives the wire: cloned payload, plain-object islands', () => {
    const { mesh, island } = rotatedUnderside();
    const payload = structuredClone(payloadFor(island, mesh));

    // structuredClone drops prototypes: the island contact arrives as a plain
    // point and the footprint as plain typed arrays. Assert that, so the test
    // fails loudly if the plan ever starts calling methods on them.
    assert.equal(payload.islands[0].contact instanceof THREE.Vector3, false, 'contact is a plain point');
    assert.ok(payload.islands[0].contactVoxels?.xy instanceof Float32Array, 'footprint arrays survive');
    assert.equal(typeof payload.islands[0].contact.x, 'number');

    const plan = withStore(null, () => runAutoPlaceRequest(payload));
    assert.ok(plan, 'plan computed from a cloned payload');
    assert.ok(Object.keys(plan.support.trunks).length > 0, 'supports were placed');
});

/**
 * The two worker realms. A worker built by the dev server gets a `window` whose
 * property access throws (a trap for DOM use in a worker); a plain worker, and
 * production, have no `window` at all. The trap is the dangerous one, because
 * `typeof window !== 'undefined'` is TRUE there.
 */
function withWorkerRealm<T>(kind: 'absent' | 'trapping', body: () => T): T {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const restore = () => {
        if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
        else delete (globalThis as { window?: unknown }).window;
    };

    if (kind === 'absent') {
        delete (globalThis as { window?: unknown }).window;
    } else {
        const trap = () => {
            throw new ReferenceError('window is not defined');
        };
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: new Proxy({}, { get: trap, set: trap, has: trap }),
        });
    }

    try {
        return body();
    } finally {
        restore();
    }
}

for (const realm of ['absent', 'trapping'] as const) {
    test(`the worker plan survives a worker realm (${realm} window)`, () => {
        const { mesh, island } = rotatedUnderside();
        // Bracing on: it is the phase that pulled in the store setter whose
        // interaction reset read `window`.
        const override = { stabilizationEnabled: false };

        const inRealm = withStore(mesh, () =>
            withWorkerRealm(realm, () => runAutoPlaceRequest(payloadFor(island, mesh, override))));
        const normally = withStore(mesh, () => runAutoPlaceRequest(payloadFor(island, mesh, override)));

        assert.ok(inRealm, `plan computed with a ${realm} window`);
        assert.ok(normally, 'plan computed normally');
        assert.ok(Object.keys(inRealm.support.braces).length > 0, 'the bracing phase ran');
        assert.equal(
            shape(inRealm.support),
            shape(normally.support),
            'the realm changes nothing about the placement',
        );
    });
}

test('a worker that never starts falls back to the in-process run', async (t) => {
    // A worker whose import graph throws while evaluating never registers
    // `onmessage`: it accepts the request and answers nothing. The run must
    // still produce supports, on this thread, and say so.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { mesh, island } = rotatedUnderside();
    const logs = captureConsoleError();
    const { restore: restoreWorker } = stubWorker({
        postMessage: () => { /* never answers */ },
    });

    try {
        resetStore();
        resetKickstandsInState();
        clearHistory();
        const dispose = registerSupportHistoryHandlers();
        initializeBVH();
        setModelMesh(MODEL, mesh);

        const pending = runAutoPlaceInWorker([island], MODEL, {
            debugSkipAutoBracing: true,
            stabilizationEnabled: false,
        });
        t.mock.timers.tick(AUTO_PLACE_WORKER_STARTUP_TIMEOUT_MS);
        const result = await pending;

        assert.ok(result.placed.trunk > 0, 'the in-process run placed supports');
        assert.ok(
            logs.lines.some((line) => line.includes('falling back')),
            'the fallback is logged, not silent',
        );

        setModelMesh(MODEL, null);
        dispose();
    } finally {
        logs.restore();
        restoreWorker();
        // The client retires a failed worker for the session; the next test
        // needs it back.
        resetAutoPlaceWorker();
        t.mock.timers.reset();
    }
});

test('a worker error falls back and surfaces the worker stack', async (t) => {
    // The shape of a run that dies inside the worker: it acks, then reports an
    // error. The stack is what names the module, so it has to reach the log.
    const { mesh, island } = rotatedUnderside();
    const logs = captureConsoleError();
    // The stub answers the way a worker that dies inside the run does: an error
    // message carrying the worker's own stack.
    const { stub, restore: restoreWorker } = stubWorker({
        postMessage: (message: { requestId: number }) => {
            queueMicrotask(() => {
                stub.onmessage?.({
                    data: {
                        type: 'error',
                        requestId: message.requestId,
                        error: 'window is not defined',
                        stack: 'ReferenceError: window is not defined\n    at someModule (src/some/module.ts:12:3)',
                    },
                });
            });
        },
    });

    try {
        resetStore();
        resetKickstandsInState();
        clearHistory();
        const dispose = registerSupportHistoryHandlers();
        initializeBVH();
        setModelMesh(MODEL, mesh);

        const result = await runAutoPlaceInWorker([island], MODEL, {
            debugSkipAutoBracing: true,
            stabilizationEnabled: false,
        });

        assert.ok(result.placed.trunk > 0, 'the in-process run placed supports');
        const logged = logs.lines.join('\n');
        assert.ok(logged.includes('window is not defined'), 'the worker error is logged');
        assert.ok(logged.includes('someModule'), 'the worker stack is logged');

        setModelMesh(MODEL, null);
        dispose();
    } finally {
        logs.restore();
        restoreWorker();
        resetAutoPlaceWorker();
    }
});

test('the worker path commits what the in-process path commits', async () => {
    const { mesh, island } = rotatedUnderside();

    const direct = withStore(mesh, () => runAutoPlace([island], MODEL, {
        debugSkipAutoBracing: true,
        stabilizationEnabled: false,
    }));
    const committedDirect = shape(getSnapshot());

    // No `Worker` in this process, so this exercises the client's fallback and
    // its commit; the worker body itself is covered above.
    const viaClient = await withStore(mesh, () => runAutoPlaceInWorker([island], MODEL, {
        debugSkipAutoBracing: true,
        stabilizationEnabled: false,
    }));

    assert.deepEqual(viaClient.placed, direct.placed, 'same placement counts');
    assert.equal(shape(getSnapshot()), committedDirect, 'same committed state');
});
