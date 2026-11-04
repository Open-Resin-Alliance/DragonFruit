import assert from 'node:assert/strict';
import test from 'node:test';

import { clearHistory, redo, undo } from '../../history/historyStore';
import { registerSupportHistoryHandlers } from '../history/useSupportHistoryHandlers';
import { addRoot, addSupportEntityWithHistory, getSnapshot, resetStore, subscribe } from '../state';
import type { Roots, Trunk } from '../types';

const root = {
    id: 'root-1',
    modelId: 'model-1',
    transform: { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
    diameter: 2,
    diskHeight: 0.5,
    coneHeight: 1,
} as Roots;

const trunk = {
    id: 'trunk-1',
    typeId: 'trunk',
    modelId: 'model-1',
    rootId: root.id,
    baseDiameterMm: 1,
    segments: [{
        id: 'seg-1',
        diameter: 1,
        bottomJoint: { id: 'j-1', pos: { x: 0, y: 0, z: 1.5 }, diameter: 1.1 },
        topJoint: { id: 'j-2', pos: { x: 0, y: 0, z: 10 }, diameter: 1.1 },
    }],
} as unknown as Trunk;

/**
 * Places a trunk the way its placement controller does.
 *
 * Through the real adder, so the payload is the one the app records rather
 * than one written here: a hand-built payload cannot drift from the cascade.
 */
function placeTrunk(): void {
    addRoot(root);
    addSupportEntityWithHistory('trunk', trunk);
}

/** What each store notification would show a renderer. */
function framesDuring(act: () => void): string[] {
    const frames: string[] = [];
    const unsubscribe = subscribe(() => {
        const state = getSnapshot();
        frames.push(`roots=${Object.keys(state.roots).length} trunks=${Object.keys(state.trunks).length}`);
    });
    try {
        act();
    } finally {
        unsubscribe();
    }
    return frames;
}

test('redoing a placed trunk never shows its root without its shaft', () => {
    const unregister = registerSupportHistoryHandlers();
    try {
        resetStore();
        clearHistory();
        placeTrunk();
        undo();

        // One frame, both back: a root restored on its own draws a bare cone.
        assert.deepEqual(framesDuring(redo), ['roots=1 trunks=1']);
    } finally {
        unregister();
        resetStore();
        clearHistory();
    }
});
