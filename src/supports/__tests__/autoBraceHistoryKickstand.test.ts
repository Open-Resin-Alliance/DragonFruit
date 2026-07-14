import assert from 'node:assert/strict';
import test from 'node:test';

import { clearHistory, registerHistoryHandler, undo } from '../../history/historyStore';
import { SUPPORT_AUTO_BRACE_REPLACE } from '../history/actionTypes';
import { runAutoBracing } from '../autoBracing/autoBrace';
import { resetStore, setSnapshot } from '../state';
import { getKickstandSnapshot, resetKickstandStore } from '../SupportTypes/Kickstand/kickstandStore';
import type { Roots, SupportState, Trunk } from '../types';

function createRoot(id: string, modelId: string, x: number): Roots {
    return {
        id,
        modelId,
        transform: {
            pos: { x, y: 0, z: 0 },
            rot: { x: 0, y: 0, z: 0, w: 1 },
        },
        diameter: 3,
        diskHeight: 0.5,
        coneHeight: 0.5,
    };
}

function createTrunk(id: string, modelId: string, rootId: string, segmentId: string, x: number): Trunk {
    return {
        id,
        modelId,
        rootId,
        segments: [
            {
                id: segmentId,
                diameter: 1,
                topJoint: {
                    id: `joint-${id}`,
                    pos: { x, y: 0, z: 10 },
                    diameter: 1.2,
                },
            },
        ],
    };
}

function seedLadderSnapshot(): void {
    const modelId = 'model-a';
    const snapshot: SupportState = {
        roots: {},
        trunks: {},
        branches: {},
        leaves: {},
        twigs: {},
        sticks: {},
        braces: {},
        anchors: {},
        knots: {},
        selectedId: null,
        selectedCategory: null,
        hoveredId: null,
        hoveredCategory: 'none',
        interactionWarning: null,
    };

    for (const [i, x] of [0, 2, 4].entries()) {
        const root = createRoot(`root-${i}`, modelId, x);
        const trunk = createTrunk(`trunk-${i}`, modelId, root.id, `seg-${i}`, x);
        snapshot.roots[root.id] = root;
        snapshot.trunks[trunk.id] = trunk;
    }

    setSnapshot(snapshot);
}

test('runAutoBracing records kickstand snapshots so undo can restore the kickstand store', () => {
    resetStore();
    resetKickstandStore();
    clearHistory();
    seedLadderSnapshot();

    const captured: Array<{ type: string; payload?: unknown }> = [];
    const unregister = registerHistoryHandler(SUPPORT_AUTO_BRACE_REPLACE, (action) => {
        captured.push(action);
        return true;
    });

    try {
        const kickstandBeforeRun = structuredClone(getKickstandSnapshot());
        const result = runAutoBracing();
        assert.equal(result.changed, true, 'ladder setup must generate braces for this test to be meaningful');
        const kickstandAfterRun = structuredClone(getKickstandSnapshot());

        undo();

        assert.equal(captured.length, 1, 'undo must dispatch the auto-brace history action');
        const payload = captured[0].payload as {
            kickstandBefore?: unknown;
            kickstandAfter?: unknown;
        };

        assert.ok(payload.kickstandBefore, 'SUPPORT_AUTO_BRACE_REPLACE payload must carry kickstandBefore');
        assert.ok(payload.kickstandAfter, 'SUPPORT_AUTO_BRACE_REPLACE payload must carry kickstandAfter');
        assert.deepEqual(payload.kickstandBefore, kickstandBeforeRun);
        assert.deepEqual(payload.kickstandAfter, kickstandAfterRun);
    } finally {
        unregister();
        clearHistory();
        resetStore();
        resetKickstandStore();
    }
});
