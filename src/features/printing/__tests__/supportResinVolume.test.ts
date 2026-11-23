import assert from 'node:assert/strict';
import test from 'node:test';

import { computePlateAndSceneSupportResinMl, computeSupportAndRaftResinMl } from '../supportResinVolume';
import { DEFAULT_RAFT_SETTINGS } from '@/supports/Rafts/Crenelated/RaftDefaults';
import { computeRaftFootprintPolygons } from '@/supports/Rafts/Crenelated/geometry/computeRaftFootprint';
import { polygonSetAreaMm2 } from '@/supports/Rafts/Crenelated/geometry/polygonSet2d';
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

function supportsWith(roots: Roots[], trunks: Trunk[] = []): SupportCollections {
    const state = createEmptySupportCollections();
    for (const root of roots) state.roots[root.id] = root;
    for (const trunk of trunks) state.trunks[trunk.id] = trunk;
    return state;
}

/** Disk and cone frustum of a root, as the slicer builds it: there is no cap sphere. */
function rootMl(diameter: number, diskHeight: number, coneHeight: number, topDiameter: number): number {
    const r = Math.max(0.05, diameter / 2);
    const top = Math.max(0.05, topDiameter / 2);
    const disk = Math.PI * r * r * Math.max(0.01, diskHeight);
    const cone = (Math.PI * Math.max(0.01, coneHeight) / 3) * (r * r + r * top + top * top);
    return (disk + cone) / 1000;
}

test('no visible models means no support resin', () => {
    const ml = computeSupportAndRaftResinMl({
        supportState: supportsWith([createRoot('r', 'm', 0)]),
        raftSettings: RAFT_OFF,
        visibleModelIds: new Set(),
        plateModels: [],
    });
    assert.equal(ml, 0);
});

test('a lone root counts its disk and cone, with no cap sphere', () => {
    const ml = computeSupportAndRaftResinMl({
        supportState: supportsWith([createRoot('r', 'm', 0)]),
        raftSettings: RAFT_OFF,
        visibleModelIds: new Set(['m']),
        plateModels: [],
    });
    // Without a trunk the cone tapers to 35 % of the root diameter.
    assert.ok(Math.abs(ml - rootMl(3, 0.5, 0.5, 3 * 0.45)) < 1e-9, `got ${ml}`);
});

test('a trunk adds its shaft and narrows the root cone to the shaft', () => {
    const ml = computeSupportAndRaftResinMl({
        supportState: supportsWith([createRoot('r', 'm', 0)], [createTrunk('t', 'm', 'r', 0, 10)]),
        raftSettings: RAFT_OFF,
        visibleModelIds: new Set(['m']),
        plateModels: [],
    });
    const root = rootMl(3, 0.5, 0.5, 1); // cone tapers to the 1 mm shaft
    // The shaft runs from the root top (0.5 mm disk + 0.5 mm cone) to the joint at 10 mm.
    const shaft = (Math.PI * 0.5 * 0.5 * 9) / 1000;
    // The segment's top joint prints too, as a sphere a blend smaller than its knot.
    const jointRadius = (1.2 - 0.075) / 2;
    const joint = ((4 / 3) * Math.PI * jointRadius ** 3) / 1000;
    assert.ok(ml > root, `shaft adds resin, got ${ml}`);
    assert.ok(Math.abs(ml - (root + shaft + joint)) < 1e-9, `got ${ml}`);
});

test('supports of hidden models do not count', () => {
    const state = supportsWith([createRoot('a', 'shown', 0), createRoot('b', 'hidden', 10)]);
    const ml = computeSupportAndRaftResinMl({
        supportState: state,
        raftSettings: RAFT_OFF,
        visibleModelIds: new Set(['shown']),
        plateModels: [],
    });
    assert.ok(Math.abs(ml - rootMl(3, 0.5, 0.5, 3 * 0.45)) < 1e-9, `got ${ml}`);
});

test('a solid raft adds resin under the roots', () => {
    const state = supportsWith([createRoot('r', 'm', 0)]);
    const args = { supportState: state, visibleModelIds: new Set(['m']), plateModels: [] };
    const without = computeSupportAndRaftResinMl({ ...args, raftSettings: RAFT_OFF });
    const withRaft = computeSupportAndRaftResinMl({ ...args, raftSettings: DEFAULT_RAFT_SETTINGS });
    assert.ok(withRaft > without, `raft ${withRaft} vs ${without}`);
});

