import assert from 'node:assert/strict';
import test from 'node:test';

import { applyInitialPattern } from '../initialPattern';
import { applyRepeatingPattern } from '../repeatingPattern';
import { runZigZagChain } from '../zigzagChain';

test('singleDiagonal always runs a to b', () => {
    const calls: Array<[string, string, string]> = [];
    applyInitialPattern(
        [{ a: 'a', b: 'b' }, { a: 'c', b: 'd' }],
        'singleDiagonal',
        (low, high, section) => { calls.push([low, high, section]); },
    );
    assert.deepEqual(calls, [
        ['a', 'b', 'initial'],
        ['c', 'd', 'initial'],
    ]);
});

test('crossDiagonal places both directions', () => {
    const calls: Array<[string, string]> = [];
    applyRepeatingPattern(
        [{ a: 'a', b: 'b' }],
        'crossDiagonal',
        (low, high) => { calls.push([low, high]); },
    );
    assert.deepEqual(new Set(calls.map(([l, h]) => `${l}>${h}`)), new Set(['a>b', 'b>a']));
});

test('zigzag chain links end to start while climbing', () => {
    const calls: Array<[string, string, string, number]> = [];
    runZigZagChain(
        [{ a: 'a', b: 'b', hDist: 5 }],
        2,
        30,
        'initial',
        (low, high, section, atZ) => { calls.push([low, high, section, atZ]); },
    );
    // a@2→b@7, b@7→a@12, a@12→b@17, ...: each link starts where the
    // previous ended, alternating ends, first link initial.
    assert.deepEqual(calls.slice(0, 3), [
        ['a', 'b', 'initial', 2],
        ['b', 'a', 'repeating', 7],
        ['a', 'b', 'repeating', 12],
    ]);
    assert.ok(calls.length > 3 && calls.length < 200, 'climbs until maxZ');
    for (let i = 1; i < calls.length; i++) {
        assert.equal(calls[i][0], calls[i - 1][1], `link ${i} starts at link ${i - 1} end`);
        assert.equal(calls[i][3], calls[i - 1][3] + 5, `link ${i} rises one span`);
    }
});

test('zigzag chain mirrors start end per edge and stops at maxZ', () => {
    const calls: Array<[string, string, number]> = [];
    runZigZagChain(
        [
            { a: 'a', b: 'b', hDist: 5 },
            { a: 'c', b: 'd', hDist: 5 },
        ],
        2,
        10,
        'initial',
        (low, high, _section, atZ) => { calls.push([low, high, atZ]); },
    );
    assert.deepEqual(calls, [
        ['a', 'b', 2],
        ['b', 'a', 7],
        ['d', 'c', 2],
        ['c', 'd', 7],
    ]);
});

test('zigzag chain skips zero-span edges', () => {
    const calls: Array<[string, string]> = [];
    runZigZagChain(
        [{ a: 'a', b: 'b', hDist: 0 }],
        2,
        30,
        'initial',
        (low, high) => { calls.push([low, high]); },
    );
    assert.equal(calls.length, 0);
});

test('zigzag chain will not pack a short span tighter than the minimum rise', () => {
    const zs: number[] = [];
    runZigZagChain(
        [{ a: 'a', b: 'b', hDist: 0.4 }],
        2,
        42,
        'initial',
        (low, high, section, atZ) => { zs.push(atZ); },
    );
    // Rising by the span (0.4mm) would have stacked ~100 near-parallel stubs
    // in this height — the ultra-dense ladder seen on close supports.
    assert.ok(zs.length <= 41, `expected a bounded link count, got ${zs.length}`);
    for (let i = 1; i < zs.length; i++) {
        assert.equal(zs[i] - zs[i - 1], 1, 'climbs the minimum rise, not the span');
    }
});

test('a span just above the floor keeps its own rise', () => {
    const zs: number[] = [];
    runZigZagChain(
        [{ a: 'a', b: 'b', hDist: 1.5 }],
        2,
        11,
        'initial',
        (low, high, section, atZ) => { zs.push(atZ); },
    );
    // Only spans below the floor are steepened — 1.5mm still rises 1.5mm.
    assert.deepEqual(zs, [2, 3.5, 5, 6.5, 8, 9.5]);
});

