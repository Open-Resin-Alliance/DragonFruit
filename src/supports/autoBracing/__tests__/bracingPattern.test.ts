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
