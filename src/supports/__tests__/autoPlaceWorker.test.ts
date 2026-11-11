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
import { getSnapshot, resetKickstandsInState, resetStore, setSnapshot } from '../state';
import { registerSupportHistoryHandlers } from '../history/useSupportHistoryHandlers';
import { computeAutoSupportPlan, runAutoPlace } from '../autoSupport/autoPlace';
import { setModelMesh } from '../autoSupport/meshStore';
import { DEFAULT_RAFT_SETTINGS } from '../Rafts/Crenelated/RaftDefaults';
import {
    clearRaftSettingsForModel,
    getAllPerModelRaftSettings,
    getRaftSettings,
    getRaftSettingsForModel,
    getRaftStateSnapshot,
    seedRaftStateSnapshot,
    setRaftSettings,
    setRaftSettingsForModel,
} from '../Rafts/Crenelated/RaftState';
import { buildAutoBracedSnapshot } from '../autoBracing/autoBrace';
import { createDefaultAutoBracingSettings } from '../autoBracing/settings';
import {
    clearMeshesForAutoBrace,
    getRegisteredMeshesForAutoBrace,
    registerMeshForAutoBrace,
} from '../autoBracing/meshGeometryStore';
import { linePassesMeshClearance } from '../autoBracing/meshClearance';
import { SUPPORT_TYPES } from '../supportTypeRegistry';
import type { SupportState } from '../types';
import {
    modelMeshKey,
    resetAutoPlaceWorkerCache,
    runAutoPlaceRequest,
    seedAutoPlaceEnvironment,
    serializeIsland,
    serializeModelMesh,
    type AutoPlaceWorkerPayload,
} from '../autoSupport/autoPlace.worker.shared';
import {
    AUTO_PLACE_WORKER_STARTUP_TIMEOUT_MS,
    buildAutoPlaceWorkerPayload,
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

    // Timings are wall-clock, so they never match between two runs: compare the
    // analytics without them, and the phase list separately.
    const withoutTimings = ({ timings: _timings, ...rest }: typeof inProcess.analytics) => rest;
    assert.equal(shape(withoutTimings(inWorker.analytics)), shape(withoutTimings(inProcess.analytics)),
        'analytics match, coverage included');
    assert.deepEqual(
        inWorker.analytics.timings?.phases.map((phase) => phase.label),
        inProcess.analytics.timings?.phases.map((phase) => phase.label),
        'both paths time the same phases',
    );
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

test('the worker classifies an internal island from the cavity mesh payload', () => {
    initializeBVH();
    const floor = new THREE.BoxGeometry(20, 20, 1).translate(0, 0, 0.5);
    const ceiling = new THREE.BoxGeometry(20, 20, 1).translate(0, 0, 9.5);
    const shell = new THREE.BufferGeometry();
    // Two plates: the tip can route around the open sides to the plate.
    shell.setAttribute('position', new THREE.Float32BufferAttribute([
        ...floor.getAttribute('position').array,
        ...ceiling.getAttribute('position').array,
    ], 3));
    shell.setIndex([
        ...Array.from(floor.getIndex()!.array),
        ...Array.from(ceiling.getIndex()!.array).map((i) => i + floor.getAttribute('position').count),
    ]);
    shell.computeVertexNormals();
    accelerateGeometry(shell);
    const modelMesh = new THREE.Mesh(shell);

    // Void boundary between the plates; normals point into the void.
    const cavity = new THREE.BoxGeometry(10, 10, 8).translate(0, 0, 5);
    const idx = cavity.getIndex()!;
    for (let i = 0; i < idx.count; i += 3) {
        const b = idx.getX(i + 1);
        idx.setX(i + 1, idx.getX(i + 2));
        idx.setX(i + 2, b);
    }
    idx.needsUpdate = true;
    accelerateGeometry(cavity);
    const cavityMesh = new THREE.Mesh(cavity);
    cavityMesh.updateMatrixWorld(true);

    resetStore();
    resetKickstandsInState();
    clearHistory();
    const payload: AutoPlaceWorkerPayload = {
        modelId: MODEL,
        islands: [serializeIsland({
            id: 'inner',
            source: 'overhang',
            contact: new THREE.Vector3(0, 0, 9),
            baseZ: 9,
            areaMm2: 100,
            overhangAngleDeg: 0,
            surfaceNormal: { x: 0, y: 0, z: -1 },
        })],
        settingsOverride: { debugSkipAutoBracing: true },
        appSettings: createDefaultSettings(),
        baseState: getSnapshot(),
        mesh: serializeModelMesh(modelMesh),
        meshKey: modelMeshKey(modelMesh),
        cavityMesh: serializeModelMesh(cavityMesh),
        cavityMeshKey: modelMeshKey(cavityMesh),
    };

    const plan = runAutoPlaceRequest(payload);
    assert.ok(plan, 'plan produced');
    assert.equal(plan.result.placed.trunk, 0, 'an internal island gets no plate trunk');
    assert.ok((plan.result.placed.stick ?? 0) + (plan.result.placed.twig ?? 0) > 0,
        'it is bridged inside the cavity');
    assert.equal(plan.result.rejectedCandidates, 0);
});

test('the worker fallback poses the cavity geometry with the model mesh', async () => {
    initializeBVH();
    const floor = new THREE.BoxGeometry(20, 20, 1).translate(0, 0, 0.5);
    const ceiling = new THREE.BoxGeometry(20, 20, 1).translate(0, 0, 9.5);
    const shell = new THREE.BufferGeometry();
    shell.setAttribute('position', new THREE.Float32BufferAttribute([
        ...floor.getAttribute('position').array,
        ...ceiling.getAttribute('position').array,
    ], 3));
    shell.setIndex([
        ...Array.from(floor.getIndex()!.array),
        ...Array.from(ceiling.getIndex()!.array).map((i) => i + floor.getAttribute('position').count),
    ]);
    shell.computeVertexNormals();
    accelerateGeometry(shell);

    resetStore();
    resetKickstandsInState();
    clearHistory();
    const dispose = registerSupportHistoryHandlers();
    initializeBVH();
    setSettings(createDefaultSettings());

    // The model is translated +5 in X; the cavity geometry stays local. A
    // classification that forgot the pose would miss the island entirely.
    const modelMesh = new THREE.Mesh(shell);
    modelMesh.position.set(5, 0, 0);
    modelMesh.updateMatrixWorld(true);
    setModelMesh(MODEL, modelMesh);

    const cavity = new THREE.BoxGeometry(10, 10, 8).translate(0, 0, 5);
    const idx = cavity.getIndex()!;
    for (let i = 0; i < idx.count; i += 3) {
        const b = idx.getX(i + 1);
        idx.setX(i + 1, idx.getX(i + 2));
        idx.setX(i + 2, b);
    }
    idx.needsUpdate = true;
    accelerateGeometry(cavity);

    const result = await runAutoPlaceInWorker(
        [{
            id: 'inner',
            source: 'overhang',
            contact: new THREE.Vector3(5, 0, 9),
            baseZ: 9,
            areaMm2: 100,
            overhangAngleDeg: 0,
            surfaceNormal: { x: 0, y: 0, z: -1 },
        }],
        MODEL,
        { debugSkipAutoBracing: true },
        undefined,
        cavity,
    );

    assert.equal(result.placed.trunk, 0, 'no plate trunk for the posed internal contact');
    assert.ok((result.placed.stick ?? 0) + (result.placed.twig ?? 0) > 0,
        'bridged inside the cavity after applying the model pose');
    setModelMesh(MODEL, null);
    dispose();
});

test('CRIT-02a: worker syncs global and per-model RaftState (off vs solid) and matches in-process plan', () => {
    initializeBVH();
    const { island } = rotatedUnderside();
    const rawGeometry = new THREE.BoxGeometry(20, 20, 20);
    rawGeometry.rotateX(THREE.MathUtils.degToRad(30));
    rawGeometry.translate(0, 0, 20);
    rawGeometry.clearGroups();
    rawGeometry.setIndex(new THREE.BufferAttribute(new Uint32Array(rawGeometry.getIndex()!.array), 1));
    const rawMesh = new THREE.Mesh(rawGeometry);
    rawMesh.updateMatrixWorld(true);

    const inProcessGeometry = rawGeometry.clone();
    accelerateGeometry(inProcessGeometry);
    const mesh = new THREE.Mesh(inProcessGeometry);
    mesh.updateMatrixWorld(true);

    // Sub-150 mm² steep-flat island on an edge-balanced box: covered only when
    // hasRaft === false (adhesionRatio < CONSERVATIVE_P_SIGMA); dropped when
    // hasRaft === true (full XY raft shadow stabilizes the pose).
    const steepIsland: DetectedIsland = {
        ...island,
        steepFlat: true,
        surfaceAreaMm2: 80,
    };
    const override: Partial<AutoSupportSettings> = { debugSkipAutoBracing: true };

    try {
        // 1. Global bottomMode: 'off'
        setRaftSettings({ ...DEFAULT_RAFT_SETTINGS, bottomMode: 'off' });
        clearRaftSettingsForModel(MODEL);

        const snapCheck = getRaftStateSnapshot();
        snapCheck.global.bottomMode = 'solid';
        assert.equal(getRaftSettings().bottomMode, 'off', 'snapshot is cloned against aliasing');

        const inProcessGlobalOff = withStore(mesh, () => {
            resetAutoPlaceWorker();
            resetAutoPlaceWorkerCache();
            return computeAutoSupportPlan([steepIsland], MODEL, override, undefined, mesh);
        });
        const payloadGlobalOff = withStore(rawMesh, () => {
            resetAutoPlaceWorker();
            return structuredClone(buildAutoPlaceWorkerPayload([steepIsland], MODEL, override));
        });

        // Pre-seed worker realm to 'solid' plus a leftover per-model override.
        seedRaftStateSnapshot({
            global: { ...DEFAULT_RAFT_SETTINGS, bottomMode: 'solid' },
            perModel: { 'stale-model': { ...DEFAULT_RAFT_SETTINGS, bottomMode: 'solid' } },
        });

        const inWorkerGlobalOff = withStore(null, () => runAutoPlaceRequest(payloadGlobalOff));
        assert.equal(getRaftSettingsForModel(MODEL).bottomMode !== 'off', false, 'worker hasRaft === false');
        assert.equal(getAllPerModelRaftSettings().has('stale-model'), false, 'leftover per-model raft entry cleared');
        assert.ok(inProcessGlobalOff && inWorkerGlobalOff);
        assert.ok(inWorkerGlobalOff.result.placed.trunk > 0, 'steep-flat covered when raft is off');
        assert.equal(shape(inWorkerGlobalOff.support), shape(inProcessGlobalOff.support));

        // 2. Global 'solid' with per-model 'off' override on MODEL
        setRaftSettings({ ...DEFAULT_RAFT_SETTINGS, bottomMode: 'solid' });
        setRaftSettingsForModel(MODEL, { ...DEFAULT_RAFT_SETTINGS, bottomMode: 'off' });

        const inProcessPerModelOff = withStore(mesh, () =>
            computeAutoSupportPlan([steepIsland], MODEL, override, undefined, mesh));
        const payloadPerModelOff = withStore(rawMesh, () => {
            resetAutoPlaceWorker();
            return structuredClone(buildAutoPlaceWorkerPayload([steepIsland], MODEL, override));
        });

        seedRaftStateSnapshot({
            global: { ...DEFAULT_RAFT_SETTINGS, bottomMode: 'solid' },
            perModel: {},
        });

        const inWorkerPerModelOff = withStore(null, () => runAutoPlaceRequest(payloadPerModelOff));
        assert.equal(getRaftSettings().bottomMode, 'solid');
        assert.equal(getRaftSettingsForModel(MODEL).bottomMode !== 'off', false, 'per-model hasRaft === false');
        assert.ok(inProcessPerModelOff && inWorkerPerModelOff);
        assert.ok(inWorkerPerModelOff.result.placed.trunk > 0, 'per-model raft off triggers topple coverage');
        assert.equal(shape(inWorkerPerModelOff.support), shape(inProcessPerModelOff.support));
    } finally {
        setRaftSettings({ ...DEFAULT_RAFT_SETTINGS });
        clearRaftSettingsForModel(MODEL);
        clearMeshesForAutoBrace();
        resetAutoPlaceWorker();
        resetAutoPlaceWorkerCache();
    }
});

test('HIGH-04 + CRIT-02b: per-model auto-bracing preserves sibling entities and enforces active sibling mesh clearance while ignoring ghost meshes', () => {
    initializeBVH();
    clearMeshesForAutoBrace();
    resetAutoPlaceWorker();
    resetAutoPlaceWorkerCache();

    const prevSettings = getSettings();
    const nonGridSettings = createDefaultSettings();
    nonGridSettings.grid = { ...nonGridSettings.grid, enabled: false };
    setSettings(nonGridSettings);

    const makeBoxMesh = (size: [number, number, number], pos: [number, number, number]): THREE.Mesh => {
        const geo = new THREE.BoxGeometry(size[0], size[1], size[2]);
        accelerateGeometry(geo);
        const m = new THREE.Mesh(geo);
        m.position.set(pos[0], pos[1], pos[2]);
        m.updateMatrixWorld(true);
        return m;
    };

    const makeRoot = (id: string, modelId: string, x: number, y: number) => ({
        id,
        modelId,
        transform: { pos: { x, y, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
        diameter: 3,
        diskHeight: 0.5,
        coneHeight: 1.5,
    });

    const makeSeg = (id: string, x: number, y: number, z0 = 2, z1 = 24) => ({
        id,
        diameter: 1.0,
        bottomJoint: { id: `${id}-bj`, pos: { x, y, z: z0 }, diameter: 1.0 },
        topJoint: { id: `${id}-tj`, pos: { x, y, z: z1 }, diameter: 1.0 },
    });

    const makeEmptySupportState = (): SupportState => {
        const state = {
            roots: {},
            knots: {},
            selectedId: null,
            hoveredId: null,
            selectedCategory: null,
            hoveredCategory: 'none',
            interactionWarning: null,
        } as unknown as SupportState;
        for (const descriptor of SUPPORT_TYPES) {
            (state as unknown as Record<string, unknown>)[descriptor.location.key] = {};
        }
        return state;
    };

    try {
        // model-b mesh sits high above z=24 so its own mesh never blocks z=2..24 braces.
        const meshB = makeBoxMesh([20, 20, 2], [3, 3, 28]);
        // model-a obstacle sits directly between trunk-b1 (0,0) and trunk-b2 (6,0).
        const meshA = makeBoxMesh([4, 4, 24], [3, 0, 12]);
        // ghost-model obstacle sits directly between trunk-b1 (0,0) and trunk-b3 (0,6),
        // with NO entities in baseState (simulating leaked test state).
        const meshGhost = makeBoxMesh([4, 4, 24], [0, 3, 12]);

        setModelMesh('model-b', meshB);
        setModelMesh('model-a', meshA);
        registerMeshForAutoBrace('model-b', meshB.geometry as THREE.BufferGeometry, meshB.matrixWorld);
        registerMeshForAutoBrace('model-a', meshA.geometry as THREE.BufferGeometry, meshA.matrixWorld);
        registerMeshForAutoBrace('ghost-model', meshGhost.geometry as THREE.BufferGeometry, meshGhost.matrixWorld);

        const baseState = makeEmptySupportState();
        // Sibling model-a entities (must remain 100% untouched)
        baseState.roots['root-a1'] = makeRoot('root-a1', 'model-a', 50, 50);
        baseState.roots['root-a2'] = makeRoot('root-a2', 'model-a', 56, 50);
        baseState.roots['ks-root-a1'] = makeRoot('ks-root-a1', 'model-a', 50, 54);
        baseState.trunks['trunk-a1'] = {
            id: 'trunk-a1',
            modelId: 'model-a',
            typeId: 'trunk',
            rootId: 'root-a1',
            segments: [makeSeg('seg-a1', 50, 50)],
        };
        baseState.trunks['trunk-a2'] = {
            id: 'trunk-a2',
            modelId: 'model-a',
            typeId: 'trunk',
            rootId: 'root-a2',
            segments: [makeSeg('seg-a2', 56, 50)],
        };
        baseState.knots['knot-a1'] = {
            id: 'knot-a1',
            parentShaftId: 'seg-a1',
            t: 0.4,
            pos: { x: 50, y: 50, z: 10 },
            diameter: 1.1,
        };
        baseState.knots['knot-a2'] = {
            id: 'knot-a2',
            parentShaftId: 'seg-a2',
            t: 0.6,
            pos: { x: 56, y: 50, z: 16 },
            diameter: 1.1,
        };
        baseState.knots['knot-a-ks'] = {
            id: 'knot-a-ks',
            parentShaftId: 'seg-a1',
            t: 0.7,
            pos: { x: 50, y: 50, z: 18 },
            diameter: 1.1,
        };
        baseState.knots['knot-a-orphan'] = {
            id: 'knot-a-orphan',
            parentShaftId: 'seg-a1',
            t: 0.2,
            pos: { x: 50, y: 50, z: 6 },
            diameter: 1.1,
            hostedBy: 'autoBracing',
        } as unknown as SupportState['knots'][string];
        baseState.braces['brace-a1'] = {
            id: 'brace-a1',
            modelId: 'model-a',
            typeId: 'brace',
            startKnotId: 'knot-a1',
            endKnotId: 'knot-a2',
            profile: { diameter: 0.8 },
            generatedBy: 'autoBracing',
        };
        baseState.kickstands['ks-a1'] = {
            id: 'ks-a1',
            modelId: 'model-a',
            typeId: 'kickstand',
            rootId: 'ks-root-a1',
            hostKnotId: 'knot-a-ks',
            hostSegmentId: 'seg-a1',
            hostMinT: 0.2,
            segments: [makeSeg('seg-ks-a1', 50, 54, 2, 18)],
            profile: { bodyDiameterMm: 0.8, terminalStartDiameterMm: 0.8, terminalEndDiameterMm: 0.8 },
            generatedBy: 'autoBracing',
        };

        // Target model-b entities (3 shafts + legacy autoBracing brace & orphaned knot)
        baseState.roots['root-b1'] = makeRoot('root-b1', 'model-b', 0, 0);
        baseState.roots['root-b2'] = makeRoot('root-b2', 'model-b', 6, 0);
        baseState.roots['root-b3'] = makeRoot('root-b3', 'model-b', 0, 6);
        baseState.trunks['trunk-b1'] = {
            id: 'trunk-b1',
            modelId: 'model-b',
            typeId: 'trunk',
            rootId: 'root-b1',
            segments: [makeSeg('seg-b1', 0, 0)],
        };
        baseState.trunks['trunk-b2'] = {
            id: 'trunk-b2',
            modelId: 'model-b',
            typeId: 'trunk',
            rootId: 'root-b2',
            segments: [makeSeg('seg-b2', 6, 0)],
        };
        baseState.trunks['trunk-b3'] = {
            id: 'trunk-b3',
            modelId: 'model-b',
            typeId: 'trunk',
            rootId: 'root-b3',
            segments: [makeSeg('seg-b3', 0, 6)],
        };
        baseState.knots['knot-b-old-1'] = {
            id: 'knot-b-old-1',
            parentShaftId: 'seg-b1',
            t: 0.3,
            pos: { x: 0, y: 0, z: 8 },
            diameter: 1.1,
        };
        baseState.knots['knot-b-old-2'] = {
            id: 'knot-b-old-2',
            parentShaftId: 'seg-b3',
            t: 0.5,
            pos: { x: 0, y: 6, z: 14 },
            diameter: 1.1,
        };
        baseState.knots['knot-b-orphan'] = {
            id: 'knot-b-orphan',
            parentShaftId: 'seg-b1',
            t: 0.15,
            pos: { x: 0, y: 0, z: 5 },
            diameter: 1.1,
            hostedBy: 'autoBracing',
        } as unknown as SupportState['knots'][string];
        baseState.braces['brace-b-old'] = {
            id: 'brace-b-old',
            modelId: 'model-b',
            typeId: 'brace',
            startKnotId: 'knot-b-old-1',
            endKnotId: 'knot-b-old-2',
            profile: { diameter: 0.8 },
            generatedBy: 'autoBracing',
        };

        setSnapshot(baseState);

        // Verify worker payload packs active sibling model-a, omits ghost-model, and prunes worker store.
        const workerPayload = buildAutoPlaceWorkerPayload([], 'model-b', { debugSkipAutoBracing: false });
        assert.deepEqual(
            workerPayload.siblingMeshes?.map((s) => s.modelId),
            ['model-a'],
            'only active sibling model-a is packed into siblingMeshes',
        );
        seedAutoPlaceEnvironment(structuredClone(workerPayload));
        assert.equal(getRegisteredMeshesForAutoBrace().has('model-b'), true);
        assert.equal(getRegisteredMeshesForAutoBrace().has('model-a'), true);
        assert.equal(getRegisteredMeshesForAutoBrace().has('ghost-model'), false, 'worker seeding pruned ghost-model');

        // Re-register ghost-model to ALSO prove autoBrace.ts activePlateModelIds ignores leaked ghost meshes directly.
        registerMeshForAutoBrace('ghost-model', meshGhost.geometry as THREE.BufferGeometry, meshGhost.matrixWorld);

        const braceSettings = {
            ...createDefaultAutoBracingSettings(),
            braceDiameterMm: 0.8,
            initialDistanceMm: 4.0,
            patternIntervalMm: 6.0,
            maxBraceLengthMm: 10.0,
            removeExistingBracing: true,
        };

        const scopedResult = buildAutoBracedSnapshot(baseState, braceSettings, { modelId: 'model-b' });
        const after = scopedResult.snapshot;

        // 1. Sibling model-a braces, kickstands, roots, knots, and trunks are 100% untouched.
        assert.equal(scopedResult.removedBraceCount, 1, 'only model-b old brace counted as removed');
        assert.deepEqual(after.braces['brace-a1'], baseState.braces['brace-a1'], 'model-a brace untouched');
        assert.deepEqual(after.kickstands['ks-a1'], baseState.kickstands['ks-a1'], 'model-a kickstand untouched');
        assert.deepEqual(after.roots['ks-root-a1'], baseState.roots['ks-root-a1'], 'model-a kickstand root untouched');
        assert.ok(after.knots['knot-a1'] && after.knots['knot-a2'] && after.knots['knot-a-ks'], 'model-a knots preserved');
        assert.ok(after.knots['knot-a-orphan'], 'model-a hostedBy:autoBracing knot preserved');
        assert.equal(
            Object.values(after.braces).filter((b) => b.modelId === 'model-a').length,
            1,
            'no extra braces generated on model-a',
        );
        assert.equal(
            Object.values(after.kickstands).filter((k) => k.modelId === 'model-a').length,
            1,
            'no extra kickstands generated on model-a',
        );

        // 2. Target model-b old auto-bracing artifacts removed, ghost-model ignored, model-a obstacle respected.
        assert.equal(after.braces['brace-b-old'], undefined, 'model-b old brace stripped');
        assert.equal(after.knots['knot-b-orphan'], undefined, 'model-b orphaned autoBracing knot stripped');

        const spansPair = (state: SupportState, segA: string, segB: string): number =>
            Object.values(state.braces).filter((b) => {
                if (b.modelId !== 'model-b') return false;
                const s = state.knots[b.startKnotId]?.parentShaftId;
                const e = state.knots[b.endKnotId]?.parentShaftId;
                return (s === segA && e === segB) || (s === segB && e === segA);
            }).length;

        assert.equal(
            spansPair(after, 'seg-b1', 'seg-b2'),
            0,
            'sibling model-a obstacle mesh blocked braces between trunk-b1 and trunk-b2',
        );
        assert.ok(
            spansPair(after, 'seg-b1', 'seg-b3') > 0,
            'ghost-model mesh with no plate entities was ignored between trunk-b1 and trunk-b3',
        );

        // 3. Control proof: removing model-a from baseState allows braces between trunk-b1 and trunk-b2.
        const stateWithoutModelA = makeEmptySupportState();
        for (const id of ['root-b1', 'root-b2', 'root-b3']) stateWithoutModelA.roots[id] = baseState.roots[id];
        for (const id of ['trunk-b1', 'trunk-b2', 'trunk-b3']) stateWithoutModelA.trunks[id] = baseState.trunks[id];

        const controlResult = buildAutoBracedSnapshot(stateWithoutModelA, braceSettings, { modelId: 'model-b' });
        assert.ok(
            spansPair(controlResult.snapshot, 'seg-b1', 'seg-b2') > 0,
            'removing model-a from plate allows braces between trunk-b1 and trunk-b2',
        );
    } finally {
        setModelMesh('model-b', null);
        setModelMesh('model-a', null);
        clearMeshesForAutoBrace();
        resetStore();
        resetKickstandsInState();
        setSettings(prevSettings);
        resetAutoPlaceWorker();
        resetAutoPlaceWorkerCache();
    }
});

test('BUG-PERF-WIRE [a]: consecutive worker payloads deduplicate unchanged meshes via meshKey and re-send after reset or pose change', () => {
    const { mesh, island } = rotatedUnderside();
    const override: Partial<AutoSupportSettings> = {
        debugSkipAutoBracing: true,
        stabilizationEnabled: false,
    };

    try {
        withStore(mesh, () => {
            resetAutoPlaceWorker();
            resetAutoPlaceWorkerCache();

            const p1 = buildAutoPlaceWorkerPayload([island], MODEL, override);
            assert.notEqual(p1.mesh, undefined, 'first payload carries serialized mesh');
            assert.ok(p1.meshKey && p1.meshKey.length > 0, 'first payload carries meshKey');

            const p2 = buildAutoPlaceWorkerPayload([island], MODEL, override);
            assert.equal(p2.mesh, undefined, 'second consecutive payload omits unchanged mesh');
            assert.equal(p2.meshKey, p1.meshKey, 'second payload preserves matching meshKey');

            const plan1 = runAutoPlaceRequest(structuredClone(p1));
            const plan2 = runAutoPlaceRequest(structuredClone(p2));
            assert.ok(plan1 && plan2, 'worker executes both full and deduplicated payloads');
            assert.equal(shape(plan2.support), shape(plan1.support), 'deduplicated run matches first run');

            // In-process worker simulation overwrote shared meshStore; restore client mesh.
            setModelMesh(MODEL, mesh);
            resetAutoPlaceWorker();
            const p3 = buildAutoPlaceWorkerPayload([island], MODEL, override);
            assert.notEqual(p3.mesh, undefined, 'resetAutoPlaceWorker invalidates client mesh confirmation');
            assert.equal(p3.meshKey, p1.meshKey);

            const p4 = buildAutoPlaceWorkerPayload([island], MODEL, override);
            assert.equal(p4.mesh, undefined, 're-confirmed mesh deduplicates again');

            mesh.position.set(3, 0, 0);
            mesh.updateMatrixWorld(true);
            const p5 = buildAutoPlaceWorkerPayload([island], MODEL, override);
            assert.notEqual(p5.mesh, undefined, 'pose mutation changes meshKey and re-sends mesh');
            assert.notEqual(p5.meshKey, p1.meshKey, 'meshKey reflects updated matrixWorld');
        });
    } finally {
        clearMeshesForAutoBrace();
        resetAutoPlaceWorker();
        resetAutoPlaceWorkerCache();
    }
});

test('BLOCKER-01 + MINOR-01: sequential scoped buildAutoBracedSnapshot re-keys colliding kickstand IDs without overwriting sibling kickstands and honors supports/knots in activePlateModelIds', () => {
    initializeBVH();
    clearMeshesForAutoBrace();

    const prevSettings = getSettings();
    const nonGridSettings = createDefaultSettings();
    nonGridSettings.grid = { ...nonGridSettings.grid, enabled: false };
    setSettings(nonGridSettings);

    const makeEmptyState = (): SupportState => {
        const state = {
            roots: {},
            knots: {},
            selectedId: null,
            hoveredId: null,
            selectedCategory: null,
            hoveredCategory: 'none',
            interactionWarning: null,
        } as unknown as SupportState;
        for (const descriptor of SUPPORT_TYPES) {
            (state as unknown as Record<string, unknown>)[descriptor.location.key] = {};
        }
        return state;
    };

    const addTallTrunk = (state: SupportState, id: string, modelId: string, x: number, y: number) => {
        const rootId = `root-${id}`;
        state.roots[rootId] = {
            id: rootId,
            modelId,
            transform: { pos: { x, y, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
            diameter: 3,
            diskHeight: 0.5,
            coneHeight: 1.5,
        };
        state.trunks[id] = {
            id,
            modelId,
            typeId: 'trunk',
            rootId,
            segments: [{
                id: `seg-${id}`,
                diameter: 1.0,
                bottomJoint: { id: `bj-${id}`, pos: { x, y, z: 2 }, diameter: 1.0 },
                topJoint: { id: `tj-${id}`, pos: { x, y, z: 24 }, diameter: 1.0 },
            }],
        };
    };

    const braceSettings = {
        ...createDefaultAutoBracingSettings(),
        braceDiameterMm: 0.8,
        initialDistanceMm: 4.0,
        patternIntervalMm: 6.0,
        maxBraceLengthMm: 10.0,
        removeExistingBracing: true,
    };

    try {
        // 1. Run scoped auto-bracing for model-a (3 tall isolated trunks -> generates real auto-ks-0-... kickstands)
        const state0 = makeEmptyState();
        addTallTrunk(state0, 'trunk-a1', 'model-a', 0, 0);
        addTallTrunk(state0, 'trunk-a2', 'model-a', 25, 0);
        addTallTrunk(state0, 'trunk-a3', 'model-a', 50, 0);

        const resA = buildAutoBracedSnapshot(state0, braceSettings, { modelId: 'model-a' });
        const modelAKickstands = Object.values(resA.snapshot.kickstands).filter((k) => k.modelId === 'model-a');
        assert.ok(modelAKickstands.length > 0, 'model-a generated kickstands');
        assert.ok(
            resA.snapshot.kickstands['auto-ks-0-0-0-0-0-kickstand'],
            'first model keeps canonical 0-diff kickstand ID',
        );

        const savedModelAKickstands = structuredClone(
            Object.fromEntries(Object.entries(resA.snapshot.kickstands).filter(([, k]) => k.modelId === 'model-a')),
        );
        const savedModelARoots = structuredClone(
            Object.fromEntries(Object.entries(resA.snapshot.roots).filter(([, r]) => r.modelId === 'model-a')),
        );
        const savedModelAKnotIds = new Set<string>();
        for (const ks of Object.values(savedModelAKickstands)) {
            savedModelAKnotIds.add(ks.hostKnotId);
        }
        for (const br of Object.values(resA.snapshot.braces)) {
            if (br.modelId === 'model-a') {
                savedModelAKnotIds.add(br.startKnotId);
                savedModelAKnotIds.add(br.endKnotId);
            }
        }
        const savedModelAKnots = structuredClone(
            Object.fromEntries([...savedModelAKnotIds].map((id) => [id, resA.snapshot.knots[id]])),
        );

        // 2. Add model-b trunks that ALSO trigger kickstands, and run scoped auto-bracing for model-b
        const stateWithB = structuredClone(resA.snapshot);
        addTallTrunk(stateWithB, 'trunk-b1', 'model-b', 0, 50);
        addTallTrunk(stateWithB, 'trunk-b2', 'model-b', 25, 50);
        addTallTrunk(stateWithB, 'trunk-b3', 'model-b', 50, 50);

        const resB = buildAutoBracedSnapshot(stateWithB, braceSettings, { modelId: 'model-b' });
        const afterB = resB.snapshot;

        // Assert model-a kickstands, roots, and knots were NOT overwritten by model-b!
        const afterModelAKickstands = Object.fromEntries(
            Object.entries(afterB.kickstands).filter(([, k]) => k.modelId === 'model-a'),
        );
        const afterModelARoots = Object.fromEntries(
            Object.entries(afterB.roots).filter(([, r]) => r.modelId === 'model-a'),
        );
        const afterModelAKnots = Object.fromEntries(
            [...savedModelAKnotIds].map((id) => [id, afterB.knots[id]]),
        );
        assert.deepEqual(afterModelAKickstands, savedModelAKickstands, 'model-a kickstands 100% preserved');
        assert.deepEqual(afterModelARoots, savedModelARoots, 'model-a kickstand roots 100% preserved');
        assert.deepEqual(afterModelAKnots, savedModelAKnots, 'model-a kickstand & brace knots 100% preserved');

        // Assert model-b ALSO generated valid, self-consistent, re-keyed kickstands
        const modelBKickstands = Object.values(afterB.kickstands).filter((k) => k.modelId === 'model-b');
        assert.equal(modelBKickstands.length, modelAKickstands.length, 'model-b generated matching kickstand count');
        const allSegIds = new Set<string>();
        for (const t of Object.values(afterB.trunks)) {
            for (const s of t.segments) allSegIds.add(s.id);
        }
        for (const ks of Object.values(afterB.kickstands)) {
            assert.ok(afterB.roots[ks.rootId], `kickstand ${ks.id} root exists`);
            assert.equal(afterB.roots[ks.rootId].modelId, ks.modelId, `kickstand ${ks.id} root matches modelId`);
            assert.ok(afterB.knots[ks.hostKnotId], `kickstand ${ks.id} hostKnot exists`);
            for (const seg of ks.segments) {
                assert.equal(allSegIds.has(seg.id), false, `segment ID ${seg.id} is globally unique`);
                allSegIds.add(seg.id);
            }
        }

        // Re-running scoped model-b is deterministic and idempotent
        const resB2 = buildAutoBracedSnapshot(afterB, braceSettings, { modelId: 'model-b' });
        assert.deepEqual(
            Object.keys(resB2.snapshot.kickstands).sort(),
            Object.keys(afterB.kickstands).sort(),
            're-running scoped model-b preserves deterministic kickstand keys without drifting',
        );

        // MINOR-01: sibling model referenced only via snapshot.knots / snapshot.supports is honored in activePlateModelIds
        const obsGeo = new THREE.BoxGeometry(4, 4, 24);
        accelerateGeometry(obsGeo);
        const obsMesh = new THREE.Mesh(obsGeo);
        obsMesh.position.set(3, 80, 12);
        obsMesh.updateMatrixWorld(true);
        registerMeshForAutoBrace('model-c', obsMesh.geometry as THREE.BufferGeometry, obsMesh.matrixWorld);

        const stateMinor = makeEmptyState();
        addTallTrunk(stateMinor, 'trunk-d1', 'model-d', 0, 80);
        addTallTrunk(stateMinor, 'trunk-d2', 'model-d', 6, 80);
        addTallTrunk(stateMinor, 'trunk-d3', 'model-d', 0, 86);
        (stateMinor.knots as Record<string, unknown>)['knot-only-c'] = {
            id: 'knot-only-c',
            modelId: 'model-c',
            parentShaftId: 'external-seg-c',
            t: 0.5,
            pos: { x: 3, y: 80, z: 12 },
            diameter: 1.0,
        };
        const resMinor = buildAutoBracedSnapshot(stateMinor, braceSettings, { modelId: 'model-d' });
        const d1d2Braces = Object.values(resMinor.snapshot.braces).filter((b) => {
            const s = resMinor.snapshot.knots[b.startKnotId]?.parentShaftId;
            const e = resMinor.snapshot.knots[b.endKnotId]?.parentShaftId;
            return (s === 'seg-trunk-d1' && e === 'seg-trunk-d2') || (s === 'seg-trunk-d2' && e === 'seg-trunk-d1');
        });
        assert.equal(d1d2Braces.length, 0, 'model-c obstacle referenced via snapshot.knots blocked d1-d2 braces');
    } finally {
        clearMeshesForAutoBrace();
        setSettings(prevSettings);
    }
});

test('MAJOR-01: worker throws loud error on meshKey cache miss, resets confirmedMeshKeys on new Worker(), and cleans up on synchronous postMessage throw', async (t) => {
    const { mesh, island } = rotatedUnderside();
    const override: Partial<AutoSupportSettings> = {
        debugSkipAutoBracing: true,
        stabilizationEnabled: false,
    };

    // 1. Loud throw on worker mesh cache miss
    resetAutoPlaceWorkerCache();
    const coldMissPayload: AutoPlaceWorkerPayload = {
        ...payloadFor(island, mesh, override),
        mesh: undefined,
        meshKey: 'missing-key-xyz',
    };
    assert.throws(
        () => withStore(null, () => runAutoPlaceRequest(coldMissPayload)),
        /Auto-place worker mesh cache miss for model "model-a" \(key "missing-key-xyz"\)/,
        'worker throws loud error instead of silently planning with mesh = undefined',
    );

    // 2. Spawning a new Worker() clears stale confirmedMeshKeys accumulated before the worker existed
    resetAutoPlaceWorker();
    resetAutoPlaceWorkerCache();
    let postedPayloads: AutoPlaceWorkerPayload[] = [];
    let stubRef: WorkerStub | null = null;
    const { stub, restore: restoreWorker } = stubWorker({
        postMessage: (message: { requestId: number; payload?: AutoPlaceWorkerPayload }) => {
            if (message.payload) postedPayloads.push(message.payload);
            queueMicrotask(() => {
                try {
                    const plan = runAutoPlaceRequest(structuredClone(message.payload!));
                    stubRef?.onmessage?.({ data: { type: 'result', requestId: message.requestId, plan } });
                } catch (err) {
                    stubRef?.onmessage?.({
                        data: {
                            type: 'error',
                            requestId: message.requestId,
                            error: err instanceof Error ? err.message : String(err),
                        },
                    });
                }
            });
        },
    });
    stubRef = stub;

    try {
        resetStore();
        resetKickstandsInState();
        clearHistory();
        const dispose = registerSupportHistoryHandlers();
        initializeBVH();
        setModelMesh(MODEL, mesh);

        // Temporarily hide Worker to simulate pre-worker payload call populating confirmedMeshKeys
        restoreWorker();
        const standalonePayload = buildAutoPlaceWorkerPayload([island], MODEL, override);
        assert.notEqual(standalonePayload.mesh, undefined);
        const deduplicatedStandalone = buildAutoPlaceWorkerPayload([island], MODEL, override);
        assert.equal(deduplicatedStandalone.mesh, undefined, 'standalone confirmedMeshKeys populated');

        // Re-install Worker constructor: ensureWorker() must clear stale confirmedMeshKeys on new Worker()!
        const reinstalled = stubWorker({
            postMessage: (message: { requestId: number; payload?: AutoPlaceWorkerPayload }) => {
                if (message.payload) postedPayloads.push(message.payload);
                queueMicrotask(() => {
                    const plan = runAutoPlaceRequest(structuredClone(message.payload!));
                    reinstalled.stub.onmessage?.({ data: { type: 'result', requestId: message.requestId, plan } });
                });
            },
        });
        try {
            resetAutoPlaceWorkerCache();
            postedPayloads = [];
            // Restore mesh because standalone runAutoPlaceRequest wasn't called yet, mesh is still on MODEL
            setModelMesh(MODEL, mesh);
            const result = await runAutoPlaceInWorker([island], MODEL, override);
            assert.ok(result.placed.trunk > 0, 'worker run succeeded on cold worker');
            assert.equal(postedPayloads.length, 1);
            assert.notEqual(
                postedPayloads[0].mesh,
                undefined,
                'newly spawned Worker received full serialized mesh despite prior confirmedMeshKeys',
            );
        } finally {
            reinstalled.restore();
        }

        // 3. Synchronous postMessage throw cleans up startupTimer, pending map, and confirmedMeshKeys
        resetStore();
        resetKickstandsInState();
        resetAutoPlaceWorker();
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const logs = captureConsoleError();
        const throwingWorker = stubWorker({
            postMessage: () => {
                throw new Error('DataCloneError: synthetic clone failure');
            },
        });
        try {
            setModelMesh(MODEL, mesh);
            const fallbackRes = await runAutoPlaceInWorker([island], MODEL, override);
            assert.ok(fallbackRes.placed.trunk > 0, 'fell back to in-process after postMessage throw');
            // Advancing past startup timeout must NOT trigger an unhandled rejection or extra error
            t.mock.timers.tick(AUTO_PLACE_WORKER_STARTUP_TIMEOUT_MS * 2);
            const freshPayload = buildAutoPlaceWorkerPayload([island], MODEL, override);
            assert.notEqual(
                freshPayload.mesh,
                undefined,
                'postMessage failure cleared confirmedMeshKeys so next payload re-sends mesh',
            );
        } finally {
            throwingWorker.restore();
            logs.restore();
            t.mock.timers.reset();
        }

        setModelMesh(MODEL, null);
        dispose();
    } finally {
        restoreWorker();
        resetAutoPlaceWorker();
        resetAutoPlaceWorkerCache();
    }
});

test('MAJOR-02: in-place vertex edits and setAttribute at version 0 invalidate getMeshWorldBox and modelMeshKey', () => {
    clearMeshesForAutoBrace();
    try {
        // 1. modelMeshKey distinguishes replaced BufferAttribute arrays at version === 0 on the same geometry.uuid
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 50, 4, 0, 50, 0, 4, 50], 3));
        geo.setIndex(new THREE.Uint16BufferAttribute([0, 1, 2], 1));
        const m = new THREE.Mesh(geo);
        m.updateMatrixWorld(true);
        const key1 = modelMeshKey(m);

        geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 10, 4, 0, 10, 0, 4, 10], 3));
        assert.equal((geo.getAttribute('position') as THREE.BufferAttribute).version, 0, 'new attribute starts at version 0');
        const key2 = modelMeshKey(m);
        assert.notEqual(key2, key1, 'replacing position attribute at version 0 changes modelMeshKey');

        geo.setIndex(new THREE.Uint16BufferAttribute([0, 2, 1], 1));
        assert.equal(geo.getIndex()!.version, 0, 'new index starts at version 0');
        const key3 = modelMeshKey(m);
        assert.notEqual(key3, key2, 'replacing index attribute at version 0 changes modelMeshKey');

        // 2. getMeshWorldBox (via linePassesMeshClearance) recomputes boundingBox on needsUpdate and setAttribute
        const boxGeo = new THREE.BoxGeometry(6, 6, 4).toNonIndexed();
        boxGeo.translate(0, 0, 52); // Initially at z = 50..54, clear of z = 10
        const identity = new THREE.Matrix4();
        registerMeshForAutoBrace('model-edit', boxGeo, identity);

        assert.equal(
            linePassesMeshClearance({ x: -5, y: 0, z: 10 }, { x: 5, y: 0, z: 10 }, 'model-edit', 0.8),
            true,
            'initially clear while box sits at z = 50..54',
        );
        assert.ok(boxGeo.boundingBox, 'boundingBox cached on geometry');

        // Mutate vertices in-place down to z = 8..12 (needsUpdate increments version WITHOUT nulling boundingBox!)
        const posAttr = boxGeo.getAttribute('position') as THREE.BufferAttribute;
        const shiftedPositions = new Float32Array(posAttr.array.length);
        for (let i = 0; i < posAttr.count; i += 1) {
            const x = posAttr.getX(i);
            const y = posAttr.getY(i);
            const z = posAttr.getZ(i) - 42;
            posAttr.setZ(i, z);
            shiftedPositions[i * 3] = x;
            shiftedPositions[i * 3 + 1] = y;
            shiftedPositions[i * 3 + 2] = z;
        }
        posAttr.needsUpdate = true;
        boxGeo.boundingSphere = null;

        assert.equal(
            linePassesMeshClearance({ x: -5, y: 0, z: 10 }, { x: 5, y: 0, z: 10 }, 'model-edit', 0.8),
            false,
            'in-place posAttr.needsUpdate invalidates stale geometry.boundingBox and blocks line at z = 10',
        );

        // Replace position attribute at version === 0 moving box back to z = 50..54, then back to z = 8..12
        const highPositions = new Float32Array(shiftedPositions.length);
        for (let i = 0; i < shiftedPositions.length; i += 3) {
            highPositions[i] = shiftedPositions[i];
            highPositions[i + 1] = shiftedPositions[i + 1];
            highPositions[i + 2] = shiftedPositions[i + 2] + 42;
        }
        boxGeo.setAttribute('position', new THREE.Float32BufferAttribute(highPositions, 3));
        boxGeo.boundingSphere = null;
        assert.equal(
            linePassesMeshClearance({ x: -5, y: 0, z: 10 }, { x: 5, y: 0, z: 10 }, 'model-edit', 0.8),
            true,
            'setAttribute(position) at version 0 updates world box back to z = 50..54',
        );

        boxGeo.setAttribute('position', new THREE.Float32BufferAttribute(shiftedPositions, 3));
        boxGeo.boundingSphere = null;
        assert.equal(
            linePassesMeshClearance({ x: -5, y: 0, z: 10 }, { x: 5, y: 0, z: 10 }, 'model-edit', 0.8),
            false,
            'setAttribute(position) at version 0 updates world box back to z = 8..12 and blocks line',
        );
    } finally {
        clearMeshesForAutoBrace();
    }
});


