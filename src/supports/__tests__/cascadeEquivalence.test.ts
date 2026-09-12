import assert from 'node:assert/strict';
import test from 'node:test';

import { collectCascade, type EntityRef } from '../supportCascade';
import { SUPPORT_COLLECTION_KEYS } from '../supportTypeRegistry';
import type { SupportState } from '../types';

/**
 * The cascade's reachable set, pinned across graph shapes.
 *
 * `collectCascade` is about to swap a re-scanning fixpoint for a worklist. The
 * traversal order changes; the set must not. The goldens cover the shapes real
 * scenes produce -- these cover the awkward ones: deep chains, shared hosts,
 * cycles through braces, and orphans.
 */

const seg = (id: string) => ({
    id,
    diameter: 1,
    bottomJoint: { id: `${id}-bj`, pos: { x: 0, y: 0, z: 0 }, diameter: 1 },
    topJoint: { id: `${id}-tj`, pos: { x: 0, y: 0, z: 4 }, diameter: 1 },
});

/** An empty collection per key, so a fixture only declares what it uses. */
function emptyState(): SupportState {
    const state = {} as Record<string, Record<string, unknown>>;
    for (const key of SUPPORT_COLLECTION_KEYS) state[key] = {};
    return state as unknown as SupportState;
}

function build(parts: Partial<Record<string, Record<string, unknown>>>): SupportState {
    return { ...emptyState(), ...parts } as unknown as SupportState;
}

const sorted = (set: ReadonlySet<string>) => [...set].sort();

/** trunk -> knot -> branch -> knot -> branch ... `depth` levels deep. */
function chain(depth: number) {
    const trunks: Record<string, unknown> = {
        'trunk-0': { id: 'trunk-0', modelId: 'm', rootId: 'root-0', segments: [seg('seg-t0')] },
    };
    const roots = { 'root-0': { id: 'root-0', modelId: 'm' } };
    const branches: Record<string, unknown> = {};
    const knots: Record<string, unknown> = {};

    let shaft = 'seg-t0';
    for (let i = 0; i < depth; i++) {
        knots[`knot-${i}`] = { id: `knot-${i}`, parentShaftId: shaft };
        branches[`branch-${i}`] = {
            id: `branch-${i}`, modelId: 'm', parentKnotId: `knot-${i}`, segments: [seg(`seg-b${i}`)],
        };
        shaft = `seg-b${i}`;
    }
    return build({ roots, trunks, branches, knots });
}

test('a deep chain takes everything below the seed', () => {
    for (const depth of [1, 2, 5, 12]) {
        const state = chain(depth);
        const doomed = collectCascade(state, [{ collection: 'trunks', id: 'trunk-0' }]);

        const expected = ['roots:root-0', 'trunks:trunk-0'];
        for (let i = 0; i < depth; i++) {
            expected.push(`branches:branch-${i}`, `knots:knot-${i}`);
        }
        assert.deepEqual(sorted(doomed), expected.sort(), `depth ${depth}`);
    }
});

test('removing mid-chain takes the rest of the chain, not the trunk above', () => {
    const state = chain(4);
    const doomed = collectCascade(state, [{ collection: 'branches', id: 'branch-1' }]);

    // branch-1 hangs from knot-1, which it takes (takeHost: always). Everything
    // below follows; trunk-0, root-0, branch-0 and knot-0 stay.
    assert.deepEqual(sorted(doomed), [
        'branches:branch-1', 'branches:branch-2', 'branches:branch-3',
        'knots:knot-1', 'knots:knot-2', 'knots:knot-3',
    ]);
});

test('a brace between two shafts takes only its own end knots', () => {
    const state = build({
        roots: { 'root-a': { id: 'root-a', modelId: 'm' }, 'root-b': { id: 'root-b', modelId: 'm' } },
        trunks: {
            'trunk-a': { id: 'trunk-a', modelId: 'm', rootId: 'root-a', segments: [seg('seg-a')] },
            'trunk-b': { id: 'trunk-b', modelId: 'm', rootId: 'root-b', segments: [seg('seg-b')] },
        },
        knots: {
            'knot-a': { id: 'knot-a', parentShaftId: 'seg-a' },
            'knot-b': { id: 'knot-b', parentShaftId: 'seg-b' },
        },
        braces: { 'brace-a': { id: 'brace-a', modelId: 'm', startKnotId: 'knot-a', endKnotId: 'knot-b' } },
    });

    const doomed = collectCascade(state, [{ collection: 'braces', id: 'brace-a' }]);
    assert.deepEqual(sorted(doomed), ['braces:brace-a', 'knots:knot-a', 'knots:knot-b']);
});

