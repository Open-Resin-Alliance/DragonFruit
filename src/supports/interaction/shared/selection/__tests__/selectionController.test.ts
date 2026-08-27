import assert from 'node:assert/strict';
import test from 'node:test';

import { clearHistory, getUndoCount, undo } from '@/history/historyStore';
import { captureSupportEditSnapshot, pushSupportEditHistory } from '@/supports/history/supportEditHistory';
import { registerSupportHistoryHandlers } from '@/supports/history/useSupportHistoryHandlers';
import { handleContactDiskClick, handleSupportClick } from '@/supports/interaction/clickHandlers';
import { applySettingsToSelectedSupports } from '@/supports/Settings/applySettingsToSelectedSupports';
import { createDefaultSettings } from '@/supports/Settings/types';
import type { Roots, SupportState, Trunk } from '@/supports/types';
import {
    getSnapshot,
    resetStore,
    setSnapshot,
} from '@/supports/state';
import {
    clearSupportSelection,
    getResolvedPrimarySelection,
    selectSupportById,
} from '../selectionController';

function makeTrunk(id: string): Trunk {
    return {
        id,
        modelId: 'model-a',
        rootId: `root-${id}`,
        segments: [],
    };
}

function makeRoot(trunkId: string): Roots {
    return {
        id: `root-${trunkId}`,
        modelId: 'model-a',
        transform: {
            pos: { x: 0, y: 0, z: 0 },
            rot: { x: 0, y: 0, z: 0, w: 1 },
        },
        diameter: 3,
        diskHeight: 0.5,
        coneHeight: 0.5,
    };
}

function seedTrunks(...ids: string[]) {
    const snapshot: SupportState = {
        roots: Object.fromEntries(ids.map((id) => [`root-${id}`, makeRoot(id)])),
        trunks: Object.fromEntries(ids.map((id) => [id, makeTrunk(id)])),
        branches: {},
        leaves: {},
        twigs: {},
        sticks: {},
        braces: {},
        anchors: {},
        knots: {},
        selectedId: null,
        hoveredId: null,
        selectedCategory: null,
        hoveredCategory: 'none',
        interactionWarning: null,
    };
    setSnapshot(snapshot);
}

test('Shift-click adds a support and keeps it as the editable representative', () => {
    resetStore();
    clearSupportSelection();
    seedTrunks('trunk-a', 'trunk-b');

    selectSupportById('trunk-a', false);
    selectSupportById('trunk-b', true);

    const selection = getResolvedPrimarySelection();
    assert.deepEqual(selection.selectedIds, ['trunk-a', 'trunk-b']);
    assert.equal(selection.selectedId, 'trunk-b');
    assert.equal(selection.selectedCategory, 'trunk');

    clearSupportSelection();
    resetStore();
});

test('normal click replaces the selection set with the clicked support', () => {
    resetStore();
    clearSupportSelection();
    seedTrunks('trunk-a', 'trunk-b');

    selectSupportById('trunk-a', false);
    selectSupportById('trunk-b', true);
    selectSupportById('trunk-a', false);

    const selection = getResolvedPrimarySelection();
    assert.deepEqual(selection.selectedIds, ['trunk-a']);
    assert.equal(selection.selectedId, 'trunk-a');
    assert.equal(selection.selectedCategory, 'trunk');

    clearSupportSelection();
    resetStore();
});

test('a settings edit changes every Shift-click-selected support in one undo step', async () => {
    resetStore();
    clearSupportSelection();
    clearHistory();
    seedTrunks('trunk-a', 'trunk-b');
    const unregisterHistory = registerSupportHistoryHandlers();

    try {
        selectSupportById('trunk-a', false);
        selectSupportById('trunk-b', true);

        const before = captureSupportEditSnapshot();
        const settings = createDefaultSettings();
        settings.shaft.diameterMm = 2.75;

        applySettingsToSelectedSupports(settings);

        const after = captureSupportEditSnapshot();
        pushSupportEditHistory('Adjust selected support settings', before, after);
        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.equal(getSnapshot().trunks['trunk-a'].baseDiameterMm, 2.75);
        assert.equal(getSnapshot().trunks['trunk-b'].baseDiameterMm, 2.75);
        assert.equal(getUndoCount(), 1);

        undo();
        assert.equal(getSnapshot().trunks['trunk-a'].baseDiameterMm, undefined);
        assert.equal(getSnapshot().trunks['trunk-b'].baseDiameterMm, undefined);
    } finally {
        unregisterHistory();
        clearHistory();
        clearSupportSelection();
        resetStore();
    }
});

test('Shift-clicking a selected support removes only that support from the selection set', () => {
    resetStore();
    clearSupportSelection();
    seedTrunks('trunk-a', 'trunk-b');

    selectSupportById('trunk-a', false);
    selectSupportById('trunk-b', true);
    selectSupportById('trunk-b', true);

    const selection = getResolvedPrimarySelection();
    assert.deepEqual(selection.selectedIds, ['trunk-a']);
    assert.equal(selection.selectedId, 'trunk-a');
    assert.equal(selection.selectedCategory, 'trunk');

    clearSupportSelection();
    resetStore();
});

test('Shift-click on a selected primitive defers to the parent support toggle', () => {
    resetStore();
    clearSupportSelection();
    seedTrunks('trunk-a', 'trunk-b');

    selectSupportById('trunk-a', false);
    selectSupportById('trunk-b', true);

    let propagationStopped = false;
    handleContactDiskClick({
        stopPropagation: () => { propagationStopped = true; },
        nativeEvent: {
            shiftKey: true,
            stopPropagation: () => { propagationStopped = true; },
            stopImmediatePropagation: () => { propagationStopped = true; },
        },
    }, 'contact-disk-b', true, true, false);

    assert.equal(propagationStopped, false);
    assert.deepEqual(getResolvedPrimarySelection().selectedIds, ['trunk-a', 'trunk-b']);

    clearSupportSelection();
    resetStore();
});

test('normal click exits a selection set before Shift starts a new set', () => {
    resetStore();
    clearSupportSelection();
    seedTrunks('trunk-a', 'trunk-b', 'trunk-c');

    selectSupportById('trunk-a', false);
    selectSupportById('trunk-b', true);

    let propagationStopped = false;
    const normalClickEvent = {
        stopPropagation: () => { propagationStopped = true; },
        nativeEvent: {
            shiftKey: false,
            stopPropagation: () => { propagationStopped = true; },
            stopImmediatePropagation: () => { propagationStopped = true; },
        },
    };
    handleContactDiskClick(normalClickEvent, 'contact-disk-a', true, true, false);
    assert.equal(propagationStopped, false);
    handleSupportClick(normalClickEvent, 'trunk-a', true);

    handleSupportClick({
        stopPropagation: () => undefined,
        nativeEvent: {
            shiftKey: true,
            stopPropagation: () => undefined,
            stopImmediatePropagation: () => undefined,
        },
    }, 'trunk-c', true);

    const selection = getResolvedPrimarySelection();
    assert.deepEqual(selection.selectedIds, ['trunk-a', 'trunk-c']);
    assert.equal(selection.selectedId, 'trunk-c');
    assert.equal(selection.selectedCategory, 'trunk');

    clearSupportSelection();
    resetStore();
});