import assert from 'node:assert/strict';
import test from 'node:test';

import { getSnapshot, loadFromImportFormat, mergeFromImportFormat, resetStore } from '../state';
import { collectOwnedRootIds } from '../supportTypeRegistry';
import type { DragonfruitImportFormat } from '../types';

function root(id: string, x: number) {
    return {
        id,
        modelId: 'model-1',
        transform: { pos: { x, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
        diameter: 2,
        diskHeight: 0.5,
        coneHeight: 1,
    };
}

/** A file carrying one trunk, plus however many roots are named. */
function payload(rootIds: string[], claimed: string): DragonfruitImportFormat {
    return {
        roots: rootIds.map((id, index) => root(id, index * 5)),
        trunks: [{
            id: 'trunk-1',
            modelId: 'model-1',
            rootId: claimed,
            segments: [{
                id: 'seg-1',
                diameter: 1,
                topJoint: { id: 'j-1', pos: { x: 0, y: 0, z: 10 }, diameter: 1.1 },
            }],
        }],
        branches: [], leaves: [], twigs: [], sticks: [], braces: [], knots: [], kickstands: [], stumps: [],
    } as unknown as DragonfruitImportFormat;
}

/** Roots in the store that no entity claims. */
function unclaimedRootIds(): string[] {
    const state = getSnapshot();
    const owned = collectOwnedRootIds(state);
    return Object.keys(state.roots).filter((id) => !owned.has(id));
}

test('loading a file drops a root no entity claims', () => {
    resetStore();
    loadFromImportFormat(payload(['root-owned', 'root-orphan'], 'root-owned'));

    assert.deepEqual(unclaimedRootIds(), []);
    assert.ok(getSnapshot().roots['root-owned'], 'the claimed root survives');
    resetStore();
});

test('merging a file drops a root no entity claims', () => {
    resetStore();
    mergeFromImportFormat(payload(['root-owned', 'root-orphan'], 'root-owned'));

    assert.deepEqual(unclaimedRootIds(), []);
    resetStore();
});
