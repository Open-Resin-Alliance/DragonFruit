import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { footprintFromPoints } from '@/volumeAnalysis/Islands/voxelFootprint';
import { clearHistory } from '../../history/historyStore';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';
import { collectFanShaftPoints, computeAutoSupportPlan, fanLeafToHost, runAutoPlace } from '../autoSupport/autoPlace';
import { collectSupportTips } from '../autoSupport/coverage';
import { setModelMesh } from '../autoSupport/meshStore';
import { registerSupportHistoryHandlers } from '../history/useSupportHistoryHandlers';
import { modelIdOfParentShaft } from '../PlacementLogic/SupportModelLinker';
import { getSnapshot, resetKickstandsInState, resetStore, setSnapshot } from '../state';
import type { SupportState } from '../types';
import { accelerateGeometry, initializeBVH } from '../../utils/bvh';

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
    // o15 sits inside the merge radius of A's shaft, so it attaches as a member
    // (leaf or branch) off A with a candidate-derived knot id — the id collision
    // this test is about. Further out it would fan, and past the leaf threshold a
    // host with no sample for a legal branch departure leaves it a pillar.
    runAutoPlace([makeIsland('A', 0, 0, 40, 30), makeOverhang('o15', 2, 0, 38)], 'model-a', AUTO_SETTINGS);
    const afterA = getSnapshot();
    const aEntities = modelEntities(afterA, 'model-a');
    // The fixture's span is past the leaf threshold, so the fan member is a
    // branch — what matters here is that a member with a candidate-derived
    // knot id exists, and both kinds mint one through freeKnotId.
    assert.ok(Object.keys(afterA.leaves).length + Object.keys(afterA.branches).length > 0,
        'model-a placed a fanned member');
    assertMembersHostedByOwnModel(afterA);

    runAutoPlace([makeIsland('A', 100, 0, 40, 30), makeOverhang('o15', 102, 0, 38)], 'model-b', AUTO_SETTINGS);
    const afterB = getSnapshot();

    assertMembersHostedByOwnModel(afterB);
    assert.equal(modelEntities(afterB, 'model-a'), aEntities, 'model-a\'s members keep their own knots');

    setModelMesh('model-a', null);
    setModelMesh('model-b', null);
    disposeHandlers();
});