import { buildAutoBracedSnapshot } from '../autoBrace';
import { createDefaultAutoBracingSettings } from '../settings';
import { createEmptySupportCollections } from '../../supportTypeRegistry';
import type { Branch, Roots, SupportState, Trunk } from '../../types';

function makeRoot(id: string, modelId: string, x: number, y: number): Roots {
    return {
        id,
        modelId,
        transform: { pos: { x, y, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
        diameter: 3,
        diskHeight: 0.5,
        coneHeight: 0.5,
    };
}

function makeTrunk(id: string, modelId: string, rootId: string, x: number, y: number, topZ: number): Trunk {
    return {
        id,
        typeId: 'trunk',
        modelId,
        rootId,
        segments: [
            {
                id: `seg-${id}`,
                diameter: 1,
                topJoint: { id: `joint-${id}`, pos: { x, y, z: topZ }, diameter: 1.2 },
            },
        ],
    };
}

function makeEmptySnapshot(): SupportState {
    return {
        ...createEmptySupportCollections(),
        selectedId: null,
        selectedCategory: null,
        hoveredId: null,
        hoveredCategory: 'none',
        interactionWarning: null,
    };
}

test('buildAutoBracedSnapshot with initialPattern zigZag does not superimpose repeatingPattern crossDiagonal ladder tiers', () => {
    const snapshot = makeEmptySnapshot();
    const modelId = 'model-zz';
    const coords: Array<[string, number, number]> = [
        ['a', 0, 0],
        ['b', 4, 0],
        ['c', 0, 4],
    ];
    for (const [id, x, y] of coords) {
        snapshot.roots[`r-${id}`] = makeRoot(`r-${id}`, modelId, x, y);
        snapshot.trunks[`t-${id}`] = makeTrunk(`t-${id}`, modelId, `r-${id}`, x, y, 30);
    }

    // Add a manual brace (generatedBy omitted) to verify removedBraceCount === 0 and preservation
    snapshot.knots['manual-k1'] = {
        id: 'manual-k1',
        parentShaftId: 'seg-a',
        t: 0.1,
        pos: { x: 0, y: 0, z: 3 },
        diameter: 1.1,
    };
    snapshot.knots['manual-k2'] = {
        id: 'manual-k2',
        parentShaftId: 'seg-b',
        t: 0.1,
        pos: { x: 4, y: 0, z: 3 },
        diameter: 1.1,
    };
    snapshot.braces['manual-brace'] = {
        id: 'manual-brace',
        modelId,
        startKnotId: 'manual-k1',
        endKnotId: 'manual-k2',
        profile: { diameter: 0.8 },
    };

    const baseSettings = {
        ...createDefaultAutoBracingSettings(),
        initialDistanceMm: 2,
        patternIntervalMm: 7, // Repeating ladder tiers would land at z = 9, 16, 23 (distinct from 4mm-rise zigzag z = 2, 6, 10, 14, 18, 22, 26)
    };

    const withCrossRepeating = buildAutoBracedSnapshot(snapshot, {
        ...baseSettings,
        initialPattern: 'zigZag',
        repeatingPattern: 'crossDiagonal',
    });
    const withSingleRepeating = buildAutoBracedSnapshot(snapshot, {
        ...baseSettings,
        initialPattern: 'zigZag',
        repeatingPattern: 'singleDiagonal',
    });
    const withZigZagRepeating = buildAutoBracedSnapshot(snapshot, {
        ...baseSettings,
        initialPattern: 'zigZag',
        repeatingPattern: 'zigZag',
    });

    assert.equal(withCrossRepeating.removedBraceCount, 0, 'Manual brace without generatedBy must not be counted as removed');
    assert.ok(withCrossRepeating.snapshot.braces['manual-brace'], 'Manual brace must be preserved');
    assert.equal(
        withCrossRepeating.generatedBraceCount,
        withZigZagRepeating.generatedBraceCount,
        `Expected zero superimposed crossDiagonal tiers when initialPattern is zigZag (got ${withCrossRepeating.generatedBraceCount} vs ${withZigZagRepeating.generatedBraceCount})`,
    );
    assert.equal(
        withSingleRepeating.generatedBraceCount,
        withZigZagRepeating.generatedBraceCount,
        `Expected zero superimposed singleDiagonal tiers when initialPattern is zigZag (got ${withSingleRepeating.generatedBraceCount} vs ${withZigZagRepeating.generatedBraceCount})`,
    );

    const autoBraces = Object.values(withCrossRepeating.snapshot.braces).filter((b) => b.generatedBy === 'autoBracing');
    for (const brace of autoBraces) {
        const lowZ = Math.min(
            withCrossRepeating.snapshot.knots[brace.startKnotId]!.pos.z,
            withCrossRepeating.snapshot.knots[brace.endKnotId]!.pos.z,
        );
        for (const forbiddenLadderZ of [9, 16, 23]) {
            assert.ok(
                Math.abs(lowZ - forbiddenLadderZ) > 0.25,
                `Found superimposed repeating ladder brace starting at z=${lowZ} (tier ${forbiddenLadderZ})`,
            );
        }
    }
});

test('buildAutoBracedSnapshot reports changed === true when removing stale auto-generated kickstands or adding new kickstands', () => {
    // 1) Stale auto-generated kickstand on < 3 short trunks where 0 new braces/kickstands are generated
    const staleSnapshot = makeEmptySnapshot();
    const modelId = 'model-stale-ks';
    staleSnapshot.roots['r-1'] = makeRoot('r-1', modelId, 0, 0);
    staleSnapshot.roots['r-2'] = makeRoot('r-2', modelId, 4, 0);
    staleSnapshot.trunks['t-1'] = makeTrunk('t-1', modelId, 'r-1', 0, 0, 10);
    staleSnapshot.trunks['t-2'] = makeTrunk('t-2', modelId, 'r-2', 4, 0, 10);

    staleSnapshot.roots['ks-root-stale'] = makeRoot('ks-root-stale', modelId, 0, 4);
    staleSnapshot.knots['ks-knot-stale'] = {
        id: 'ks-knot-stale',
        parentShaftId: 'seg-1',
        t: 0.8,
        pos: { x: 0, y: 0, z: 8 },
        diameter: 1.2,
    };
    staleSnapshot.kickstands['ks-stale'] = {
        id: 'ks-stale',
        typeId: 'kickstand',
        modelId,
        rootId: 'ks-root-stale',
        hostKnotId: 'ks-knot-stale',
        hostSegmentId: 'seg-1',
        hostMinT: 0,
        generatedBy: 'autoBracing',
        segments: [
            {
                id: 'seg-ks-stale',
                diameter: 1,
                bottomJoint: { id: 'j-ks-stale', pos: { x: 0, y: 4, z: 1 }, diameter: 1.1 },
            },
        ],
        profile: { bodyDiameterMm: 1, terminalStartDiameterMm: 1, terminalEndDiameterMm: 1 },
    };

    const stripped = buildAutoBracedSnapshot(staleSnapshot, createDefaultAutoBracingSettings());
    assert.equal(Object.keys(stripped.snapshot.kickstands).length, 0, 'Expected stale auto-generated kickstand to be removed');
    assert.equal(stripped.generatedBraceCount, 0, 'Short <3 trunks should not receive new braces');
    assert.equal(stripped.removedBraceCount, 0);
    assert.equal(stripped.changed, true, 'Expected changed === true when stale auto-generated kickstand was removed');

    // 2) Adding new kickstands when initialDistanceMm is above trunk height (0 ladder braces, 2 new kickstands)
    const addKsSnapshot = makeEmptySnapshot();
    addKsSnapshot.roots['r-tall'] = makeRoot('r-tall', 'model-new-ks', 0, 0);
    addKsSnapshot.trunks['t-tall'] = makeTrunk('t-tall', 'model-new-ks', 'r-tall', 0, 0, 20);
    const added = buildAutoBracedSnapshot(addKsSnapshot, {
        ...createDefaultAutoBracingSettings(),
        initialDistanceMm: 25,
    });
    assert.equal(Object.keys(added.snapshot.kickstands).length, 2, 'Expected 2 kickstands to be added');
    assert.equal(added.generatedBraceCount, 0);
    assert.equal(added.changed, true, 'Expected changed === true when new kickstands are added');
});

test('buildAutoBracedSnapshot post-ladder reconciliation drops redundant generated kickstands and keeps changed false when 0 braces, removals, or surviving kickstands occur', () => {
    const snapshot = makeEmptySnapshot();
    const modelId = 'model-reconcile-ks';
    snapshot.roots['r-tall'] = makeRoot('r-tall', modelId, 0, 0);
    snapshot.trunks['t-tall'] = makeTrunk('t-tall', modelId, 'r-tall', 0, 0, 25);

    const makeOrthogonalBranch = (id: string, x: number, y: number): Branch => ({
        id,
        typeId: 'branch',
        modelId,
        parentKnotId: `k-${id}`,
        segments: [
            {
                id: `seg-${id}-0`,
                diameter: 1,
                topJoint: { id: `j-${id}-0`, pos: { x, y, z: 1.2 }, diameter: 1.2 },
            },
            {
                id: `seg-${id}-1`,
                diameter: 1,
                topJoint: { id: `j-${id}-1`, pos: { x, y, z: 25 }, diameter: 1.2 },
            },
        ],
    });
    snapshot.knots['k-bx'] = { id: 'k-bx', parentShaftId: 'seg-t-tall', t: 0.05, pos: { x: 0, y: 0, z: 1.5 }, diameter: 1.2 };
    snapshot.knots['k-by'] = { id: 'k-by', parentShaftId: 'seg-t-tall', t: 0.05, pos: { x: 0, y: 0, z: 1.5 }, diameter: 1.2 };
    snapshot.branches['bx'] = makeOrthogonalBranch('bx', 4, 0);
    snapshot.branches['by'] = makeOrthogonalBranch('by', 0, 4);

    // Without ladder braces (initialDistanceMm above maxZ), the 2 preliminary kickstands remain
    const unreconciled = buildAutoBracedSnapshot(snapshot, {
        ...createDefaultAutoBracingSettings(),
        initialDistanceMm: 30,
    });
    assert.equal(Object.keys(unreconciled.snapshot.kickstands).length, 2, 'Preliminary pass generates 2 kickstands before ladder braces');

    // With ladder braces across both orthogonal branches, post-ladder reconciliation drops all generated kickstands
    const reconciled = buildAutoBracedSnapshot(snapshot, createDefaultAutoBracingSettings());
    assert.equal(Object.keys(reconciled.snapshot.kickstands).length, 0, 'Expected redundant generated kickstands to be dropped by post-ladder reconciliation');
    assert.deepEqual(Object.keys(reconciled.snapshot.roots), ['r-tall'], 'Dropped kickstands must not leave orphaned roots');

    // When 0 braces, 0 removals, and 0 surviving kickstands occur, changed remains false
    const noopSnapshot = makeEmptySnapshot();
    for (const [i, id] of ['a', 'b', 'c'].entries()) {
        noopSnapshot.roots[`r-${id}`] = makeRoot(`r-${id}`, 'model-noop', i * 3, 0);
        noopSnapshot.trunks[`t-${id}`] = makeTrunk(`t-${id}`, 'model-noop', `r-${id}`, i * 3, 0, 10);
    }
    const noopResult = buildAutoBracedSnapshot(noopSnapshot, {
        ...createDefaultAutoBracingSettings(),
        initialDistanceMm: 15,
    });
    assert.equal(noopResult.generatedBraceCount, 0);
    assert.equal(noopResult.removedBraceCount, 0);
    assert.equal(Object.keys(noopResult.snapshot.kickstands).length, 0);
    assert.equal(noopResult.changed, false, 'Expected changed === false when 0 braces, removals, and surviving kickstands occur');
});


