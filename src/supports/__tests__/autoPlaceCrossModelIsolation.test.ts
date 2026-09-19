import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { footprintFromPoints } from '@/volumeAnalysis/Islands/voxelFootprint';
import { clearHistory } from '../../history/historyStore';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';
import { collectFanShaftPoints, computeAutoSupportPlan, fanLeafToHost, runAutoPlace } from '../autoSupport/autoPlace';
import { setModelMesh } from '../autoSupport/meshStore';
import { registerSupportHistoryHandlers } from '../history/useSupportHistoryHandlers';
import { modelIdOfParentShaft } from '../PlacementLogic/SupportModelLinker';
import { getSnapshot, resetKickstandsInState, resetStore } from '../state';
import type { SupportState } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptySnapshot(): SupportState {
    return {
        roots: {}, trunks: {}, branches: {}, leaves: {}, twigs: {}, sticks: {},
        braces: {}, anchors: {}, kickstands: {}, knots: {},
        selectedId: null, selectedCategory: null,
        hoveredId: null, hoveredCategory: 'none', interactionWarning: null,
    } as unknown as SupportState;
}

/** One shafted trunk spanning z0..z1 at (x, y), owned by `modelId`. */
function addTrunk(draft: SupportState, id: string, modelId: string, x: number, y: number, z0: number, z1: number): void {
    // Fixture literal: only the fields the fan/consolidation paths read.
    const trunk = {
        id,
        modelId,
        rootId: `root-${id}`,
        segments: [{
            id: `seg-${id}`,
            diameter: 1,
            bottomJoint: { id: `${id}-b`, pos: { x, y, z: z0 }, diameter: 1.2 },
            topJoint: { id: `${id}-t`, pos: { x, y, z: z1 }, diameter: 1.2 },
        }],
    };
    draft.trunks[id] = trunk as SupportState['trunks'][string];
}

function makeIsland(id: string, x: number, y: number, z: number, areaMm2: number): DetectedIsland {
    return { id, source: 'voxel', contact: new THREE.Vector3(x, y, z), baseZ: z, areaMm2 };
}

/** Sub-threshold overhang region — the shape that routes to leaf fanning. */
function makeOverhang(id: string, x: number, y: number, z: number): DetectedIsland {
    return {
        id,
        source: 'overhang',
        contact: new THREE.Vector3(x, y, z),
        baseZ: z,
        areaMm2: 16,
        contactVoxels: footprintFromPoints([
            { x: x - 0.25, y: y - 0.25 }, { x, y: y - 0.25 }, { x: x + 0.25, y: y - 0.25 },
            { x: x - 0.25, y }, { x, y }, { x: x + 0.25, y },
            { x: x - 0.25, y: y + 0.25 }, { x, y: y + 0.25 }, { x: x + 0.25, y: y + 0.25 },
        ]),
    };
}

const AUTO_SETTINGS = { debugSkipAutoBracing: true, stabilizationEnabled: false };

/** Every leaf/branch must hang off a knot whose host shaft belongs to the member's own model. */
function assertMembersHostedByOwnModel(state: SupportState): void {
    for (const member of [...Object.values(state.leaves), ...Object.values(state.branches)]) {
        const knot = state.knots[member.parentKnotId];
        assert.ok(knot, `${member.id} has a parent knot`);
        assert.equal(
            modelIdOfParentShaft(state, knot.parentShaftId),
            member.modelId,
            `${member.id} (${member.modelId}) is hosted on ${knot.parentShaftId}`,
        );
    }
}

/** Everything a model owns, members' knots included — for before/after comparison. */
function modelEntities(state: SupportState, modelId: string): string {
    const own = <T extends { modelId?: string }>(record: Record<string, T>): T[] =>
        Object.values(record).filter((e) => e.modelId === modelId);
    const members = [...own(state.leaves), ...own(state.branches)];
    return JSON.stringify([
        own(state.trunks),
        members,
        members.map((m) => state.knots[m.parentKnotId]),
    ]);
}

