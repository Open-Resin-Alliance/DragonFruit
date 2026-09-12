import assert from 'node:assert/strict';
import { updateSupportEntity } from '../supportTypeRegistry';
import test from 'node:test';

import { clearHistory, undo } from '../../history/historyStore';
import { pushSupportHistory } from '../history/supportHistory';
import { SUPPORT_UPDATE_TRUNK, removeAction } from '../history/actionTypes';
import { pushSupportEditHistory, captureSupportEditSnapshot } from '../history/supportEditHistory';
import { registerSupportHistoryHandlers } from '../history/useSupportHistoryHandlers';
import { resetStore, getSnapshot, setSnapshot, removeTrunk, removeBranch, addRoot, addTrunk, resetKickstandsInState } from '../state';
import type { SupportState, Trunk, Roots, Segment, Branch } from '../types';

function emptySnapshot(): SupportState {
    return {
        roots: {}, trunks: {}, branches: {}, leaves: {}, twigs: {}, sticks: {},
        braces: {}, anchors: {}, kickstands: {}, knots: {},
        selectedId: null, selectedCategory: null, hoveredId: null, hoveredCategory: 'none', interactionWarning: null,
    };
}

function seedTrunk(id: string, segmentId: string, jointPos: { x: number; y: number; z: number }): void {
    const root: Roots = {
        id: `root-${id}`,
        modelId: 'model-a',
        transform: { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
        diameter: 3,
        diskHeight: 0.5,
        coneHeight: 0.5,
    };
    const segments: Segment[] = [
        {
            id: segmentId,
            diameter: 1,
            bottomJoint: { id: `bottom-${id}`, pos: { x: 0, y: 0, z: 0 }, diameter: 1.2 },
            topJoint: { id: `top-${id}`, pos: jointPos, diameter: 1.2 },
        },
    ];
    const trunk: Trunk = { id, modelId: 'model-a', rootId: root.id, segments };
    const snapshot = emptySnapshot();
    snapshot.roots[root.id] = root;
    snapshot.trunks[id] = trunk;
    setSnapshot(snapshot);
}


test('undo restores a moved trunk joint (SUPPORT_UPDATE_TRUNK)', () => {
    resetStore();
    resetKickstandsInState();
    clearHistory();
    const dispose = registerSupportHistoryHandlers();

    seedTrunk('t1', 's1', { x: 0, y: 0, z: 10 });
    const before = structuredClone(getSnapshot().trunks.t1);
    // Move the top joint.
    const moved: Trunk = {
        ...before,
        segments: before.segments.map((s) => ({
            ...s,
            topJoint: s.topJoint ? { ...s.topJoint, pos: { x: 5, y: 0, z: 12 } } : s.topJoint,
        })),
    };
    updateSupportEntity('trunk', moved);
    pushSupportHistory({ type: SUPPORT_UPDATE_TRUNK, payload: { before, after: moved } });

    assert.equal(getSnapshot().trunks.t1.segments[0].topJoint?.pos.x, 5, 'joint moved before undo');

    undo();

    const restored = getSnapshot().trunks.t1;
    assert.equal(restored.segments[0].topJoint?.pos.x, 0, 'joint x restored');
    assert.equal(restored.segments[0].topJoint?.pos.z, 10, 'joint z restored');
    dispose();
});


test('undo restores a branch-joint move pushed via pushSupportEditHistory (deferred flush)', async () => {
    resetStore();
    resetKickstandsInState();
    clearHistory();
    const dispose = registerSupportHistoryHandlers();

    seedTrunk('t1', 's1', { x: 0, y: 0, z: 10 });
    const before = captureSupportEditSnapshot();

    // Simulate the branch-joint drag: mutate the trunk joint
    // then push the edit history exactly like useJointInteraction does.
    const moved: Trunk = {
        ...getSnapshot().trunks.t1,
        segments: getSnapshot().trunks.t1.segments.map((s) => ({
            ...s,
            topJoint: s.topJoint ? { ...s.topJoint, pos: { x: 5, y: 0, z: 12 } } : s.topJoint,
        })),
    };
    updateSupportEntity('trunk', moved);
    pushSupportEditHistory('Move branch joint', before, captureSupportEditSnapshot());

    // The push is deferred to idle; wait for the flush (setTimeout fallback).
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(getSnapshot().trunks.t1.segments[0].topJoint?.pos.x, 5, 'joint moved before undo');

    undo();

    assert.equal(getSnapshot().trunks.t1.segments[0].topJoint?.pos.x, 0, 'joint restored after undo');
    dispose();
});

test('undo preserves selection when the moved support still exists', () => {
    resetStore();
    resetKickstandsInState();
    clearHistory();
    const dispose = registerSupportHistoryHandlers();

    seedTrunk('t1', 's1', { x: 0, y: 0, z: 10 });
    // Select the trunk (and its joint) as the user would after dragging a joint.
    const withSelection: SupportState = {
        ...getSnapshot(),
        selectedId: 'top-t1',
        selectedCategory: 'joint',
    };
    setSnapshot(withSelection);

    const before = structuredClone(getSnapshot().trunks.t1);
    const moved: Trunk = {
        ...before,
        segments: before.segments.map((s) => ({
            ...s,
            topJoint: s.topJoint ? { ...s.topJoint, pos: { x: 5, y: 0, z: 12 } } : s.topJoint,
        })),
    };
    updateSupportEntity('trunk', moved);
    pushSupportHistory({ type: SUPPORT_UPDATE_TRUNK, payload: { before, after: moved } });

    undo();

    const after = getSnapshot();
    assert.equal(after.trunks.t1.segments[0].topJoint?.pos.x, 0, 'joint restored after undo');
    assert.equal(after.selectedId, 'top-t1', 'joint selection survives undo');
    assert.equal(after.selectedCategory, 'joint', 'joint selection category survives undo');
    dispose();
});

test('undo clears a selection that points at a removed entity', () => {
    resetStore();
    resetKickstandsInState();
    clearHistory();
    const dispose = registerSupportHistoryHandlers();

    seedTrunk('t1', 's1', { x: 0, y: 0, z: 10 });
    setSnapshot({ ...getSnapshot(), selectedId: 'ghost-trunk', selectedCategory: 'trunk' });

    const before = structuredClone(getSnapshot().trunks.t1);
    const moved: Trunk = {
        ...before,
        segments: before.segments.map((s) => ({
            ...s,
            topJoint: s.topJoint ? { ...s.topJoint, pos: { x: 5, y: 0, z: 12 } } : s.topJoint,
        })),
    };
    updateSupportEntity('trunk', moved);
    pushSupportHistory({ type: SUPPORT_UPDATE_TRUNK, payload: { before, after: moved } });

    undo();

    const after = getSnapshot();
    assert.equal(after.selectedId, null, 'stale selection cleared');
    dispose();
});

