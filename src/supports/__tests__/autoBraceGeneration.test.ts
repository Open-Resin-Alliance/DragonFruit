import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAutoBracedSnapshot } from '../autoBracing/autoBrace';
import { createDefaultAutoBracingSettings } from '../autoBracing/settings';
import type { Roots, SupportState, Trunk } from '../types';

function createRoot(id: string, modelId: string, x: number, y = 0): Roots {
    return {
        id,
        modelId,
        transform: {
            pos: { x, y, z: 0 },
            rot: { x: 0, y: 0, z: 0, w: 1 },
        },
        diameter: 3,
        diskHeight: 0.5,
        coneHeight: 0.5,
    };
}

function createTrunk(id: string, modelId: string, rootId: string, segmentId: string, x: number, y = 0, topZ = 4): Trunk {
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
                    pos: { x, y, z: topZ },
                    diameter: 1.2,
                },
            },
        ],
    };
}

function createEmptySnapshot(): SupportState {
    return {
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
}

test('buildAutoBracedSnapshot replaces old braces and generates braces with valid angles', () => {
    const snapshot = createEmptySnapshot();
    const modelId = 'model-a';

    // Ladder Model 2.0: Braces are at fixed Z levels (Initial + Repeating)
    // Initial at 2.0mm. Repeating at 2+10=12.0mm.
    // For 45°, dz = hDist. 
    // If adjacent supports are 2mm apart, dz = 2mm.
    const rootA = createRoot('root-a', modelId, 0);
    const rootB = createRoot('root-b', modelId, 2);
    const rootC = createRoot('root-c', modelId, 4);

    const trunkA = createTrunk('trunk-a', modelId, rootA.id, 'seg-a', 0, 0, 10);
    const trunkB = createTrunk('trunk-b', modelId, rootB.id, 'seg-b', 2, 0, 10);
    const trunkC = createTrunk('trunk-c', modelId, rootC.id, 'seg-c', 4, 0, 10);

    snapshot.roots[rootA.id] = rootA;
    snapshot.roots[rootB.id] = rootB;
    snapshot.roots[rootC.id] = rootC;

    snapshot.trunks[trunkA.id] = trunkA;
    snapshot.trunks[trunkB.id] = trunkB;
    snapshot.trunks[trunkC.id] = trunkC;

    snapshot.knots['k-old-a'] = {
        id: 'k-old-a',
        parentShaftId: 'seg-a',
        t: 0.5,
        pos: { x: 0, y: 0, z: 3 },
        diameter: 1.1,
    };

    snapshot.braces['brace-old'] = {
        id: 'brace-old',
        modelId,
        startKnotId: 'k-old-a',
        endKnotId: 'k-old-b',
        profile: { diameter: 0.9 },
    };

    const settings = createDefaultAutoBracingSettings();
    const result = buildAutoBracedSnapshot(snapshot, settings);

    assert.equal(result.removedBraceCount, 1);
    assert.equal(result.skippedSupportCount, 0);
    assert.equal(result.changed, true);

    assert.equal(result.snapshot.braces['brace-old'], undefined);
    assert.equal(result.snapshot.knots['k-old-a'], undefined);

    for (const brace of Object.values(result.snapshot.braces)) {
        assert.equal(brace.profile.diameter, settings.braceDiameterMm);
        const sk = result.snapshot.knots[brace.startKnotId]!;
        const ek = result.snapshot.knots[brace.endKnotId]!;
        const hDist = Math.sqrt((ek.pos.x - sk.pos.x) ** 2 + (ek.pos.y - sk.pos.y) ** 2);
        const dz = Math.abs(ek.pos.z - sk.pos.z);
        assert.ok(Math.abs(dz - hDist) < 0.1, `Expected 45 deg (dz=hDist), got dz=${dz}, hDist=${hDist}`);
    }
});

test('buildAutoBracedSnapshot leaves state unchanged when fewer than 3 supports qualify', () => {
    const snapshot = createEmptySnapshot();
    const modelId = 'model-b';

    const rootA = createRoot('root-a', modelId, -2);
    const rootB = createRoot('root-b', modelId, 2);

    const trunkA = createTrunk('trunk-a', modelId, rootA.id, 'seg-a', -2, 0, 10);
    const trunkB = createTrunk('trunk-b', modelId, rootB.id, 'seg-b', 2, 0, 10);

    snapshot.roots[rootA.id] = rootA;
    snapshot.roots[rootB.id] = rootB;
    snapshot.trunks[trunkA.id] = trunkA;
    snapshot.trunks[trunkB.id] = trunkB;

    const settings = createDefaultAutoBracingSettings();
    const result = buildAutoBracedSnapshot(snapshot, settings);

    assert.equal(result.generatedBraceCount, 0);
    assert.equal(result.removedBraceCount, 0);
    assert.equal(result.changed, false);
    assert.equal(result.skippedSupportCount, 2);
});

test('buildAutoBracedSnapshot isolated grouping respects min/max limits', () => {
    const snapshot = createEmptySnapshot();
    const modelId = 'model-group';

    // 10 supports. Max group size = 5. Should form exactly two groups of 5.
    for (let i = 0; i < 10; i++) {
        const root = createRoot(`root-${i}`, modelId, i * 2, 0);
        const trunk = createTrunk(`trunk-${i}`, modelId, root.id, `seg-${i}`, i * 2, 0, 10);
        snapshot.roots[root.id] = root;
        snapshot.trunks[trunk.id] = trunk;
    }

    const settings = { ...createDefaultAutoBracingSettings(), seedSpacingMm: 8, seedJitterMm: 0 };
    const result = buildAutoBracedSnapshot(snapshot, settings);

    // Braces never cross groups. Verify no brace connects trunk-4 (end of group 1) to trunk-5 (start of group 2).
    for (const brace of Object.values(result.snapshot.braces)) {
        const sk = result.snapshot.knots[brace.startKnotId]!;
        const ek = result.snapshot.knots[brace.endKnotId]!;

        const idA = sk.parentShaftId.replace('seg-trunk-', '');
        const idB = ek.parentShaftId.replace('seg-trunk-', '');
        const groupA = Math.floor(parseInt(idA) / 5);
        const groupB = Math.floor(parseInt(idB) / 5);
        assert.equal(groupA, groupB, `Brace ${brace.id} crosses group boundary! ${idA} and ${idB}`);
    }
});

test('buildAutoBracedSnapshot termination respects support height', () => {
    const snapshot = createEmptySnapshot();
    const modelId = 'model-term';

    // Support A is tall (10mm). Support B is short (1mm).
    // Initial brace at 2.0mm. hDist = 2mm.
    // If A is low (2mm) and B is high (2+2=4mm), B top reference (1mm) < 4mm -> REJECTED.
    // If B is low (2mm) and A is high (4mm), B top reference (1mm) < 2mm -> REJECTED.
    const rootA = createRoot('root-a', modelId, 0, 0);
    const rootB = createRoot('root-b', modelId, 2, 0);
    const rootC = createRoot('root-c', modelId, 4, 0);

    const trunkA = createTrunk('trunk-a', modelId, rootA.id, 'seg-a', 0, 0, 10);
    const trunkB = createTrunk('trunk-b', modelId, rootB.id, 'seg-b', 2, 0, 1);
    const trunkC = createTrunk('trunk-c', modelId, rootC.id, 'seg-c', 4, 0, 10);

    snapshot.roots[rootA.id] = rootA;
    snapshot.roots[rootB.id] = rootB;
    snapshot.roots[rootC.id] = rootC;
    snapshot.trunks[trunkA.id] = trunkA;
    snapshot.trunks[trunkB.id] = trunkB;
    snapshot.trunks[trunkC.id] = trunkC;

    const settings = createDefaultAutoBracingSettings();
    const result = buildAutoBracedSnapshot(snapshot, settings);

    // trunk-b should have NO braces attached to it.
    for (const brace of Object.values(result.snapshot.braces)) {
        const sk = result.snapshot.knots[brace.startKnotId]!;
        const ek = result.snapshot.knots[brace.endKnotId]!;
        assert.notEqual(sk.parentShaftId, 'seg-b');
        assert.notEqual(ek.parentShaftId, 'seg-b');
    }
});

test('buildAutoBracedSnapshot respects maxBraceLengthMm during grouping', () => {
    const snapshot = createEmptySnapshot();
    const modelId = 'model-dist-group';

    // 2 supports close (5mm), 3rd support far (20mm).
    // Max bracing distance = 6mm (treated as horizontal span).
    // 1 and 2 should group. 3 should be isolated.
    const root1 = createRoot('root-1', modelId, 0, 0);
    const root2 = createRoot('root-2', modelId, 5, 0); // 5mm gap
    const root3 = createRoot('root-3', modelId, 25, 0); // 20mm gap

    const trunk1 = createTrunk('trunk-1', modelId, root1.id, 'seg-1', 0, 0, 10);
    const trunk2 = createTrunk('trunk-2', modelId, root2.id, 'seg-2', 5, 0, 10);
    const trunk3 = createTrunk('trunk-3', modelId, root3.id, 'seg-3', 25, 0, 10);

    snapshot.roots[root1.id] = root1;
    snapshot.roots[root2.id] = root2;
    snapshot.roots[root3.id] = root3;
    snapshot.trunks[trunk1.id] = trunk1;
    snapshot.trunks[trunk2.id] = trunk2;
    snapshot.trunks[trunk3.id] = trunk3;

    const settings = { ...createDefaultAutoBracingSettings(), maxBraceLengthMm: 6 };
    const result = buildAutoBracedSnapshot(snapshot, settings);

    // trunk-1 and trunk-2 should have a brace. trunk-3 should have NONE.
    let hasBrace3 = false;
    let hasBrace1_2 = false;
    for (const brace of Object.values(result.snapshot.braces)) {
        const sk = result.snapshot.knots[brace.startKnotId]!;
        const ek = result.snapshot.knots[brace.endKnotId]!;
        if (sk.parentShaftId === 'seg-3' || ek.parentShaftId === 'seg-3') hasBrace3 = true;
        if ((sk.parentShaftId === 'seg-1' && ek.parentShaftId === 'seg-2') ||
            (sk.parentShaftId === 'seg-2' && ek.parentShaftId === 'seg-1')) hasBrace1_2 = true;
    }
    assert.equal(hasBrace1_2, true, 'Trunk 1 and 2 should be braced (5mm gap < 6mm limit)');
    assert.equal(hasBrace3, false, 'Trunk 3 should not be braced as it is too far from the group');
});