function trunkEntities(state: SupportState, modelId: string): string {
    return JSON.stringify(Object.values(state.trunks).filter((t) => t.modelId === modelId));
}

// ---------------------------------------------------------------------------
// Fanning host pool
// ---------------------------------------------------------------------------

test('fanLeafToHost never hosts on another model\'s shaft', () => {
    const draft = emptySnapshot();
    addTrunk(draft, 'a', 'model-a', 8.25, 0, 0, 20);
    addTrunk(draft, 'b', 'model-b', 8, 0, 0, 20);

    // (9, 0, 12) is in reach of both shafts; model-a's is marginally closer,
    // so its sample is the steeper one and a global pool picks the foreign
    // shaft.
    const result = fanLeafToHost(
        { x: 9, y: 0, z: 12 },
        'model-b',
        collectFanShaftPoints(draft),
        new Set(),
        'auto-fan-v2',
        8,
        2.5,
        30,
        12,
        draft,
        undefined,
    );

    assert.equal(result.ok, true, 'model-b\'s own shaft is in reach');
    if (result.ok) {
        assert.equal(result.hostId, 'b', 'hosted on the supported model\'s trunk');
        assert.equal(result.draft.knots['auto-fan-v2'].parentShaftId, 'seg-b');
    }
});

// ---------------------------------------------------------------------------
// Knot identity
// ---------------------------------------------------------------------------

test('an auto knot id already taken by another member is not reused', () => {
    // Island/candidate ids restart at v0/m0/o0 per model scan, so a second
    // model (or a re-run) rebuilds the same knot id. Reusing it REPLACES the
    // existing knot, re-parenting the member that already owned it.
    const draft = emptySnapshot();
    addTrunk(draft, 'a', 'model-a', 8.25, 0, 0, 20);
    addTrunk(draft, 'b', 'model-b', 8, 0, 0, 20);
    (draft.knots as Record<string, unknown>)['auto-fan-v2'] = {
        id: 'auto-fan-v2',
        parentShaftId: 'seg-a',
        t: 0.5,
        pos: { x: 8.25, y: 0, z: 10 },
        diameter: 1.125,
    };
    (draft.leaves as Record<string, unknown>)['leaf-a'] = {
        id: 'leaf-a',
        modelId: 'model-a',
        parentKnotId: 'auto-fan-v2',
        contactCone: { id: 'cone-a', pos: { x: 8.25, y: 0, z: 6 }, normal: { x: 0, y: 0, z: -1 } },
    };

    const result = fanLeafToHost(
        { x: 9, y: 0, z: 12 },
        'model-b',
        collectFanShaftPoints(draft),
        new Set(),
        'auto-fan-v2',
        8,
        2.5,
        30,
        12,
        draft,
        undefined,
    );

    assert.equal(result.ok, true, 'model-b\'s candidate attaches');
    if (!result.ok) return;
    const after = result.draft;
    const member = result.kind === 'leaf'
        ? after.leaves[result.entityId]
        : after.branches[result.entityId];
    assert.ok(member, 'the new member exists');

    assert.equal(after.knots['auto-fan-v2'].parentShaftId, 'seg-a', 'model-a\'s knot is untouched');
    assert.deepEqual(after.knots['auto-fan-v2'].pos, { x: 8.25, y: 0, z: 10 });
    assert.equal(after.leaves['leaf-a'].parentKnotId, 'auto-fan-v2');
    assert.equal(modelIdOfParentShaft(after, after.knots['auto-fan-v2'].parentShaftId), 'model-a');

    assert.notEqual(member.parentKnotId, 'auto-fan-v2', 'the new member gets its own knot id');
    assert.equal(after.knots[member.parentKnotId].parentShaftId, 'seg-b');
});

// ---------------------------------------------------------------------------
// Plan-level isolation
// ---------------------------------------------------------------------------