test('a plate counts its own supports; the scene figure counts every plate', () => {
    const state = supportsWith([createRoot('a', 'model-a', 0), createRoot('b', 'model-b', 20)]);
    const { activePlate, scene } = computePlateAndSceneSupportResinMl({
        supportState: state,
        raftSettings: RAFT_OFF,
        resinModelIds: new Set(['model-a', 'model-b']),
        activePlateModelIds: new Set(['model-a']),
        activePlateModels: [],
        sceneModels: [],
    });

    const oneRoot = rootMl(3, 0.5, 0.5, 3 * 0.45);
    // The root on the other plate must not reach the active plate's figure.
    assert.ok(Math.abs(activePlate - oneRoot) < 1e-9, `active plate got ${activePlate}`);
    assert.ok(Math.abs(scene - 2 * oneRoot) < 1e-9, `scene got ${scene}`);
});

test('the plate being worked on is the one whose models are in its set', () => {
    const state = supportsWith([createRoot('b', 'model-b', 20)]);
    const { activePlate, scene } = computePlateAndSceneSupportResinMl({
        supportState: state,
        raftSettings: RAFT_OFF,
        resinModelIds: new Set(['model-b']),
        activePlateModelIds: new Set(['model-a']),
        activePlateModels: [],
        sceneModels: [],
    });

    assert.equal(activePlate, 0);
    assert.ok(scene > 0, `scene got ${scene}`);
});

function createTrunkWithJoint(
    id: string,
    modelId: string,
    rootId: string,
    x: number,
    jointId: string,
): Trunk {
    const trunk = createTrunk(id, modelId, rootId, x, 10);
    return {
        ...trunk,
        segments: [{
            ...trunk.segments[0],
            topJoint: { id: jointId, pos: { x, y: 0, z: 10 }, diameter: 1.2 },
        }],
    };
}

/** A joint sphere at its printed diameter: the knot less the 0.75 blend. */
function jointMl(diameter: number): number {
    const radius = (diameter - 0.075) / 2;
    return ((4 / 3) * Math.PI * radius ** 3) / 1000;
}

test('a joint shared by two supports is printed once', () => {
    const estimate = (secondJointId: string) => computeSupportAndRaftResinMl({
        supportState: supportsWith(
            [createRoot('r1', 'm', 0), createRoot('r2', 'm', 10)],
            [
                createTrunkWithJoint('t1', 'm', 'r1', 0, 'shared'),
                createTrunkWithJoint('t2', 'm', 'r2', 10, secondJointId),
            ],
        ),
        raftSettings: RAFT_OFF,
        visibleModelIds: new Set(['m']),
        plateModels: [],
    });

    const shared = estimate('shared');
    const distinct = estimate('second');

    assert.ok(
        Math.abs(distinct - shared - jointMl(1.2)) < 1e-9,
        `shared ${shared}, distinct ${distinct}`,
    );
});

test('a brace counts the diameter its host knots give it, not its profile width', () => {
    const state = createEmptySupportCollections();
    state.knots.k1 = { id: 'k1', pos: { x: 0, y: 0, z: 10 }, diameter: 1.3 } as SupportCollections['knots'][string];
    state.knots.k2 = { id: 'k2', pos: { x: 20, y: 0, z: 10 }, diameter: 1.3 } as SupportCollections['knots'][string];
    state.braces.b1 = {
        id: 'b1',
        modelId: 'm',
        startKnotId: 'k1',
        endKnotId: 'k2',
        profile: { diameter: 1 },
        curve: { type: 'straight' },
    } as unknown as SupportCollections['braces'][string];

    const ml = computeSupportAndRaftResinMl({
        supportState: state,
        raftSettings: RAFT_OFF,
        visibleModelIds: new Set(['m']),
        plateModels: [],
    });

    // Each host knot 1.3 mm wide leave a 1.2 mm member, averaged over the two ends.
    const printedRadius = 1.2 / 2;
    const expected = (Math.PI * printedRadius * printedRadius * 20) / 1000;
    const profileRadius = 1 / 2;
    const profileBased = (Math.PI * profileRadius * profileRadius * 20) / 1000;

    assert.ok(Math.abs(ml - expected) < 1e-9, `got ${ml}, expected ${expected}`);
    assert.ok(Math.abs(ml - profileBased) > 1e-6, `still using the profile diameter: ${ml}`);
});

test('an anchor inline root counts its base and its joint', () => {
    const state = createEmptySupportCollections();
    state.stumps.s1 = {
        id: 's1',
        typeId: 'stump',
        modelId: 'm',
        rootPos: { x: 0, y: 0, z: 0 },
        rootHeight: 5,
        rootBaseDiameter: 2,
        rootTopDiameter: 1,
        segments: [],
        joint: { id: 'sj', diameter: 1.2 },
    } as unknown as SupportCollections['stumps'][string];

    const ml = computeSupportAndRaftResinMl({
        supportState: state,
        raftSettings: RAFT_OFF,
        visibleModelIds: new Set(['m']),
        plateModels: [],
    });

    const frustum = (Math.PI * 5 / 3) * (1 * 1 + 1 * 0.5 + 0.5 * 0.5) / 1000;
    assert.ok(Math.abs(ml - (frustum + jointMl(1.2))) < 1e-9, `got ${ml}`);
});