test('removing a trunk takes the brace hanging off it but not the far trunk', () => {
    const state = build({
        roots: { 'root-a': { id: 'root-a', modelId: 'm' }, 'root-b': { id: 'root-b', modelId: 'm' } },
        trunks: {
            'trunk-a': { id: 'trunk-a', modelId: 'm', rootId: 'root-a', segments: [seg('seg-a')] },
            'trunk-b': { id: 'trunk-b', modelId: 'm', rootId: 'root-b', segments: [seg('seg-b')] },
        },
        knots: {
            'knot-a': { id: 'knot-a', parentShaftId: 'seg-a' },
            'knot-b': { id: 'knot-b', parentShaftId: 'seg-b' },
        },
        braces: { 'brace-a': { id: 'brace-a', modelId: 'm', startKnotId: 'knot-a', endKnotId: 'knot-b' } },
    });

    const doomed = collectCascade(state, [{ collection: 'trunks', id: 'trunk-a' }]);
    // knot-b survives: it sits on trunk-b's shaft, which nobody asked to remove.
    assert.deepEqual(sorted(doomed), ['braces:brace-a', 'knots:knot-a', 'roots:root-a', 'trunks:trunk-a']);
});

test('two branches sharing a knot both go when the shaft does', () => {
    const state = build({
        roots: { 'root-a': { id: 'root-a', modelId: 'm' } },
        trunks: { 'trunk-a': { id: 'trunk-a', modelId: 'm', rootId: 'root-a', segments: [seg('seg-a')] } },
        knots: { 'knot-a': { id: 'knot-a', parentShaftId: 'seg-a' } },
        branches: {
            'branch-1': { id: 'branch-1', modelId: 'm', parentKnotId: 'knot-a', segments: [seg('seg-1')] },
            'branch-2': { id: 'branch-2', modelId: 'm', parentKnotId: 'knot-a', segments: [seg('seg-2')] },
        },
    });

    const doomed = collectCascade(state, [{ collection: 'trunks', id: 'trunk-a' }]);
    assert.deepEqual(sorted(doomed), [
        'branches:branch-1', 'branches:branch-2', 'knots:knot-a', 'roots:root-a', 'trunks:trunk-a',
    ]);
});

test('a seed with no dependents returns just itself', () => {
    const state = build({ sticks: { 'stick-a': { id: 'stick-a', modelId: 'm', segments: [seg('seg-s')] } } });
    const doomed = collectCascade(state, [{ collection: 'sticks', id: 'stick-a' }]);
    assert.deepEqual(sorted(doomed), ['sticks:stick-a']);
});

test('multiple seeds union their cascades', () => {
    const state = chain(3);
    const separately = new Set([
        ...collectCascade(state, [{ collection: 'branches', id: 'branch-1' }]),
        ...collectCascade(state, [{ collection: 'branches', id: 'branch-2' }]),
    ]);
    const together = collectCascade(state, [
        { collection: 'branches', id: 'branch-1' },
        { collection: 'branches', id: 'branch-2' },
    ]);
    assert.deepEqual(sorted(together), sorted(separately));
});

test('a dangling reference does not invent an entity', () => {
    // branch-0 points at a knot that is not in the store.
    const state = build({
        branches: { 'branch-0': { id: 'branch-0', modelId: 'm', parentKnotId: 'gone', segments: [seg('seg-b')] } },
    });
    const doomed = collectCascade(state, [{ collection: 'branches', id: 'branch-0' }]);
    assert.deepEqual(sorted(doomed), ['branches:branch-0']);
});

test('the seed is always present, even when it does not exist', () => {
    const doomed = collectCascade(emptyState(), [{ collection: 'trunks', id: 'ghost' }]);
    assert.deepEqual(sorted(doomed), ['trunks:ghost']);
});

test('a cascade is deterministic regardless of seed order', () => {
    const state = chain(4);
    const seeds: EntityRef[] = [
        { collection: 'branches', id: 'branch-2' },
        { collection: 'branches', id: 'branch-0' },
    ];
    assert.deepEqual(
        sorted(collectCascade(state, seeds)),
        sorted(collectCascade(state, [...seeds].reverse())),
    );
});