test('overlapping sibling model supports are never suppressed, culled, resized, braced, or counted', () => {
    initializeBVH();
    const geomB = new THREE.BoxGeometry(12, 12, 10).translate(0, 0, 15).toNonIndexed();
    geomB.computeVertexNormals();
    accelerateGeometry(geomB);
    const meshB = new THREE.Mesh(geomB, new THREE.MeshBasicMaterial());
    meshB.updateMatrixWorld(true);

    const base = emptySnapshot();
    // Model A trunk-a1 at (0, 0, 0..25) pierces right through meshB (z=10..20)
    // and carries a fat branch (1.4mm > 0.8mm) that would trigger forest resize if unscoped.
    base.roots['root-trunk-a1'] = {
        id: 'root-trunk-a1',
        modelId: 'model-a',
        transform: { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
        diameter: 3,
        diskHeight: 0.5,
        coneHeight: 0.5,
    };
    addTrunk(base, 'trunk-a1', 'model-a', 0, 0, 1, 25);
    base.trunks['trunk-a1'].segments[0].diameter = 0.8;
    base.trunks['trunk-a1'].contactCone = {
        id: 'cone-trunk-a1',
        pos: { x: 0, y: 0, z: 25 },
        normal: { x: 0, y: 0, z: -1 },
    } as SupportState['trunks'][string]['contactCone'];

    // Model A trunk-a2 has its contact tip at (1.0, 0, 10.5), within < 2.0mm (1.12mm)
    // of Model B's island at (0, 0, 10.0) — must NOT suppress Model B's candidate.
    base.roots['root-trunk-a2'] = {
        id: 'root-trunk-a2',
        modelId: 'model-a',
        transform: { pos: { x: 1, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
        diameter: 3,
        diskHeight: 0.5,
        coneHeight: 0.5,
    };
    addTrunk(base, 'trunk-a2', 'model-a', 1, 0, 1, 10.5);
    base.trunks['trunk-a2'].contactCone = {
        id: 'cone-trunk-a2',
        pos: { x: 1, y: 0, z: 10.5 },
        normal: { x: 0, y: 0, z: -1 },
    } as SupportState['trunks'][string]['contactCone'];

    base.knots['knot-a1'] = {
        id: 'knot-a1',
        parentShaftId: 'seg-trunk-a1',
        t: 0.5,
        pos: { x: 0, y: 0, z: 13 },
        diameter: 1.0,
    };
    (base.leaves as Record<string, unknown>)['leaf-a1'] = {
        id: 'leaf-a1',
        modelId: 'model-a',
        parentKnotId: 'knot-a1',
        contactCone: { id: 'cone-leaf-a1', pos: { x: 1.5, y: 0, z: 16 }, normal: { x: 0, y: 0, z: -1 } },
    };
    (base.branches as Record<string, unknown>)['branch-a1'] = {
        id: 'branch-a1',
        typeId: 'branch',
        modelId: 'model-a',
        parentKnotId: 'knot-a1',
        segments: [{
            id: 'seg-branch-a1',
            diameter: 1.4,
            bottomJoint: { id: 'jb-a1', pos: { x: 0, y: 0, z: 13 }, diameter: 1.5 },
            topJoint: { id: 'jt-a1', pos: { x: -2, y: 0, z: 18 }, diameter: 1.5 },
        }],
        contactCone: { id: 'cone-branch-a1', pos: { x: -2, y: 0, z: 18 }, normal: { x: 0, y: 0, z: -1 } },
    };
    base.knots['bk-a1'] = {
        id: 'bk-a1',
        parentShaftId: 'seg-trunk-a1',
        t: 0.25,
        pos: { x: 0, y: 0, z: 7 },
        diameter: 1.0,
    };
    base.knots['bk-a2'] = {
        id: 'bk-a2',
        parentShaftId: 'seg-trunk-a2',
        t: 0.5,
        pos: { x: 1, y: 0, z: 5.75 },
        diameter: 1.0,
    };
    (base.braces as Record<string, unknown>)['brace-a1'] = {
        id: 'brace-a1',
        modelId: 'model-a',
        origin: 'auto',
        startKnotId: 'bk-a1',
        endKnotId: 'bk-a2',
        profile: { diameter: 0.6, startOffset: 0, endOffset: 0 },
    };
    (base.kickstands as Record<string, unknown>)['kick-a1'] = {
        id: 'kick-a1',
        modelId: 'model-a',
        origin: 'auto',
        trunkId: 'trunk-a1',
        parentKnotId: 'bk-a1',
        rootId: 'root-trunk-a2',
        diameter: 0.8,
    };

    const snapshotModelA = (s: SupportState) => JSON.stringify({
        roots: Object.values(s.roots).filter((e) => e.modelId === 'model-a'),
        trunks: Object.values(s.trunks).filter((e) => e.modelId === 'model-a'),
        leaves: Object.values(s.leaves).filter((e) => e.modelId === 'model-a'),
        branches: Object.values(s.branches).filter((e) => e.modelId === 'model-a'),
        braces: Object.values(s.braces).filter((e) => e.modelId === 'model-a'),
        kickstands: Object.values(s.kickstands).filter((e) => e.modelId === 'model-a'),
        knots: ['knot-a1', 'bk-a1', 'bk-a2'].map((id) => s.knots[id]),
    });
    const beforeModelA = snapshotModelA(base);

    const plan = computeAutoSupportPlan(
        [makeIsland('b-near', 0, 0, 10, 8), makeIsland('b-other', -4, -4, 10, 8)],
        'model-b',
        { debugSkipAutoBracing: false, stabilizationEnabled: false, minimaReinforcementEnabled: false },
        base,
        meshB,
    );

    assert.ok(plan, 'plan computed for model-b');
    // (1) Zero Model A trunks, leaves, branches, knots, braces, or kickstands deleted or resized
    assert.equal(snapshotModelA(plan.support), beforeModelA, 'all model-a entities remain untouched');

    // (2) Model B candidate at (0, 0, 10) within <2mm of Model A tip (1, 0, 10.5) was NOT suppressed
    const report = plan.analytics.forestReport;
    assert.ok(report, 'forestReport generated');
    assert.equal(report.scan?.alreadySupported ?? 0, 0, 'model-a tips never suppress model-b candidates');
    const modelBContacts = [
        ...Object.values(plan.support.trunks).filter((t) => t.modelId === 'model-b').map((t) => t.contactCone?.pos),
        ...Object.values(plan.support.leaves).filter((l) => l.modelId === 'model-b').map((l) => l.contactCone?.pos),
        ...Object.values(plan.support.branches).filter((b) => b.modelId === 'model-b').map((b) => b.contactCone?.pos),
    ].filter((p): p is { x: number; y: number; z: number } => Boolean(p));
    assert.ok(
        modelBContacts.some((p) => Math.hypot(p.x - 0, p.y - 0) < 1.5),
        'model-b candidate near model-a tip received its own support',
    );

    // (3) forestReport counts ONLY model-b entities
    const modelBTrunkCount = Object.values(plan.support.trunks).filter((t) => t.modelId === 'model-b').length;
    const modelBLeafCount = Object.values(plan.support.leaves).filter((l) => l.modelId === 'model-b').length;
    const modelBBranchCount = Object.values(plan.support.branches).filter((b) => b.modelId === 'model-b').length;
    assert.equal(report.hostCount, modelBTrunkCount, 'hostCount reflects only model-b');
    assert.equal(report.leafCount, modelBLeafCount, 'leafCount reflects only model-b');
    assert.equal(report.branchCount, modelBBranchCount, 'branchCount reflects only model-b');
});

test('MAJOR-03: Phase 3c gap-fill scopes collectSupportTips to target modelId and reads explicit baseState instead of global store', () => {
    resetStore();
    resetKickstandsInState();
    clearHistory();

    // 7mm x 1mm overhang (areaMm2 = 7 < 8mm² ring threshold): Step 1 places only 1 centroid
    // candidate at (0, 0, 15). When model-b already owns a tip at (-3.2, 0, 15) in baseState
    // (>3.0mm from centroid), -X is covered and +X (~3.5mm² >= 2.0mm²) MUST receive a Phase 3c
    // gap-fill support — even when global getSnapshot() is empty OR when sibling model-a has
    // tips directly under +X!
    const voxels: Array<{ x: number; y: number; z: number }> = [];
    for (let x = -3.5; x <= 3.5; x += 0.25) {
        for (let y = -0.5; y <= 0.5; y += 0.25) {
            voxels.push({ x, y, z: 15 });
        }
    }
    const stripOverhang: DetectedIsland = {
        id: 'strip-b',
        source: 'overhang',
        contact: new THREE.Vector3(0, 0, 15),
        baseZ: 15,
        areaMm2: 7,
        overhangAngleDeg: 0,
        surfaceNormal: { x: 0, y: 0, z: -1 },
        contactVoxels: footprintFromPoints(voxels),
    };

    const countNewModelBSupports = (planState: SupportState, priorIds: ReadonlySet<string>): number =>
        Object.values(planState.trunks).filter((t) => t.modelId === 'model-b' && !priorIds.has(t.id)).length +
        Object.values(planState.leaves).filter((l) => l.modelId === 'model-b' && !priorIds.has(l.id)).length +
        Object.values(planState.branches).filter((b) => b.modelId === 'model-b' && !priorIds.has(b.id)).length;

    const sparseSettings = { ...AUTO_SETTINGS, areaPerSupportMm2: 50 };

    try {
        // 1. Explicit baseState purity: global store is EMPTY, baseState has model-b's (-3.2, 0, 15) tip.
        // Phase 3c must read `before` (baseState), detect uncovered +X cluster, and place > 1 new support!
        const baseOwnLeftOnly = emptySnapshot();
        addTrunk(baseOwnLeftOnly, 'own-left', 'model-b', -3.2, 0, 0, 15);
        baseOwnLeftOnly.trunks['own-left'].contactCone = {
            id: 'cone-own-left',
            pos: { x: -3.2, y: 0, z: 15 },
            normal: { x: 0, y: 0, z: -1 },
        } as SupportState['trunks'][string]['contactCone'];

        const pureBasePlan = computeAutoSupportPlan(
            [stripOverhang],
            'model-b',
            sparseSettings,
            baseOwnLeftOnly,
            undefined,
        );
        assert.ok(pureBasePlan, 'pure baseState plan computed');
        const newCountWithoutForeign = countNewModelBSupports(pureBasePlan.support, new Set(['own-left']));
        assert.ok(
            newCountWithoutForeign >= 2,
            `explicit baseState triggered Phase 3c gap-fill on uncovered +X half without global store (got ${newCountWithoutForeign})`,
        );

        // 2. Cross-model isolation: add sibling model-a tips directly beneath +X in BOTH baseState and global store.
        // Model-a tips must NEVER suppress Phase 3c gap-fill on model-b!
        const baseWithForeignRight = structuredClone(baseOwnLeftOnly);
        for (const [idx, gx] of [1.2, 2.5].entries()) {
            const id = `foreign-right-${idx}`;
            addTrunk(baseWithForeignRight, id, 'model-a', gx, 0, 0, 15);
            baseWithForeignRight.trunks[id].contactCone = {
                id: `cone-${id}`,
                pos: { x: gx, y: 0, z: 15 },
                normal: { x: 0, y: 0, z: -1 },
            } as SupportState['trunks'][string]['contactCone'];
        }
        setSnapshot(baseWithForeignRight);

        const isolatedPlan = computeAutoSupportPlan(
            [stripOverhang],
            'model-b',
            sparseSettings,
            baseWithForeignRight,
            undefined,
        );
        assert.ok(isolatedPlan, 'isolated plan computed');
        const newCountWithForeign = countNewModelBSupports(isolatedPlan.support, new Set(['own-left']));
        assert.equal(
            newCountWithForeign,
            newCountWithoutForeign,
            'sibling model-a tips directly below +X overhang did NOT suppress Phase 3c gap-fill on model-b',
        );
        assert.equal(collectSupportTips(baseWithForeignRight, 'model-b').length, 1, 'collectSupportTips scopes to model-b');
        assert.equal(collectSupportTips(baseWithForeignRight, 'model-a').length, 2, 'collectSupportTips scopes to model-a');
    } finally {
        resetStore();
        resetKickstandsInState();
    }
});

