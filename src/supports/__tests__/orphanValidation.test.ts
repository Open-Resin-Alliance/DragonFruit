import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { accelerateGeometry, initializeBVH } from '@/utils/bvh';
import { collectFanShaftPoints, computeAutoSupportPlan, fanLeafToHost, rehostLegacyKnots, validateAndCullOrphans } from '../autoSupport/autoPlace';
import { resetKickstandsInState, resetStore, setSnapshot } from '../state';
import { getSettings, setSettings } from '../Settings/state';
import { createDefaultSettings } from '../Settings/types';
import { SUPPORT_STATE_TYPES } from '../supportTypeRegistry';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';
import type { SupportState } from '../types';

function emptySnapshot(): SupportState {
    return {
        roots: {}, trunks: {}, branches: {}, leaves: {}, twigs: {}, sticks: {},
        braces: {}, anchors: {}, knots: {},
        selectedId: null, selectedCategory: null,
        hoveredId: null, hoveredCategory: 'none', interactionWarning: null,
    } as unknown as SupportState;
}

function trunkWithShaft(trunkId: string, x: number, y: number, z0: number, z1: number, diameter = 1): SupportState {
    const s = emptySnapshot();
    s.trunks[trunkId] = {
        id: trunkId,
        modelId: 'm',
        rootId: `r-${trunkId}`,
        segments: [{
            id: `seg-${trunkId}`,
            diameter,
            bottomJoint: { id: `${trunkId}-b`, pos: { x, y, z: z0 }, diameter: diameter + 0.2 },
            topJoint: { id: `${trunkId}-t`, pos: { x, y, z: z1 }, diameter: diameter + 0.2 },
        }],
    } as unknown as SupportState['trunks'][string];
    (s as unknown as { roots: Record<string, unknown> }).roots[`r-${trunkId}`] = {
        id: `r-${trunkId}`,
        transform: { pos: { x, y, z: 0 } },
    } as unknown as SupportState['roots'][string];
    return s;
}

test('rehostLegacyKnots converts trunkId parent to segmentId', () => {
    const draft = trunkWithShaft('t1', 0, 0, 0, 10);
    // Legacy knot that points at trunkId, not segment
    (draft.knots as Record<string, unknown>)['k1'] = {
        id: 'k1',
        parentShaftId: 't1',
        pos: { x: 0, y: 0, z: 5 },
        diameter: 1.2,
    } as unknown as SupportState['knots'][string];

    const rehosted = rehostLegacyKnots(draft);
    const knot = rehosted.knots['k1'];
    assert.equal(knot.parentShaftId, 'seg-t1', 'rehosted to segment id');
    assert.ok(typeof knot.t === 'number' && knot.t >= 0 && knot.t <= 1, 't computed');
});

test('fanLeafToHost creates knot with segmentId and t (not trunkId)', () => {
    const draft = trunkWithShaft('host', 0, 0, 0, 10);
    const pool = collectFanShaftPoints(draft);
    assert.ok(pool.length > 0 && pool[0].segmentId, 'pool has segmentId');
    assert.ok(typeof pool[0].t === 'number', 'pool has t');

    const result = fanLeafToHost(
        { x: 1, y: 0, z: 9 },
        'm',
        pool,
        new Set(),
        'knot-test',
        5,
        2.5,
        60,
        10,
        draft,
        undefined,
    );
    assert.equal(result.ok, true, 'leaf should attach');
    if (result.ok) {
        const knot = result.draft.knots['knot-test'];
        assert.ok(knot, 'knot exists');
        assert.equal(knot.parentShaftId, 'seg-host', 'knot parent is segment id, not trunk id');
        assert.ok(typeof knot.t === 'number', 'knot has t');
        // Validate passes (no drift, not missing)
        const validated = validateAndCullOrphans(result.draft, undefined);
        assert.equal(validated.orphans.length, 0, 'valid leaf not orphaned');
        assert.equal(result.kind, 'leaf', 'short span stays a leaf');
        if (result.kind === 'leaf') assert.ok(validated.draft.leaves[result.entityId], 'leaf remains after validation');
    }
});

