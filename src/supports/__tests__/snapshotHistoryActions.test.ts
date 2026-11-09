import assert from 'node:assert/strict';
import test from 'node:test';

import { clearHistory, redo, undo } from '../../history/historyStore';
import {
    SUPPORT_AUTO_BRACE_REPLACE,
    SUPPORT_AUTO_PLACE,
    SUPPORT_EDIT_REPLACE,
    SUPPORT_MULTI_DELETE,
} from '../history/actionTypes';
import { pushSupportHistory } from '../history/supportHistory';
import { registerSupportHistoryHandlers } from '../history/useSupportHistoryHandlers';
import { addRoot, addSupportEntity, getSnapshot, removeSupportEntity, resetStore } from '../state';

/** Actions whose payload is a before/after state pair. */
const SNAPSHOT_ACTIONS = [
    SUPPORT_EDIT_REPLACE,
    SUPPORT_MULTI_DELETE,
    SUPPORT_AUTO_BRACE_REPLACE,
    SUPPORT_AUTO_PLACE,
] as const;

test('every snapshot action restores its before state and replays its after', () => {
    const unregister = registerSupportHistoryHandlers();
    try {
        for (const type of SNAPSHOT_ACTIONS) {
            resetStore();
            clearHistory();
            addRoot({
                id: 'root-1', modelId: 'model-1',
                transform: { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
                diameter: 2, diskHeight: 0.5, coneHeight: 1,
            });
            addSupportEntity('trunk', {
                id: 'trunk-1', modelId: 'model-1', rootId: 'root-1',
                segments: [{ id: 'seg-1', diameter: 1 }],
            });

            const before = getSnapshot();
            removeSupportEntity('trunk', 'trunk-1');
            const after = getSnapshot();
            pushSupportHistory({ type, payload: { before, after } });

            undo();
            assert.equal(Object.keys(getSnapshot().trunks).length, 1, `${type}: undo restores the trunk`);
            redo();
            assert.equal(Object.keys(getSnapshot().trunks).length, 0, `${type}: redo removes it again`);
        }
    } finally {
        unregister();
        resetStore();
        clearHistory();
    }
});
