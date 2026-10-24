import assert from 'node:assert/strict';
import test from 'node:test';

import { clearHistory, redo, undo } from '../../history/historyStore';
import { SUPPORT_EDIT_REPLACE } from '../history/actionTypes';
import { removeJointWithPayload } from '../history/jointRemovalPayload';
import { pushSupportHistory } from '../history/supportHistory';
import { registerSupportHistoryHandlers } from '../history/useSupportHistoryHandlers';
import { addKnot, addRoot, addSupportEntity, getSnapshot, resetStore } from '../state';
import type { Segment } from '../types';

/**
 * A joint removal on a type with no update action must still be undoable: the
 * snapshot is captured before the removal rebinds the knots it touches.
 */

const MODEL = 'model-1';
const joint = (id: string, z: number) => ({ id, pos: { x: 0, y: 0, z }, diameter: 1 });
const segment = (id: string, bottomZ: number, topZ: number): Segment => ({
    id,
    type: 'straight',
    diameter: 1,
    bottomJoint: joint(`${id}-bottom`, bottomZ),
    topJoint: joint(`${id}-top`, topZ),
});
const root = (id: string) => ({
    id,
    modelId: MODEL,
    transform: { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
    diameter: 3,
    diskHeight: 0.5,
    coneHeight: 1.5,
});

function seedKickstand(): void {
    resetStore();
    addRoot(root('root-kick'));
    addKnot({
        id: 'host-knot', parentShaftId: 'base-seg', t: 0.5,
        pos: { x: 0, y: 0, z: 5 }, diameter: 1.125,
    });
    addSupportEntity('kickstand', {
        id: 'kick', modelId: MODEL,
        rootId: 'root-kick', hostKnotId: 'host-knot', hostSegmentId: 'base-seg', hostMinT: 0,
        segments: [segment('seg-1', 0, 5), segment('seg-2', 5, 10)],
        profile: { bodyDiameterMm: 1, terminalStartDiameterMm: 1, terminalEndDiameterMm: 1 },
    });
    addKnot({
        id: 'span-knot', parentShaftId: 'seg-2', t: 0.5,
        pos: { x: 0, y: 0, z: 7.5 }, diameter: 1.125,
    });
}

const kickstandSegments = () =>
    (getSnapshot().kickstands.kick as unknown as { segments: Segment[] }).segments.length;

test('a kickstand joint removal records a snapshot that undo restores', () => {
    const unregister = registerSupportHistoryHandlers();
    try {
        seedKickstand();
        clearHistory();
        assert.equal(kickstandSegments(), 2);

        const resolved = removeJointWithPayload('seg-1-top');
        assert.ok(resolved, 'the joint was found');
        assert.equal(resolved.typeId, 'kickstand');
        assert.ok(resolved.snapshot, 'a type without an update action reports a snapshot');

        pushSupportHistory({ type: SUPPORT_EDIT_REPLACE, payload: resolved.snapshot });
        assert.equal(kickstandSegments(), 1, 'the removal merged the segments');
        assert.equal(getSnapshot().knots['span-knot'].parentShaftId, 'seg-1', 'the knot was rebound');

        undo();
        assert.equal(kickstandSegments(), 2, 'undo restores the segment');
        assert.equal(getSnapshot().knots['span-knot'].parentShaftId, 'seg-2', 'undo restores the knot host');

        redo();
        assert.equal(kickstandSegments(), 1, 'redo merges them again');
        assert.equal(getSnapshot().knots['span-knot'].parentShaftId, 'seg-1');
    } finally {
        unregister();
        resetStore();
        clearHistory();
    }
});