test('validateAndCullOrphans culls drifted knot (>0.5mm off shaft)', () => {
    const draft = trunkWithShaft('t1', 0, 0, 0, 10);
    // Knot drifted 2mm off shaft
    (draft.knots as Record<string, unknown>)['k-drift'] = {
        id: 'k-drift',
        parentShaftId: 'seg-t1',
        t: 0.5,
        pos: { x: 2, y: 0, z: 5 },
        diameter: 1.2,
    } as unknown as SupportState['knots'][string];
    (draft.leaves as Record<string, unknown>)['leaf-drift'] = {
        id: 'leaf-drift',
        modelId: 'm',
        parentKnotId: 'k-drift',
        contactCone: { id: 'c', pos: { x: 2, y: 0, z: 6 }, normal: { x: 0, y: 0, z: -1 } },
    } as unknown as SupportState['leaves'][string];

    const { draft: cleaned, orphans } = validateAndCullOrphans(draft, undefined);
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0].reason, 'drift');
    assert.equal(cleaned.leaves['leaf-drift'], undefined, 'drifted leaf culled');
    assert.equal(cleaned.knots['k-drift'], undefined, 'drifted knot removed when unused');
});

test('validateAndCullOrphans reports cross but keeps leaf (non-destructive)', () => {
    const draft = trunkWithShaft('host', 0, 0, 0, 10);
    // Second trunk that the leaf will cross
    const other = trunkWithShaft('other', 1, 0, 0, 10);
    const merged: SupportState = {
        ...emptySnapshot(),
        trunks: { ...draft.trunks, ...other.trunks },
        roots: { ...(draft.roots as Record<string, unknown>), ...(other.roots as Record<string, unknown>) } as SupportState['roots'],
        knots: {},
        leaves: {},
        branches: {}, twigs: {}, sticks: {}, braces: {}, anchors: {},
        selectedId: null, selectedCategory: null, hoveredId: null, hoveredCategory: 'none', interactionWarning: null,
    } as unknown as SupportState;

    // Knot on host at (0,0,5), leaf tip at (2,0,6) — path passes near other trunk at (1,0)
    (merged.knots as Record<string, unknown>)['k-cross'] = {
        id: 'k-cross',
        parentShaftId: 'seg-host',
        t: 0.5,
        pos: { x: 0, y: 0, z: 5 },
        diameter: 1.2,
    } as unknown as SupportState['knots'][string];
    (merged.leaves as Record<string, unknown>)['leaf-cross'] = {
        id: 'leaf-cross',
        modelId: 'm',
        parentKnotId: 'k-cross',
        contactCone: { id: 'c', pos: { x: 2, y: 0, z: 6 }, normal: { x: 0, y: 0, z: -1 } },
    } as unknown as SupportState['leaves'][string];

    const { draft: kept, orphans } = validateAndCullOrphans(merged, undefined);
    // Cross is reported but not culled (kept for backward compat with existing tests)
    assert.ok(orphans.some((o) => o.reason === 'cross'), 'cross reported');
    assert.ok(kept.leaves['leaf-cross'], 'cross leaf kept (reported, not culled)');
});

