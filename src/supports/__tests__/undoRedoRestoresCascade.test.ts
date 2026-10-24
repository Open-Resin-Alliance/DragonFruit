import assert from 'node:assert/strict';
import test from 'node:test';

import { clearHistory, redo, undo } from '../../history/historyStore';
import { registerSupportHistoryHandlers } from '../history/useSupportHistoryHandlers';
import { addKnot, addRoot, addSupportEntityWithHistory, getSnapshot, resetStore } from '../state';
import { inspectSupport } from '../supportInspector';
import { cascadeExtras } from '../supportTypeRegistry';
import { SUPPORT_GRAPH_NODES, SUPPORT_TYPES } from '../supportTypeRegistry';
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
        topJoint: { id: 'j-1', pos: { x: 0, y: 0, z: 10 }, diameter: 1.1 },
    }],
} as unknown as Trunk;

/** Every collection's ids, so two snapshots can be compared outright. */
function census(): Record<string, string[]> {
    const state = getSnapshot() as unknown as Record<string, Record<string, unknown>>;
    const counts: Record<string, string[]> = {};
    for (const node of SUPPORT_GRAPH_NODES) {
        counts[node.key] = Object.keys(state[node.key] ?? {}).sort();
    }
    return counts;
}

/**
 * The trunk's unresolved links, through the same inspector the debug overlay
 * reads: a link naming a primitive the store no longer holds.
 */
function danglingLinks(): string[] {
    const inspection = inspectSupport(getSnapshot(), trunk.id);
    return (inspection?.danglingLinks ?? []).map((link) => link.field);
}

test('redo restores everything undo took', () => {
    const unregister = registerSupportHistoryHandlers();
    try {
        resetStore();
        clearHistory();
        addRoot(root);
        addSupportEntityWithHistory('trunk', trunk);

        const placed = census();
        assert.deepEqual(placed.roots, ['root-1'], 'the root is placed');

        undo();
        assert.deepEqual(census().roots, [], 'undo takes the root with the trunk');
        assert.deepEqual(census().trunks, []);

        redo();
        assert.deepEqual(census(), placed, 'redo puts back exactly what undo took');
        assert.deepEqual(danglingLinks(), [], 'no entity points at a missing primitive');
    } finally {
        unregister();
        resetStore();
        clearHistory();
    }
});

test('every placement path restores what its undo took', () => {
    const unregister = registerSupportHistoryHandlers();
    const knot = (id: string, z = 5) => ({
        id, parentShaftId: 'shaft-1', t: 0.5, pos: { x: 0, y: 0, z }, diameter: 1.1,
    });
    const segments = (id: string) => [{
        id: `seg-${id}`, diameter: 1,
        topJoint: { id: `joint-${id}`, pos: { x: 1, y: 0, z: 9 }, diameter: 1.1 },
    }];

    // Each case places the way its controller does, through the shared adder.
    const cases: Array<{ name: string; place: () => void }> = [
        {
            name: 'brace spans two knots',
            place: () => {
                addKnot(knot('knot-start') as never);
                addKnot(knot('knot-end', 7) as never);
                addSupportEntityWithHistory('brace', {
                    id: 'brace-1', modelId: 'model-1',
                    startKnotId: 'knot-start', endKnotId: 'knot-end',
                    profile: { diameter: 1 },
                } as never, { startKnot: knot('knot-start'), endKnot: knot('knot-end', 7) });
            },
        },
        {
            name: 'leaf hangs from a knot',
            place: () => {
                addKnot(knot('knot-1') as never);
                addSupportEntityWithHistory('leaf', {
                    id: 'leaf-1', modelId: 'model-1', parentKnotId: 'knot-1',
                } as never, { knot: knot('knot-1') });
            },
        },
        {
            name: 'kickstand owns a root and hosts on a knot',
            place: () => {
                addRoot(root);
                addKnot(knot('knot-1') as never);
                addSupportEntityWithHistory('kickstand', {
                    id: 'kick-1', modelId: 'model-1', rootId: root.id,
                    hostKnotId: 'knot-1', hostSegmentId: 'shaft-1', hostMinT: 0,
                    segments: segments('kick-1'),
                    profile: { bodyDiameterMm: 1, terminalStartDiameterMm: 1, terminalEndDiameterMm: 1 },
                } as never, { knots: knot('knot-1') });
            },
        },
    ];

    try {
        for (const { name, place } of cases) {
            resetStore();
            clearHistory();
            place();
            const placed = census();

            undo();
            assert.ok(
                Object.values(census()).every((ids) => ids.length === 0),
                `${name}: undo clears the scene`,
            );

            redo();
            assert.deepEqual(census(), placed, `${name}: redo puts back what undo took`);
        }
    } finally {
        unregister();
        resetStore();
        clearHistory();
    }
});

test('every type that hosts on a knot records it under its own field name', () => {
    // A leaf declares `knot`, a branch `knots`. A caller naming the wrong one
    // records nothing, and redo brings the support back with no knot under it.
    const unregister = registerSupportHistoryHandlers();
    const hostsOnKnot = SUPPORT_GRAPH_NODES.filter((node) => node.edges.some(
        (edge) => edge.to === 'knots' && edge.field === 'parentKnotId',
    ));
    assert.ok(hostsOnKnot.length > 0, 'some type hosts on a parent knot');

    try {
        for (const node of hostsOnKnot) {
            const typeId = SUPPORT_TYPES.find((d) => d.location.key === node.key)!.id;
            resetStore();
            clearHistory();

            const parentKnot = {
                id: 'knot-1', parentShaftId: 'shaft-1', t: 0.5,
                pos: { x: 0, y: 0, z: 5 }, diameter: 1.1,
            };
            addKnot(parentKnot as never);
            addSupportEntityWithHistory(typeId, {
                id: `probe-${typeId}`, modelId: 'model-1', parentKnotId: parentKnot.id,
            } as never, cascadeExtras(typeId, 'knots', [parentKnot]));

            undo();
            assert.equal(Object.keys(getSnapshot().knots).length, 0, `${typeId}: undo takes the knot`);
            redo();
            assert.equal(Object.keys(getSnapshot().knots).length, 1, `${typeId}: redo puts the knot back`);
        }
    } finally {
        unregister();
        resetStore();
        clearHistory();
    }
});