const RAFT_NO_WALL = { ...DEFAULT_RAFT_SETTINGS, wallEnabled: false };

test('the wall style changes what the raft prints', () => {
    const state = supportsWith([createRoot('r', 'm', 0)]);
    const args = { supportState: state, visibleModelIds: new Set(['m']), plateModels: [] };

    const perimeter = computeSupportAndRaftResinMl({
        ...args,
        raftSettings: { ...DEFAULT_RAFT_SETTINGS, crenulationSpacing: 0, crenulationGapWidth: 0 },
    });
    const crenelated = computeSupportAndRaftResinMl({
        ...args,
        raftSettings: { ...DEFAULT_RAFT_SETTINGS, crenulationSpacing: 5, crenulationGapWidth: 1.5 },
    });

    // The crenelated wall flares outward over its height, so it is not the plain
    // perimeter prism an area-based guess would report — the two must differ.
    assert.ok(
        Math.abs(crenelated - perimeter) > perimeter * 0.005,
        `crenelated ${crenelated} vs perimeter ${perimeter}`,
    );
});

test('a chamfered base is measured, not assumed to be a prism', () => {
    const state = supportsWith([createRoot('r', 'm', 0)]);
    const args = { supportState: state, visibleModelIds: new Set(['m']), plateModels: [] };

    const squareRaft = { ...RAFT_NO_WALL, chamferAngle: 90 };
    const square = computeSupportAndRaftResinMl({ ...args, raftSettings: squareRaft });
    const chamfered = computeSupportAndRaftResinMl({
        ...args,
        raftSettings: { ...RAFT_NO_WALL, chamferAngle: 45 },
    });
    const rootsOnly = computeSupportAndRaftResinMl({ ...args, raftSettings: RAFT_OFF });

    // A 90-degree base is a prism over the footprint the hull gives it.
    const footprint = computeRaftFootprintPolygons({
        circles: [{ x: 0, y: 0, r: 1.5 }],
        raft: squareRaft,
        clearance: [],
    });
    const prismMl = (polygonSetAreaMm2(footprint) * squareRaft.thickness) / 1000;

    assert.ok(Math.abs((square - rootsOnly) - prismMl) < 1e-6, `square base ${square - rootsOnly}, prism ${prismMl}`);

    // A 45-degree base keeps the same top ring but stands on an inset bottom, so it
    // prints less than the prism of its own footprint — and is not a degenerate shape.
    const chamferedRaft = { ...RAFT_NO_WALL, chamferAngle: 45 };
    const chamferedFootprint = computeRaftFootprintPolygons({
        circles: [{ x: 0, y: 0, r: 1.5 }],
        raft: chamferedRaft,
        clearance: [],
    });
    const chamferedPrismMl = (polygonSetAreaMm2(chamferedFootprint) * chamferedRaft.thickness) / 1000;
    const measured = chamfered - rootsOnly;

    assert.ok(measured < chamferedPrismMl, `chamfered base ${measured}, prism ${chamferedPrismMl}`);
    assert.ok(measured > chamferedPrismMl * 0.5, `chamfered base collapsed: ${measured}`);
});

test('the wall is part of the raft, and line mode prints beams across the footprint', () => {
    const state = supportsWith([
        createRoot('r1', 'm', -10),
        createRoot('r2', 'm', 10),
        createRoot('r3', 'm', 0),
    ].map((root, index) => ({ ...root, transform: { ...root.transform, pos: { x: root.transform.pos.x, y: index * 10 - 10, z: 0 } } })));
    const args = { supportState: state, visibleModelIds: new Set(['m']), plateModels: [] };

    const withoutWall = computeSupportAndRaftResinMl({ ...args, raftSettings: RAFT_NO_WALL });
    const withWall = computeSupportAndRaftResinMl({ ...args, raftSettings: DEFAULT_RAFT_SETTINGS });
    assert.ok(withWall > withoutWall, `wall ${withWall} vs ${withoutWall}`);

    const line = (lineWidthMm: number) => computeSupportAndRaftResinMl({
        ...args,
        raftSettings: { ...RAFT_NO_WALL, bottomMode: 'line', lineWidthMm, lineHeightMm: 0.6 },
    });

    const narrow = line(1.5);
    const wide = line(3);
    assert.ok(narrow > 0, `line raft had no beams: ${narrow}`);
    assert.ok(wide > narrow, `wide beams ${wide} vs narrow ${narrow}`);
});