test('validateAndCullOrphans keeps knots hosted on top segments', () => {
    // Top trunk segments carry no topJoint by design (they end at the
    // contact cone). A knot hosted there is valid — the cone is the top.
    const draft = emptySnapshot();
    draft.trunks['host'] = {
        id: 'host',
        modelId: 'm',
        rootId: 'r-host',
        segments: [{
            id: 'seg-host',
            diameter: 1,
            bottomJoint: { id: 'host-b', pos: { x: 0, y: 0, z: 0 }, diameter: 1.2 },
        }],
        contactCone: { id: 'c-host', pos: { x: 0, y: 0, z: 10 }, normal: { x: 0, y: 0, z: -1 } },
    } as unknown as SupportState['trunks'][string];
    draft.knots['k1'] = {
        id: 'k1', parentShaftId: 'seg-host', pos: { x: 0, y: 0, z: 8 }, diameter: 1.1,
    } as unknown as SupportState['knots'][string];
    draft.leaves['l1'] = {
        id: 'l1',
        modelId: 'm',
        parentKnotId: 'k1',
        contactCone: { id: 'c-l1', pos: { x: 1, y: 0, z: 10 }, normal: { x: 0, y: 0, z: -1 } },
    } as unknown as SupportState['leaves'][string];

    const { draft: kept, orphans } = validateAndCullOrphans(draft, undefined);
    assert.equal(orphans.length, 0, 'no orphans from a top-segment host');
    assert.ok(kept.leaves['l1'], 'leaf on a top segment survives validation');
});

test('validateAndCullOrphans still culls cone-less topless segments', () => {
    // Same geometry but no contact cone ANYWHERE: with neither topJoint
    // nor cone, the segment top is genuinely unknown → still culled.
    const draft = emptySnapshot();
    draft.trunks['host'] = {
        id: 'host',
        modelId: 'm',
        rootId: 'r-host',
        segments: [{
            id: 'seg-host',
            diameter: 1,
            bottomJoint: { id: 'host-b', pos: { x: 0, y: 0, z: 0 }, diameter: 1.2 },
        }],
    } as unknown as SupportState['trunks'][string];
    draft.knots['k1'] = {
        id: 'k1', parentShaftId: 'seg-host', pos: { x: 0, y: 0, z: 8 }, diameter: 1.1,
    } as unknown as SupportState['knots'][string];
    draft.leaves['l1'] = {
        id: 'l1',
        modelId: 'm',
        parentKnotId: 'k1',
        contactCone: { id: 'c-l1', pos: { x: 1, y: 0, z: 10 }, normal: { x: 0, y: 0, z: -1 } },
    } as unknown as SupportState['leaves'][string];

    const { draft: culled, orphans } = validateAndCullOrphans(draft, undefined);
    assert.ok(!culled.leaves['l1'], 'leaf on an unknowable segment still culled');
    assert.ok(orphans.some((o) => o.id === 'l1' && o.reason === 'missingHost'), 'reported as missingHost');
});

test('validateAndCullOrphans keeps knots hosted on bottom segments', () => {
    // Bottom trunk segments carry no bottomJoint by design (they rise from
    // the root plate) — the root top stands in as the segment start.
    const draft = emptySnapshot();
    draft.roots['r-host'] = {
        id: 'r-host',
        transform: { pos: { x: 0, y: 0, z: 0 } },
        diameter: 3,
        diskHeight: 0.5,
        coneHeight: 0.5,
    } as unknown as SupportState['roots'][string];
    draft.trunks['host'] = {
        id: 'host',
        modelId: 'm',
        rootId: 'r-host',
        segments: [{
            id: 'seg-host',
            diameter: 1,
            topJoint: { id: 'host-t', pos: { x: 0, y: 0, z: 10 }, diameter: 1.2 },
        }],
        contactCone: { id: 'c-host', pos: { x: 0, y: 0, z: 10 }, normal: { x: 0, y: 0, z: -1 } },
    } as unknown as SupportState['trunks'][string];
    draft.knots['k1'] = {
        id: 'k1', parentShaftId: 'seg-host', pos: { x: 0, y: 0, z: 2 }, diameter: 1.1,
    } as unknown as SupportState['knots'][string];
    draft.leaves['l1'] = {
        id: 'l1',
        modelId: 'm',
        parentKnotId: 'k1',
        contactCone: { id: 'c-l1', pos: { x: 1, y: 0, z: 4 }, normal: { x: 0, y: 0, z: -1 } },
    } as unknown as SupportState['leaves'][string];

    const { draft: kept, orphans } = validateAndCullOrphans(draft, undefined);
    assert.equal(orphans.length, 0, 'no orphans from a bottom-segment host');
    assert.ok(kept.leaves['l1'], 'leaf on a bottom segment survives validation');
});