test('a plan never fans a candidate onto another model\'s shaft', () => {
    // model-a owns the only shaft in the scene; model-b's overhang sits in
    // its fan reach. Nothing of model-b's is close enough to host it.
    const base = emptySnapshot();
    addTrunk(base, 'foreign', 'model-a', 3, 0, 20, 24);
    base.trunks['foreign'].origin = 'island';

    const plan = computeAutoSupportPlan(
        [makeOverhang('o11', 2, 0, 30)],
        'model-b',
        AUTO_SETTINGS,
        base,
        undefined,
    );

    assert.ok(plan, 'plan computed');
    assertMembersHostedByOwnModel(plan.support);
    assert.equal(trunkEntities(plan.support, 'model-a'), trunkEntities(base, 'model-a'),
        'the other model\'s shaft is untouched');
    assert.ok(
        Object.values(plan.support.trunks).some((t) => t.modelId === 'model-b'),
        'model-b\'s overhang kept its own pillar instead of disappearing',
    );
});

test('consolidation never converts another model\'s trunk into one of our leaves', () => {
    // A bare standalone pillar of model-a, its tip in consolidation reach of
    // model-b's shaft. Consolidation converts neighbouring bare pillars into
    // fan leaves.
    const base = emptySnapshot();
    addTrunk(base, 'foreign', 'model-a', 3, 0, 0, 32);
    base.trunks['foreign'].origin = 'standalone';
    base.trunks['foreign'].contactCone = {
        id: 'cone-foreign',
        pos: { x: 3, y: 0, z: 32 },
        normal: { x: 0, y: 0, z: -1 },
    } as SupportState['trunks'][string]['contactCone'];
    addTrunk(base, 'host', 'model-b', 0, 0, 20, 27);
    base.trunks['host'].origin = 'island';
    const foreignBefore = trunkEntities(base, 'model-a');

    // The island trunk stands 6mm clear in Y: the foreign pillar's tip is not
    // in fan reach of it, so 'host' is the only eligible host — and the
    // fan path to it does not cross the island shaft.
    const plan = computeAutoSupportPlan([makeIsland('A', 0, 6, 40, 30)], 'model-b', AUTO_SETTINGS, base, undefined);

    assert.ok(plan, 'plan computed');
    assert.ok(plan.support.trunks['foreign'], 'the other model\'s pillar survives our run');
    assert.equal(trunkEntities(plan.support, 'model-a'), foreignBefore, 'and is unchanged');
    assertMembersHostedByOwnModel(plan.support);
});

// ---------------------------------------------------------------------------
// Whole-run isolation
// ---------------------------------------------------------------------------

test('a second model rebuilding the same island ids does not steal the first model\'s knots', () => {
    resetStore();
    resetKickstandsInState();
    clearHistory();
    const disposeHandlers = registerSupportHistoryHandlers();

    // Both models scan the same geometry, so both produce island ids A / o15
    // and therefore the same auto knot ids.
    runAutoPlace([makeIsland('A', 0, 0, 40, 30), makeOverhang('o15', 3, 0, 33)], 'model-a', AUTO_SETTINGS);
    const afterA = getSnapshot();
    const aEntities = modelEntities(afterA, 'model-a');
    assert.ok(Object.keys(afterA.leaves).length > 0, 'model-a placed a fanned leaf');
    assertMembersHostedByOwnModel(afterA);

    runAutoPlace([makeIsland('A', 100, 0, 40, 30), makeOverhang('o15', 103, 0, 33)], 'model-b', AUTO_SETTINGS);
    const afterB = getSnapshot();

    assertMembersHostedByOwnModel(afterB);
    assert.equal(modelEntities(afterB, 'model-a'), aEntities, 'model-a\'s members keep their own knots');

    setModelMesh('model-a', null);
    setModelMesh('model-b', null);
    disposeHandlers();
});
