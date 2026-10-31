import assert from 'node:assert/strict';
import test from 'node:test';

import { getSnapshot, resetStore, setSnapshot } from '../state';
import { clearBracesForModel } from '../autoBracing/autoBrace';
import { registerSupportHistoryHandlers } from '../history/useSupportHistoryHandlers';
import { clearHistory, getUndoCount } from '@/history/historyStore';
import type { Brace, Kickstand, Knot, Roots, SupportState } from '../types';

function emptySnapshot(): SupportState {
    return {
        roots: {}, trunks: {}, branches: {}, leaves: {}, twigs: {},
        sticks: {}, braces: {}, anchors: {}, kickstands: {}, knots: {},
        selectedId: null, hoveredId: null,
    } as unknown as SupportState;
}

function brace(id: string, modelId: string, startKnotId: string, endKnotId: string): Brace {
    return {
        id, typeId: 'brace', modelId,
        startKnotId, endKnotId,
        profile: { diameter: 0.5 },
    } as unknown as Brace;
}

function knot(id: string): Knot {
    return { id, pos: { x: 0, y: 0, z: 0 }, parentShaftId: 'seg', t: 0.5 } as unknown as Knot;
}

function kickstand(id: string, modelId: string, rootId: string, hostKnotId: string): Kickstand {
    return {
        id, typeId: 'kickstand', modelId,
        rootId, hostKnotId, hostSegmentId: 'seg', hostMinT: 0.5,
        segments: [], profile: { bodyDiameterMm: 1, terminalStartDiameterMm: 1, terminalEndDiameterMm: 1 },
    } as unknown as Kickstand;
}

function root(id: string, modelId: string): Roots {
    return {
        id, typeId: 'roots', modelId,
        transform: { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
        diameter: 3, diskHeight: 0.5, coneHeight: 1.5,
    } as unknown as Roots;
}

/**
 * Clear All is one write and one undo step for the whole sweep: the sweep goes
 * through the cascading store call per brace (so a brace's knots go with it),
 * and the history payload is a before/after pair rather than one entry per
 * brace.
 */
test('clear all removes one model’s braces and their knots, as one history step', () => {
    resetStore();
    const snapshot = emptySnapshot();
    snapshot.braces['brace-a'] = brace('brace-a', 'model-a', 'knot-a1', 'knot-a2');
    snapshot.braces['brace-b'] = brace('brace-b', 'model-b', 'knot-b1', 'knot-b2');
    snapshot.kickstands['ks-a'] = kickstand('ks-a', 'model-a', 'root-ks-a', 'knot-a1');
    snapshot.kickstands['ks-b'] = kickstand('ks-b', 'model-b', 'root-ks-b', 'knot-b1');
    snapshot.roots['root-ks-a'] = root('root-ks-a', 'model-a');
    snapshot.roots['root-ks-b'] = root('root-ks-b', 'model-b');
    snapshot.knots['knot-a1'] = knot('knot-a1');
    snapshot.knots['knot-a2'] = knot('knot-a2');
    snapshot.knots['knot-b1'] = knot('knot-b1');
    snapshot.knots['knot-b2'] = knot('knot-b2');
    setSnapshot(snapshot);

    registerSupportHistoryHandlers();
    clearHistory();

    const removed = clearBracesForModel('model-a');
    assert.equal(removed, 2, 'one brace and one kickstand');

    const after = getSnapshot();
    assert.deepEqual(Object.keys(after.braces), ['brace-b'], 'only the other model keeps its brace');
    assert.deepEqual(Object.keys(after.kickstands), ['ks-b'], 'only the other model keeps its kickstand');
    assert.ok(!after.roots['root-ks-a'], 'the kickstand’s root went with it');
    assert.ok(after.roots['root-ks-b'], 'the other model’s kickstand root stayed');
    assert.ok(!after.knots['knot-a1'] && !after.knots['knot-a2'], 'the brace’s knots went with it');
    assert.ok(after.knots['knot-b1'] && after.knots['knot-b2'], 'the other model’s knots stayed');

    assert.equal(getUndoCount(), 1, 'one entry, not one per brace');
});

test('clear all on a model without braces is a no-op', () => {
    resetStore();
    const snapshot = emptySnapshot();
    snapshot.braces['brace-a'] = brace('brace-a', 'model-a', 'knot-a1', 'knot-a2');
    snapshot.kickstands['ks-a'] = kickstand('ks-a', 'model-a', 'root-ks-a', 'knot-a1');
    snapshot.roots['root-ks-a'] = root('root-ks-a', 'model-a');
    snapshot.knots['knot-a1'] = knot('knot-a1');
    snapshot.knots['knot-a2'] = knot('knot-a2');
    setSnapshot(snapshot);
    clearHistory();

    assert.equal(clearBracesForModel('model-b'), 0);
    assert.equal(clearBracesForModel(null), 0);
    assert.deepEqual(Object.keys(getSnapshot().braces), ['brace-a']);
    assert.deepEqual(Object.keys(getSnapshot().kickstands), ['ks-a']);
});