test('rehostLegacyKnots resolves off-origin single/top and bottom segments via hostSegmentSpan', () => {
    const draft = emptySnapshot();
    draft.roots['r-trunk-1'] = {
        id: 'r-trunk-1',
        transform: { pos: { x: 15, y: -10, z: 0 } },
        diameter: 3,
        diskHeight: 0.5,
        coneHeight: 0.5,
    } as unknown as SupportState['roots'][string];
    draft.trunks['trunk-1'] = {
        id: 'trunk-1',
        modelId: 'm',
        rootId: 'r-trunk-1',
        segments: [{
            id: 'seg-trunk-1',
            diameter: 1,
        }],
        contactCone: { id: 'c-trunk-1', pos: { x: 15, y: -10, z: 12 }, normal: { x: 0, y: 0, z: -1 } },
    } as unknown as SupportState['trunks'][string];
    draft.knots['k-leg'] = {
        id: 'k-leg',
        parentShaftId: 'trunk-1',
        pos: { x: 15, y: -10, z: 6.5 },
        diameter: 1.1,
    } as unknown as SupportState['knots'][string];
    draft.leaves['l-leg'] = {
        id: 'l-leg',
        modelId: 'm',
        parentKnotId: 'k-leg',
        contactCone: { id: 'c-l-leg', pos: { x: 16, y: -10, z: 8.5 }, normal: { x: 0, y: 0, z: -1 } },
    } as unknown as SupportState['leaves'][string];

    const rehosted = rehostLegacyKnots(draft, 'm');
    const knot = rehosted.knots['k-leg'];
    assert.equal(knot.parentShaftId, 'seg-trunk-1', 'single/top segment without joints rehosts to seg-trunk-1');
    assert.ok(typeof knot.t === 'number' && Math.abs(knot.t - 0.5) < 1e-6, `expected t ≈ 0.5, got ${String(knot.t)}`);

    const { draft: kept, orphans } = validateAndCullOrphans(rehosted, undefined, 'm');
    assert.equal(orphans.length, 0, 'rehosted single-segment knot survives orphan validation');
    assert.ok(kept.leaves['l-leg'], 'leaf hosted on rehosted single-segment knot survives');
});

