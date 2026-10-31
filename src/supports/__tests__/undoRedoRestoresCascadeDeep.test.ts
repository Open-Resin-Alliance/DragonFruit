import assert from 'node:assert/strict';
import test from 'node:test';

import { clearHistory, redo, undo } from '../../history/historyStore';
import { removeSupportEntityWithPayload } from '../history/removalPayload';
import { registerSupportHistoryHandlers } from '../history/useSupportHistoryHandlers';
import { pushSupportHistory } from '../history/supportHistory';
import { addKnot, addRoot, addSupportEntity, getSnapshot, resetStore } from '../state';
import { knotHostId, SUPPORT_COLLECTION_KEYS, SUPPORT_TYPES } from '../supportTypeRegistry';
import type { SupportTypeId } from '../supportTypeRegistry';
import type { SupportState } from '../types';

/**
 * A removal's history entry, replayed end to end: every collection the cascade
 * drains comes back on undo and goes again on redo. The fixture attaches one of
 * every type that can depend on the seed, so an omitted collection fails here.
 */

const MODEL = 'model-1';
const joint = (id: string, z: number) => ({ id, pos: { x: 0, y: 0, z }, diameter: 1 });
const segment = (id: string, bottomZ: number, topZ: number) => ({
    id,
    type: 'straight',
    diameter: 1,
    bottomJoint: joint(`${id}-bottom`, bottomZ),
    topJoint: joint(`${id}-top`, topZ),
});
const cone = (id: string, z: number) => ({
    id,
    pos: { x: 0, y: 0, z },
    normal: { x: 0, y: 0, z: -1 },
    profile: { type: 'cone', bodyDiameterMm: 1, contactDiameterMm: 0.4, lengthMm: 1 },
});
const disk = (id: string, z: number) => ({
    id,
    pos: { x: 0, y: 0, z },
    surfaceNormal: { x: 0, y: 0, z: -1 },
    coneAxis: { x: 0, y: 0, z: 1 },
    profile: { type: 'disk', diskThicknessMm: 0.2, maxStandoffMm: 0.5, standoffAngleThreshold: 0.7, contactDiameterMm: 0.4 },
    contactDiameterMm: 0.4,
});
const root = (id: string) => ({
    id,
    modelId: MODEL,
    transform: { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
    diameter: 3,
    diskHeight: 0.5,
    coneHeight: 1.5,
});
const knot = (id: string, parentShaftId: string, z: number, t = z / 10, diameter = 1 + 0.125) => ({
    id,
    parentShaftId,
    t,
    pos: { x: 0, y: 0, z },
    diameter,
});

/** The collections only, cloned, so two store states compare outright. */
function collections(): Record<string, unknown> {
    const state = getSnapshot() as unknown as SupportState;
    const out: Record<string, unknown> = {};
    for (const key of SUPPORT_COLLECTION_KEYS) {
        out[key] = structuredClone(state[key]);
    }
    return out;
}

const KICKSTAND_PROFILE = { bodyDiameterMm: 1, terminalStartDiameterMm: 1, terminalEndDiameterMm: 1 };

/**
 * Builds the seed and every type that can depend on it.
 *
 * A shafted seed gets one branch, leaf, brace and kickstand on its segment. A
 * leaf gets a brace snapped to its cone; a brace gets a kickstand on its span.
 */
function buildFixture(seedTypeId: SupportTypeId): { seedId: string; seedDescriptor: (typeof SUPPORT_TYPES)[number] } {
    resetStore();
    const seedDescriptor = SUPPORT_TYPES.find((descriptor) => descriptor.id === seedTypeId)!;

    addRoot(root('root-base'));
    addSupportEntity('trunk', {
        id: 'base',
        modelId: MODEL,
        rootId: 'root-base',
        segments: [segment('base-seg', 0, 10)],
        contactCone: cone('base-cone', 12),
    });

    const parentKnotId = 'seed-parent-knot';
    if (seedTypeId !== 'trunk') {
        addKnot(knot(parentKnotId, 'base-seg', 3) as never);
    }

    const seedId = seedTypeId === 'trunk' ? 'base' : `seed-${seedTypeId}`;
    const addSeed = (entity: Record<string, unknown>) => addSupportEntity(seedTypeId, entity as never);

    switch (seedTypeId) {
        case 'trunk':
            break;
        case 'branch':
            addSeed({
                id: seedId, modelId: MODEL, parentKnotId,
                segments: [segment(`${seedId}-seg`, 0, 10)],
                contactCone: cone(`${seedId}-cone`, 7),
            });
            break;
        case 'leaf':
            addSeed({ id: seedId, modelId: MODEL, parentKnotId, contactCone: cone(`${seedId}-cone`, 6) });
            break;
        case 'twig':
            addSeed({
                id: seedId, modelId: MODEL,
                segments: [segment(`${seedId}-seg`, 0, 10)],
                contactDiskA: disk(`${seedId}-disk-a`, 0),
                contactDiskB: disk(`${seedId}-disk-b`, 5),
            });
            break;
        case 'stick':
            addSeed({
                id: seedId, modelId: MODEL,
                segments: [segment(`${seedId}-seg`, 0, 10)],
                contactConeA: cone(`${seedId}-cone-a`, 0),
                contactConeB: cone(`${seedId}-cone-b`, 5),
            });
            break;
        case 'brace':
            addKnot(knot(`${seedId}-start`, 'base-seg', 6, 0.6) as never);
            addKnot(knot(`${seedId}-end`, 'base-seg', 8, 0.8) as never);
            addSeed({
                id: seedId, modelId: MODEL,
                startKnotId: `${seedId}-start`, endKnotId: `${seedId}-end`,
                profile: { diameter: 1 },
            });
            break;
        case 'stump':
            addSeed({
                id: seedId, modelId: MODEL,
                rootPos: { x: 0, y: 0, z: 0 }, rootBaseDiameter: 2, rootTopDiameter: 1, rootHeight: 1,
                joint: joint(`${seedId}-joint`, 0.5),
                segments: [segment(`${seedId}-seg`, 0.5, 10)],
                contactCone: cone(`${seedId}-cone`, 6),
            });
            break;
        case 'kickstand':
            addRoot(root(`root-${seedId}`));
            addSeed({
                id: seedId, modelId: MODEL,
                rootId: `root-${seedId}`, hostKnotId: parentKnotId, hostSegmentId: 'base-seg', hostMinT: 0,
                segments: [segment(`${seedId}-seg`, 0, 10)],
                profile: KICKSTAND_PROFILE,
            });
            break;
    }

    const addBranchOnKnot = (parentKnot: string) => {
        addSupportEntity('branch', {
            id: 'dep-branch', modelId: MODEL, parentKnotId: parentKnot,
            segments: [segment('dep-branch-seg', 0, 3)],
            contactCone: cone('dep-branch-cone', 4),
        });
    };
    const addBranch = (parentKnot: string) => {
        addKnot(knot('dep-branch-knot', parentKnot, 4) as never);
        addSupportEntity('branch', {
            id: 'dep-branch', modelId: MODEL, parentKnotId: 'dep-branch-knot',
            segments: [segment('dep-branch-seg', 0, 3)],
            contactCone: cone('dep-branch-cone', 4),
        });
    };
    const addLeaf = (parentKnot: string) => {
        addKnot(knot('dep-leaf-knot', parentKnot, 5) as never);
        addSupportEntity('leaf', {
            id: 'dep-leaf', modelId: MODEL, parentKnotId: 'dep-leaf-knot',
            contactCone: cone('dep-leaf-cone', 6),
        });
    };
    const addBrace = (startKnot: string, endKnot: string) => {
        addSupportEntity('brace', {
            id: 'dep-brace', modelId: MODEL,
            startKnotId: startKnot, endKnotId: endKnot,
            profile: { diameter: 1 },
        });
    };
    const addKickstand = (hostKnot: string, hostSegment: string) => {
        addRoot(root('root-dep-kick'));
        addSupportEntity('kickstand', {
            id: 'dep-kick', modelId: MODEL,
            rootId: 'root-dep-kick', hostKnotId: hostKnot, hostSegmentId: hostSegment, hostMinT: 0,
            segments: [segment('dep-kick-seg', 0, 3)],
            profile: KICKSTAND_PROFILE,
        });
    };

    if (seedDescriptor.hasSegments) {
        const segmentId = `${seedId}-seg`;
        addBranch(segmentId);
        addLeaf(segmentId);
        addKnot(knot('dep-brace-start', segmentId, 6) as never);
        addKnot(knot('dep-brace-end', segmentId, 7) as never);
        addBrace('dep-brace-start', 'dep-brace-end');
        addKnot(knot('dep-kick-knot', segmentId, 8) as never);
        addKickstand('dep-kick-knot', segmentId);
    } else if (seedTypeId === 'leaf') {
        // The parent knot stays because another support still hangs from it.
        addBranchOnKnot(parentKnotId);
        // A brace snapped to the leaf's cone; its kickstand rides the brace span.
        addKnot(knot('dep-brace-start', knotHostId('leaf', seedId), 5.4, 0.6, 0.86) as never);
        addKnot(knot('dep-brace-end', 'base-seg', 8, 0.8) as never);
        addBrace('dep-brace-start', 'dep-brace-end');
        addKickstand('dep-brace-start', knotHostId('brace', 'dep-brace'));
    } else if (seedTypeId === 'brace') {
        addKickstand(`${seedId}-start`, knotHostId('brace', seedId));
        // A knot riding the span hosts supports of its own; the two named slots
        // hold the brace's own knots, so this one has to travel separately.
        addKnot(knot('dep-span-knot', knotHostId('brace', seedId), 7, 0.5, 0.9) as never);
        addSupportEntity('branch', {
            id: 'dep-span-branch', modelId: MODEL, parentKnotId: 'dep-span-knot',
            segments: [segment('dep-span-branch-seg', 0, 3)],
            contactCone: cone('dep-span-branch-cone', 8),
        });
        addSupportEntity('leaf', {
            id: 'dep-span-leaf', modelId: MODEL, parentKnotId: 'dep-span-knot',
            contactCone: cone('dep-span-leaf-cone', 7.5),
        });
    }

    return { seedId, seedDescriptor };
}

test('a leaf records the knot it hung from, not one riding its cone', () => {
    // The slot is singular, so a cascade reaching a second knot would take it;
    // the slot reads the type's declared host field, the rest travel as a list.
    resetStore();
    try {
        addRoot(root('root-base'));
        addSupportEntity('trunk', {
            id: 'base', modelId: MODEL, rootId: 'root-base',
            segments: [segment('base-seg', 0, 10)], contactCone: cone('base-cone', 12),
        });
        addKnot(knot('parent-knot', 'base-seg', 3) as never);
        addSupportEntity('leaf', {
            id: 'leaf-1', modelId: MODEL, parentKnotId: 'parent-knot',
            contactCone: cone('leaf-1-cone', 6),
        });
        addKnot(knot('cone-knot', knotHostId('leaf', 'leaf-1'), 5.8, 0.8, 0.8) as never);

        const removed = removeSupportEntityWithPayload('leaf', 'leaf-1');
        assert.ok(removed);
        assert.equal((removed.payload.knot as { id: string }).id, 'parent-knot');
        assert.deepEqual(
            (removed.payload.knots as { id: string }[]).map((entry) => entry.id),
            ['cone-knot'],
        );
    } finally {
        resetStore();
    }
});

test('a brace removal names each knot slot after the seed field it mirrors', () => {
    const { seedId } = buildFixture('brace');
    try {
        const removed = removeSupportEntityWithPayload('brace', seedId);
        assert.ok(removed, 'the brace was removed');
        assert.equal(
            (removed.payload.startKnot as { id: string }).id,
            `${seedId}-start`,
            'startKnot holds the seed start knot',
        );
        assert.equal(
            (removed.payload.endKnot as { id: string }).id,
            `${seedId}-end`,
            'endKnot holds the seed end knot',
        );
    } finally {
        resetStore();
    }
});

test('every type restores the full cascade its removal drains', () => {
    const unregister = registerSupportHistoryHandlers();
    try {
        for (const descriptor of SUPPORT_TYPES) {
            const { seedId } = buildFixture(descriptor.id);
            clearHistory();

            const before = collections();
            const removed = removeSupportEntityWithPayload(descriptor.id, seedId);
            assert.ok(removed, `${descriptor.id}: the seed was removed`);
            pushSupportHistory({
                type: descriptor.historyRemove,
                payload: removed.payload,
            } as never);
            const afterRemoval = collections();
            assert.notDeepEqual(afterRemoval, before, `${descriptor.id}: the removal changed the store`);

            undo();
            assert.deepEqual(collections(), before, `${descriptor.id}: undo restores every collection`);

            redo();
            assert.deepEqual(collections(), afterRemoval, `${descriptor.id}: redo removes them again`);
        }
    } finally {
        unregister();
        resetStore();
        clearHistory();
    }
});
