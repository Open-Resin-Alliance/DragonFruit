import assert from 'node:assert/strict';
import test from 'node:test';

import { computeSupportAndRaftResinMl } from '../supportResinVolume';
import { DEFAULT_RAFT_SETTINGS } from '@/supports/Rafts/Crenelated/RaftDefaults';
import { createEmptySupportCollections } from '@/supports/supportTypeRegistry';
import type { Roots, SupportCollections, Trunk } from '@/supports/types';

const RAFT_OFF = { ...DEFAULT_RAFT_SETTINGS, bottomMode: 'off' as const };

function createRoot(id: string, modelId: string, x: number): Roots {
    return {
        id,
        modelId,
        transform: { pos: { x, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
        diameter: 3,
        diskHeight: 0.5,
        coneHeight: 0.5,
    };
}

function createTrunk(id: string, modelId: string, rootId: string, x: number, topZ: number): Trunk {
    return {
        id,
        typeId: 'trunk',
        modelId,
        rootId,
        segments: [{ id: `seg-${id}`, diameter: 1, topJoint: { id: `joint-${id}`, pos: { x, y: 0, z: topZ }, diameter: 1.2 } }],
    };
}

function supportsWith(...entities: Array<Roots | Trunk>): SupportCollections {
    const state = createEmptySupportCollections();
    for (const entity of entities) {
        if ('typeId' in entity) state.trunks[entity.id] = entity;
        else state.roots[entity.id] = entity;
    }
    return state;
}

/** Disk + cone frustum + cap sphere of a root, as the estimate builds it. */
function rootMl(diameter: number, diskHeight: number, coneHeight: number, topDiameter: number): number {
    const r = diameter / 2;
    const top = topDiameter / 2;
    const disk = Math.PI * r * r * diskHeight;
    const cone = (Math.PI * coneHeight / 3) * (r * r + r * top + top * top);
    const cap = (4 / 3) * Math.PI * top * top * top;
    return (disk + cone + cap) / 1000;
}

test('no visible models means no support resin', () => {
    const ml = computeSupportAndRaftResinMl({
        supportState: supportsWith(createRoot('r', 'm', 0)),
        raftSettings: RAFT_OFF,
        visibleModelIds: new Set(),
        plateModels: [],
    });
    assert.equal(ml, 0);
});

test('a lone root counts its disk, cone and cap', () => {
    const ml = computeSupportAndRaftResinMl({
        supportState: supportsWith(createRoot('r', 'm', 0)),
        raftSettings: RAFT_OFF,
        visibleModelIds: new Set(['m']),
        plateModels: [],
    });
    // Without a trunk the cone tapers to 35 % of the root diameter.
    assert.ok(Math.abs(ml - rootMl(3, 0.5, 0.5, 3 * 0.35)) < 1e-9, `got ${ml}`);
});

test('a trunk adds its shaft and narrows the root cone to the shaft', () => {
    const ml = computeSupportAndRaftResinMl({
        supportState: supportsWith(createRoot('r', 'm', 0), createTrunk('t', 'm', 'r', 0, 10)),
        raftSettings: RAFT_OFF,
        visibleModelIds: new Set(['m']),
        plateModels: [],
    });
    const root = rootMl(3, 0.5, 0.5, 1); // cone tapers to the 1 mm shaft
    const shaftUpperBound = (Math.PI * 0.5 * 0.5 * 10) / 1000; // 1 mm shaft, at most 10 mm long
    assert.ok(ml > root, `shaft adds resin, got ${ml}`);
    assert.ok(ml <= root + shaftUpperBound + 1e-9, `got ${ml}`);
});

test('supports of hidden models do not count', () => {
    const state = supportsWith(createRoot('a', 'shown', 0), createRoot('b', 'hidden', 10));
    const ml = computeSupportAndRaftResinMl({
        supportState: state,
        raftSettings: RAFT_OFF,
        visibleModelIds: new Set(['shown']),
        plateModels: [],
    });
    assert.ok(Math.abs(ml - rootMl(3, 0.5, 0.5, 3 * 0.35)) < 1e-9, `got ${ml}`);
});

test('a solid raft adds resin under the roots', () => {
    const state = supportsWith(createRoot('r', 'm', 0));
    const args = { supportState: state, visibleModelIds: new Set(['m']), plateModels: [] };
    const without = computeSupportAndRaftResinMl({ ...args, raftSettings: RAFT_OFF });
    const withRaft = computeSupportAndRaftResinMl({ ...args, raftSettings: DEFAULT_RAFT_SETTINGS });
    assert.ok(withRaft > without, `raft ${withRaft} vs ${without}`);
});