test('culled-host orphans stamp hostCulled, requeue cleanly, and reconcile net run-created placed counts', () => {
    initializeBVH();
    const prevSettings = getSettings();
    try {
        const settings = createDefaultSettings();
        settings.grid.enabled = false;
        setSettings(settings);

        // 1. Unit check: validateAndCullOrphans marks hostCulled: true on stranded members.
        const boxGeom = new THREE.BoxGeometry(6, 6, 4).translate(0, 0, 5);
        accelerateGeometry(boxGeom);
        const unitMesh = new THREE.Mesh(boxGeom);
        unitMesh.updateMatrixWorld(true);

        const unitDraft = trunkWithShaft('t-blocked', 0, 0, 1, 10);
        (unitDraft.trunks['t-blocked'] as unknown as { contactCone: unknown }).contactCone = {
            id: 'c-tb', pos: { x: 0, y: 0, z: 12 }, normal: { x: 0, y: 0, z: -1 },
        };
        unitDraft.knots['k-b1'] = {
            id: 'k-b1', parentShaftId: 'seg-t-blocked', t: 0.8, pos: { x: 0, y: 0, z: 8.2 }, diameter: 1.2,
        } as unknown as SupportState['knots'][string];
        unitDraft.knots['k-b2'] = {
            id: 'k-b2', parentShaftId: 'seg-t-blocked', t: 0.9, pos: { x: 0, y: 0, z: 9.1 }, diameter: 1.2,
        } as unknown as SupportState['knots'][string];
        unitDraft.leaves['l-b1'] = {
            id: 'l-b1', modelId: 'm', parentKnotId: 'k-b1',
            contactCone: { id: 'c-lb1', pos: { x: 2, y: 0, z: 11 }, normal: { x: 0, y: 0, z: -1 } },
        } as unknown as SupportState['leaves'][string];
        unitDraft.leaves['l-b2'] = {
            id: 'l-b2', modelId: 'm', parentKnotId: 'k-b2',
            contactCone: { id: 'c-lb2', pos: { x: -2, y: 0, z: 11.5 }, normal: { x: 0, y: 0, z: -1 } },
        } as unknown as SupportState['leaves'][string];

        const unitCulled = validateAndCullOrphans(unitDraft, unitMesh, 'm');
        const leafOrphans = unitCulled.orphans.filter((o) => o.kind === 'leaf');
        assert.equal(leafOrphans.length, 2, 'both leaves reported orphaned when host pierces mesh');
        for (const o of leafOrphans) {
            assert.equal(o.reason, 'missingHost');
            assert.equal((o as { hostCulled?: boolean }).hostCulled, true, 'hostCulled stamped on culled-host orphan');
        }

        // 2. End-to-end computeAutoSupportPlan check:
        //    - Two pre-existing trunks pierce mesh blocks at Z=4..6:
        //      * t-pierce-1 at (0, 0) pierces a small 2x2 block, while i1 at (-2.8, 0, 22) has a clear vertical path to plate.
        //      * t-pierce-2 at (100, 0) pierces a wide 80x80 shelf (Z=2..6), while i2 at (102.5, 0, 31) sits 25mm > 12mm above the shelf with no plate route.
        //    - Phase 3a merges i1 and i2 as leaves onto t-pierce-1 and t-pierce-2.
        //    - Phase 4c culls both blocked trunks, requeues both stranded leaves:
        //      i1 re-places as a valid trunk; i2 is rejected and stays deleted.
        //    - plan.result.placed matches exact net run-created entities in plan.support!
        resetStore();
        resetKickstandsInState();
        const sceneGeom = mergeGeometries([
            new THREE.BoxGeometry(2, 2, 2).translate(0, 0, 5),
            new THREE.BoxGeometry(10, 10, 2).translate(0, 0, 22),
            new THREE.BoxGeometry(80, 80, 4).translate(100, 0, 4),
            new THREE.BoxGeometry(10, 10, 2).translate(100, 0, 22),
        ])!;
        accelerateGeometry(sceneGeom);
        const sceneMesh = new THREE.Mesh(sceneGeom);
        sceneMesh.updateMatrixWorld(true);

        const seeded = emptySnapshot();
        seeded.roots['r-p1'] = { id: 'r-p1', modelId: 'm', transform: { pos: { x: 0, y: 0, z: 0 } }, diameter: 3, diskHeight: 0.5, coneHeight: 0.5 } as unknown as SupportState['roots'][string];
        seeded.trunks['t-pierce-1'] = {
            id: 't-pierce-1', modelId: 'm', rootId: 'r-p1',
            segments: [{
                id: 'seg-p1', diameter: 1,
                bottomJoint: { id: 'p1-b', pos: { x: 0, y: 0, z: 1 }, diameter: 1.2 },
                topJoint: { id: 'p1-t', pos: { x: 0, y: 0, z: 19 }, diameter: 1.2 },
            }],
            contactCone: { id: 'c-p1', pos: { x: 0, y: 0, z: 21 }, normal: { x: 0, y: 0, z: -1 } },
        } as unknown as SupportState['trunks'][string];
        seeded.roots['r-p2'] = { id: 'r-p2', modelId: 'm', transform: { pos: { x: 100, y: 0, z: 0 } }, diameter: 3, diskHeight: 0.5, coneHeight: 0.5 } as unknown as SupportState['roots'][string];
        seeded.trunks['t-pierce-2'] = {
            id: 't-pierce-2', modelId: 'm', rootId: 'r-p2',
            segments: [{
                id: 'seg-p2', diameter: 1,
                bottomJoint: { id: 'p2-b', pos: { x: 100, y: 0, z: 1 }, diameter: 1.2 },
                topJoint: { id: 'p2-t', pos: { x: 100, y: 0, z: 19 }, diameter: 1.2 },
            }],
            contactCone: { id: 'c-p2', pos: { x: 100, y: 0, z: 21 }, normal: { x: 0, y: 0, z: -1 } },
        } as unknown as SupportState['trunks'][string];
        setSnapshot(seeded);

        const islands: DetectedIsland[] = [
            {
                id: 'i1-replaceable',
                source: 'voxel',
                // 3D dist to (0,0,21) is 3.4mm: > 3.0mm already-supported, <= 4.0mm merge radius!
                contact: new THREE.Vector3(-3.4, 0, 21),
                baseZ: 21,
                areaMm2: 1,
                layerSpan: [0, 420],
            },
            {
                id: 'i2-unreplaceable',
                source: 'voxel',
                // 3D dist to (100,0,21) is 3.4mm; 15mm > 12mm above Z=6 shelf!
                contact: new THREE.Vector3(103.4, 0, 21),
                baseZ: 21,
                areaMm2: 1,
                layerSpan: [0, 420],
            },
        ];

        const plan = computeAutoSupportPlan(
            islands,
            'm',
            { debugSkipAutoBracing: true, stabilizationEnabled: false },
            undefined,
            sceneMesh,
        );
        assert.ok(plan, 'plan computed');
        assert.equal(plan.result.placed.trunk, 1, 'stranded leaf i1 requeued and re-placed as a standalone trunk');
        assert.equal(plan.result.placed.leaf, 0, 'deleted leaves not surviving in plan.support are reconciled out of placed.leaf');

        for (const descriptor of SUPPORT_STATE_TYPES) {
            if (!descriptor.isAutoPlaced) continue;
            const key = descriptor.location.key;
            const beforeColl = (plan.before[key] ?? {}) as Record<string, unknown>;
            const finalColl = (plan.support[key] ?? {}) as Record<string, { modelId?: string }>;
            const netRunCount = Object.entries(finalColl)
                .filter(([id, ent]) => !(id in beforeColl) && ent.modelId === 'm')
                .length;
            assert.equal(
                plan.result.placed[descriptor.id],
                netRunCount,
                `placed.${descriptor.id} must equal net run-created entities (${netRunCount})`,
            );
        }
    } finally {
        resetStore();
        resetKickstandsInState();
        setSettings(prevSettings);
    }
});

