import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { collectFanShaftPoints, fanLeafToHost } from '../autoSupport/autoPlace';
import { getSnapshot, resetStore, resetKickstandsInState } from '../state';
import { setSettings } from '../Settings/state';
import { createDefaultSettings } from '../Settings/types';
import { initializeBVH } from '@/utils/bvh';
import { buildTrunkData } from '../SupportTypes/Trunk/trunkBuilder';

/** The four gates a fanning leaf passes through, tested at the function itself. */

const MODEL = 'model-a';

/** A real built trunk plus the shaft-sample pool the loop would hand the fan. */
function scenario() {
    resetStore();
    resetKickstandsInState();
    initializeBVH();
    const settings = createDefaultSettings();
    settings.grid.enabled = false;
    setSettings(settings);

    const { root, trunk } = buildTrunkData({
        tipPos: new THREE.Vector3(0, 0, 40),
        tipNormal: new THREE.Vector3(0, 0, 1),
        modelId: MODEL,
    });

    const base = getSnapshot() as unknown as Record<string, Record<string, unknown>>;
    const state = {
        ...base,
        roots: { ...base.roots, [root.id]: root },
        trunks: { ...base.trunks, [trunk.id]: trunk },
    } as never;

    const points = collectFanShaftPoints(state);
    assert.ok(points.length > 0, 'a built trunk must offer shaft samples');
    return { state, points, trunkId: (trunk as unknown as { id: string }).id };
}

/** 8mm reach, 45° from vertical — wide gates, so each failure is deliberate. */
function fan(state: unknown, points: unknown, target: THREE.Vector3) {
    return fanLeafToHost(
        { x: target.x, y: target.y, z: target.z },
        MODEL,
        points as never,
        new Set<string>(),
        'fan-test',
        8,
        2.5,
        45,
        12,
        state as never,
        undefined,
    );
}

test('a target beside the shaft, in reach and shallow, fans onto it', () => {
    const { state, points, trunkId } = scenario();
    const result = fan(state, points, new THREE.Vector3(2, 0, 34));

    assert.equal(result.ok, true, `expected a leaf, got ${JSON.stringify(result)}`);
    if (result.ok) {
        assert.equal(result.hostId, trunkId, 'it attaches to the trunk that was there');
    }
});

test('beyond the radius the answer is noHost, not a distant leaf', () => {
    const { state, points } = scenario();
    const result = fan(state, points, new THREE.Vector3(30, 0, 34));

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'noHost');
});

/**
 * One sample, at a chosen place. Isolation matters here: the fan takes the
 * STEEPEST valid sample, so a scene with several samples reports whichever
 * failure the LAST one hit — a real trunk has samples the target can reach
 * legally, which silently swallows the gate under test.
 */
function singleSampleAt(points: unknown, pos: { x: number; y: number; z: number }) {
    const [template] = points as Array<Record<string, unknown>>;
    return [{ ...template, pos }];
}

test('a target level with its only shaft sample is refused as sameZ', () => {
    const { state, points } = scenario();
    const pool = singleSampleAt(points, { x: 1, y: 0, z: 34 });
    const result = fan(state, pool, new THREE.Vector3(1, 0, 34));

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'sameZ');
});

test('a sample just above the target is sameZ too — a leaf may not hang down', () => {
    const { state, points } = scenario();
    const pool = singleSampleAt(points, { x: 1, y: 0, z: 34.2 });
    const result = fan(state, pool, new THREE.Vector3(1, 0, 34));

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'sameZ');
});

test('a too-steep LEAF is refused as angle', () => {
    const { state, points } = scenario();
    // 5mm out, only 0.5mm up: 84° from vertical, far outside a 45° cone.
    // The span is deliberately kept under MAX_LEAF_SPAN_BEFORE_BRANCH_MM —
    // a longer one takes the BRANCH path, which has its own angle gate further
    // down, and the leaf gate under test would then never be the thing refusing.
    const pool = singleSampleAt(points, { x: 0, y: 0, z: 34 });
    const result = fan(state, pool, new THREE.Vector3(5, 0, 34.5));

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'angle');
});

test('a too-steep BRANCH is refused as angle too — the span decides which gate runs', () => {
    const { state, points } = scenario();
    // Past the span limit (so the branch path runs) but inside the cone that
    // gate 1 measures, so gate 1 passes it through and the DEPARTURE angle is
    // what refuses. Pushing it further out just trips gate 1 instead.
    const pool = singleSampleAt(points, { x: 0, y: 0, z: 30 });
    const result = fan(state, pool, new THREE.Vector3(5, 0, 35.1));

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'angle');
});

test('a sample in reach at a legal angle is accepted, so the gates above are not blanket refusals', () => {
    const { state, points } = scenario();
    const pool = singleSampleAt(points, { x: 0, y: 0, z: 30 });
    const result = fan(state, pool, new THREE.Vector3(2, 0, 34));

    assert.equal(result.ok, true, `expected a leaf, got ${JSON.stringify(result)}`);
});

test('the grid-host radius is stricter than the island-host radius', () => {
    const { state, points, trunkId } = scenario();
    // Same target, but the host is declared a GRID host: 2.5mm instead of 8mm.
    const result = fanLeafToHost(
        { x: 4, y: 0, z: 34 },
        MODEL,
        points as never,
        new Set([trunkId]),
        'fan-test',
        8,
        2.5,
        45,
        12,
        state as never,
        undefined,
    );

    assert.equal(result.ok, false, 'a grid host must not accept a 4mm fan');
    if (!result.ok) assert.equal(result.reason, 'noHost');
});