test('non-deleted cross warnings and culled pre-existing before supports do not undercount placed', () => {
    initializeBVH();
    const prevSettings = getSettings();
    try {
        const settings = createDefaultSettings();
        settings.grid.enabled = false;
        setSettings(settings);

        resetStore();
        resetKickstandsInState();

        // Seed `before` with:
        // - `pre-host` for model 'm' at (0, 0, 0..21)
        // - two drifted pre-existing leaves (`pre-drift-1`, `pre-drift-2`) for 'm' that validateAndCullOrphans deletes
        // - `other-shaft` for 'other-model' at (1.6, 0, 0..21) so a newly placed merge leaf to (3.2, 0, 19.5) is flagged as `cross` (kept, not deleted)
        const seeded = emptySnapshot();
        seeded.roots['r-pre-host'] = { id: 'r-pre-host', modelId: 'm', transform: { pos: { x: 0, y: 0, z: 0 } }, diameter: 3, diskHeight: 0.5, coneHeight: 0.5 } as unknown as SupportState['roots'][string];
        seeded.trunks['pre-host'] = {
            id: 'pre-host', modelId: 'm', rootId: 'r-pre-host',
            segments: [{
                id: 'seg-pre-host', diameter: 1,
                bottomJoint: { id: 'ph-b', pos: { x: 0, y: 0, z: 0 }, diameter: 1.2 },
                topJoint: { id: 'ph-t', pos: { x: 0, y: 0, z: 21 }, diameter: 1.2 },
            }],
            contactCone: { id: 'c-ph', pos: { x: 0, y: 0, z: 21 }, normal: { x: 0, y: 0, z: -1 } },
        } as unknown as SupportState['trunks'][string];

        seeded.knots['k-pre-d1'] = { id: 'k-pre-d1', parentShaftId: 'seg-pre-host', t: 0.5, pos: { x: 3, y: 0, z: 10 }, diameter: 1.2 } as unknown as SupportState['knots'][string];
        seeded.leaves['pre-drift-1'] = {
            id: 'pre-drift-1', modelId: 'm', parentKnotId: 'k-pre-d1',
            contactCone: { id: 'c-pd1', pos: { x: 3, y: 0, z: 12 }, normal: { x: 0, y: 0, z: -1 } },
        } as unknown as SupportState['leaves'][string];

        seeded.knots['k-pre-d2'] = { id: 'k-pre-d2', parentShaftId: 'seg-pre-host', t: 0.6, pos: { x: -3, y: 0, z: 12 }, diameter: 1.2 } as unknown as SupportState['knots'][string];
        seeded.leaves['pre-drift-2'] = {
            id: 'pre-drift-2', modelId: 'm', parentKnotId: 'k-pre-d2',
            contactCone: { id: 'c-pd2', pos: { x: -3, y: 0, z: 14 }, normal: { x: 0, y: 0, z: -1 } },
        } as unknown as SupportState['leaves'][string];

        seeded.roots['r-other'] = { id: 'r-other', modelId: 'other-model', transform: { pos: { x: 1.6, y: 0, z: 0 } }, diameter: 3, diskHeight: 0.5, coneHeight: 0.5 } as unknown as SupportState['roots'][string];
        seeded.trunks['other-shaft'] = {
            id: 'other-shaft', modelId: 'other-model', rootId: 'r-other',
            segments: [{
                id: 'seg-other', diameter: 1,
                bottomJoint: { id: 'ot-b', pos: { x: 1.6, y: 0, z: 0 }, diameter: 1.2 },
                topJoint: { id: 'ot-t', pos: { x: 1.6, y: 0, z: 21 }, diameter: 1.2 },
            }],
            contactCone: { id: 'c-ot', pos: { x: 1.6, y: 0, z: 21 }, normal: { x: 0, y: 0, z: -1 } },
        } as unknown as SupportState['trunks'][string];

        setSnapshot(seeded);

        const plan = computeAutoSupportPlan(
            [{
                id: 'new-cross-leaf',
                source: 'voxel',
                // hypot(3.2, 0, 1.5) = 3.53mm (> 3.0mm already-supported, <= 4.0mm merge radius)
                contact: new THREE.Vector3(3.2, 0, 19.5),
                baseZ: 19.5,
                areaMm2: 1,
                layerSpan: [0, 390],
            }],
            'm',
            { debugSkipAutoBracing: true, stabilizationEnabled: false },
        );

        assert.ok(plan, 'plan computed');
        const orphans = plan.result.analytics?.forestReport?.orphans ?? [];
        assert.ok(orphans.some((o) => o.reason === 'drift'), 'pre-existing drifted leaves were culled');
        assert.ok(orphans.some((o) => o.reason === 'cross'), 'newly placed crossing leaf reported as cross warning');
        assert.equal(plan.support.leaves['pre-drift-1'], undefined);
        assert.equal(plan.support.leaves['pre-drift-2'], undefined);
        assert.equal(Object.keys(plan.support.leaves).length, 1, 'newly placed crossing leaf remains in support state');
        assert.equal(plan.result.placed.leaf, 1, 'placed.leaf counts the surviving new leaf without subtracting cross warnings or before culls');
    } finally {
        resetStore();
        resetKickstandsInState();
        setSettings(prevSettings);
    }
});

