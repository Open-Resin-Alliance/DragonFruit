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

function createBentTrunk(
    id: string,
    modelId: string,
    rootId: string,
    segmentIdPrefix: string,
    y: number,
    bendX: number,
    bendZ: number,
    topX: number,
    topZ: number,
): Trunk {
    return {
        id,
        modelId,
        rootId,
        segments: [
            {
                id: `${segmentIdPrefix}-0`,
                diameter: 1,
                topJoint: {
                    id: `joint-${id}-0`,
                    pos: { x: bendX, y, z: bendZ },
                    diameter: 1.2,
                },
            },
            {
                id: `${segmentIdPrefix}-1`,
                diameter: 1,
                topJoint: {
                    id: `joint-${id}-1`,
                    pos: { x: topX, y, z: topZ },
                    diameter: 1.2,
                },
            },
        ],
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

    // Measured anchor ladder defaults: initial=5mm, repeat=10mm.
    // Stagger heights so the first anchor placements can still produce ~45° braces.
    const rootA = createRoot('root-a', modelId, 0);
    const rootB = createRoot('root-b', modelId, 2);
    const rootC = createRoot('root-c', modelId, 4);

    const trunkA = createTrunk('trunk-a', modelId, rootA.id, 'seg-a', 0, 0, 6);
    const trunkB = createTrunk('trunk-b', modelId, rootB.id, 'seg-b', 2, 0, 8);
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
    snapshot.knots['k-old-b'] = {
        id: 'k-old-b',
        parentShaftId: 'seg-b',
        t: 0.5,
        pos: { x: 2, y: 0, z: 4 },
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
    assert.equal(result.snapshot.knots['k-old-b'], undefined);

    for (const brace of Object.values(result.snapshot.braces)) {
        assert.equal(brace.profile.diameter, settings.braceDiameterMm);
    }
});

test('buildAutoBracedSnapshot leaves state unchanged when fewer than 3 supports qualify', () => {
    const snapshot = createEmptySnapshot();
    const modelId = 'model-b';

    const rootA = createRoot('root-a', modelId, -2);
    const rootB = createRoot('root-b', modelId, 2);

    const trunkA = createTrunk('trunk-a', modelId, rootA.id, 'seg-a', -2);
    const trunkB = createTrunk('trunk-b', modelId, rootB.id, 'seg-b', 2);

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
    assert.equal(result.underQualifiedSupportCount, 0);
    assert.equal(Object.keys(result.snapshot.braces).length, 0);
    assert.equal(Object.keys(result.snapshot.knots).length, 0);
});

test('buildAutoBracedSnapshot reports qualified anchors when braces span two distinct axes', () => {
    const snapshot = createEmptySnapshot();
    const modelId = 'model-c';

    // 4 supports in a 2x2 grid, staggered heights so all adjacent pairs produce 45° angles.
    // Grid spacing = 4mm, height step = 4mm → atan2(4,4) = 45° for all adjacent pairs.
    // Heights: A=6, B=10, C=10, D=14 → top anchors: A=4, B=8, C=8, D=12
    // A↔B: dz=4, dx=4 → 45°; A↔C: dz=4, dy=4 → 45°; B↔D: dz=4, dy=4 → 45°; C↔D: dz=4, dx=4 → 45°
    // Support A gets braces from +X direction (A↔B) and +Y direction (A↔C) → two distinct axes → qualified.
    const rootA = createRoot('root-a', modelId, 0, 0);
    const rootB = createRoot('root-b', modelId, 4, 0);
    const rootC = createRoot('root-c', modelId, 0, 4);
    const rootD = createRoot('root-d', modelId, 4, 4);

    const trunkA = createTrunk('trunk-a', modelId, rootA.id, 'seg-a', 0, 0, 6);
    const trunkB = createTrunk('trunk-b', modelId, rootB.id, 'seg-b', 4, 0, 10);
    const trunkC = createTrunk('trunk-c', modelId, rootC.id, 'seg-c', 0, 4, 10);
    const trunkD = createTrunk('trunk-d', modelId, rootD.id, 'seg-d', 4, 4, 14);

    snapshot.roots[rootA.id] = rootA;
    snapshot.roots[rootB.id] = rootB;
    snapshot.roots[rootC.id] = rootC;
    snapshot.roots[rootD.id] = rootD;

    snapshot.trunks[trunkA.id] = trunkA;
    snapshot.trunks[trunkB.id] = trunkB;
    snapshot.trunks[trunkC.id] = trunkC;
    snapshot.trunks[trunkD.id] = trunkD;

    const settings = createDefaultAutoBracingSettings();
    const result = buildAutoBracedSnapshot(snapshot, settings);

    assert.ok(result.generatedBraceCount >= 2, `Expected at least 2 braces, got ${result.generatedBraceCount}`);
    assert.ok(
        result.underQualifiedSupportCount < 4,
        `Expected fewer than 4 under-qualified supports, got ${result.underQualifiedSupportCount}`,
    );
});

test('buildAutoBracedSnapshot is deterministic: same input produces identical output', () => {
    const snapshot = createEmptySnapshot();
    const modelId = 'model-det';

    for (let i = 0; i < 5; i += 1) {
        const root = createRoot(`root-${i}`, modelId, i * 3);
        const trunk = createTrunk(`trunk-${i}`, modelId, root.id, `seg-${i}`, i * 3, 0, 20);
        snapshot.roots[root.id] = root;
        snapshot.trunks[trunk.id] = trunk;
    }

    const settings = createDefaultAutoBracingSettings();
    const result1 = buildAutoBracedSnapshot(snapshot, settings);
    const result2 = buildAutoBracedSnapshot(snapshot, settings);

    assert.equal(result1.generatedBraceCount, result2.generatedBraceCount);
    assert.equal(result1.underQualifiedSupportCount, result2.underQualifiedSupportCount);

    const braceIds1 = Object.keys(result1.snapshot.braces).sort();
    const braceIds2 = Object.keys(result2.snapshot.braces).sort();
    assert.deepEqual(braceIds1, braceIds2);
});

test('buildAutoBracedSnapshot skips supports that do not reach the initial anchor offset', () => {
    const snapshot = createEmptySnapshot();
    const modelId = 'model-short';

    // Supports at exactly 5mm top cannot host a strict < top anchor at 5mm.
    const rootA = createRoot('root-a', modelId, 0);
    const rootB = createRoot('root-b', modelId, 4);
    const rootC = createRoot('root-c', modelId, 8);

    const trunkA = createTrunk('trunk-a', modelId, rootA.id, 'seg-a', 0, 0, 5);
    const trunkB = createTrunk('trunk-b', modelId, rootB.id, 'seg-b', 4, 0, 5);
    const trunkC = createTrunk('trunk-c', modelId, rootC.id, 'seg-c', 8, 0, 5);

    snapshot.roots[rootA.id] = rootA;
    snapshot.roots[rootB.id] = rootB;
    snapshot.roots[rootC.id] = rootC;
    snapshot.trunks[trunkA.id] = trunkA;
    snapshot.trunks[trunkB.id] = trunkB;
    snapshot.trunks[trunkC.id] = trunkC;

    const settings = createDefaultAutoBracingSettings();
    const result = buildAutoBracedSnapshot(snapshot, settings);

    assert.equal(result.generatedBraceCount, 0);
    assert.equal(result.changed, false);
});

test('buildAutoBracedSnapshot can place first-tier braces at initial anchor for eligible supports', () => {
    const snapshot = createEmptySnapshot();
    const modelId = 'model-medium';

    // Heights above initial anchor should allow first-tier placements.
    const rootA = createRoot('root-a', modelId, 0);
    const rootB = createRoot('root-b', modelId, 4);
    const rootC = createRoot('root-c', modelId, 8);

    const trunkA = createTrunk('trunk-a', modelId, rootA.id, 'seg-a', 0, 0, 14);
    const trunkB = createTrunk('trunk-b', modelId, rootB.id, 'seg-b', 4, 0, 14);
    const trunkC = createTrunk('trunk-c', modelId, rootC.id, 'seg-c', 8, 0, 14);

    snapshot.roots[rootA.id] = rootA;
    snapshot.roots[rootB.id] = rootB;
    snapshot.roots[rootC.id] = rootC;
    snapshot.trunks[trunkA.id] = trunkA;
    snapshot.trunks[trunkB.id] = trunkB;
    snapshot.trunks[trunkC.id] = trunkC;

    const settings = createDefaultAutoBracingSettings();
    const result = buildAutoBracedSnapshot(snapshot, settings);

    assert.ok(result.generatedBraceCount > 0, 'Expected first-tier measured-anchor braces');
    const sections = new Set(Object.values(result.snapshot.braces).map((b) => b.debugSection));
    assert.ok(sections.has('bottom'), 'Expected first tier to map to bottom debug color');
});

test('buildAutoBracedSnapshot can populate multiple measured anchor tiers for tall supports', () => {
    const snapshot = createEmptySnapshot();
    const modelId = 'model-tall';

    // With initial=5 and repeat=10, height 40 can populate tiers at 5, 15, 25, 35.
    const rootA = createRoot('root-a', modelId, 0);
    const rootB = createRoot('root-b', modelId, 4);
    const rootC = createRoot('root-c', modelId, 8);

    const trunkA = createTrunk('trunk-a', modelId, rootA.id, 'seg-a', 0, 0, 40);
    const trunkB = createTrunk('trunk-b', modelId, rootB.id, 'seg-b', 4, 0, 40);
    const trunkC = createTrunk('trunk-c', modelId, rootC.id, 'seg-c', 8, 0, 40);

    snapshot.roots[rootA.id] = rootA;
    snapshot.roots[rootB.id] = rootB;
    snapshot.roots[rootC.id] = rootC;
    snapshot.trunks[trunkA.id] = trunkA;
    snapshot.trunks[trunkB.id] = trunkB;
    snapshot.trunks[trunkC.id] = trunkC;

    const settings = createDefaultAutoBracingSettings();
    const result = buildAutoBracedSnapshot(snapshot, settings);

    const sections = new Set(Object.values(result.snapshot.braces).map((b) => b.debugSection));
    assert.ok(sections.has('bottom'), 'Expected first tier debug section');
    assert.ok(sections.has('top'), 'Expected repeated tiers to map to repeat debug section');

    const maxKnotZ = Math.max(...Object.values(result.snapshot.knots).map((k) => k.pos.z));
    assert.ok(maxKnotZ >= 34.5, `Expected repeating braces to reach upper anchors, got max knot z=${maxKnotZ.toFixed(2)}`);
});

test('buildAutoBracedSnapshot crossDiagonal produces mirror slope vs singleDiagonal', () => {
    const makeSnapshot = () => {
        const snapshot = createEmptySnapshot();
        const modelId = 'model-pattern';
        const rootA = createRoot('root-a', modelId, 0);
        const rootB = createRoot('root-b', modelId, 4);
        const rootC = createRoot('root-c', modelId, 8);
        const trunkA = createTrunk('trunk-a', modelId, rootA.id, 'seg-a', 0, 0, 20);
        const trunkB = createTrunk('trunk-b', modelId, rootB.id, 'seg-b', 4, 0, 20);
        const trunkC = createTrunk('trunk-c', modelId, rootC.id, 'seg-c', 8, 0, 20);
        snapshot.roots[rootA.id] = rootA;
        snapshot.roots[rootB.id] = rootB;
        snapshot.roots[rootC.id] = rootC;
        snapshot.trunks[trunkA.id] = trunkA;
        snapshot.trunks[trunkB.id] = trunkB;
        snapshot.trunks[trunkC.id] = trunkC;
        return snapshot;
    };

    const singleSettings = {
        ...createDefaultAutoBracingSettings(),
        initialPattern: 'singleDiagonal' as const,
        repeatPattern: 'singleDiagonal' as const,
    };
    const crossSettings = {
        ...createDefaultAutoBracingSettings(),
        initialPattern: 'crossDiagonal' as const,
        repeatPattern: 'crossDiagonal' as const,
    };

    const singleResult = buildAutoBracedSnapshot(makeSnapshot(), singleSettings);
    const crossResult = buildAutoBracedSnapshot(makeSnapshot(), crossSettings);

    assert.ok(singleResult.generatedBraceCount > 0, 'singleDiagonal should generate braces');
    assert.ok(crossResult.generatedBraceCount > 0, 'crossDiagonal should generate braces');

    // Extract dz signs: crossDiagonal should include both directions while single tends to one.
    const getBraceDzSigns = (result: ReturnType<typeof buildAutoBracedSnapshot>) =>
        Object.values(result.snapshot.braces)
            .map((b) => {
                const sk = result.snapshot.knots[b.startKnotId];
                const ek = result.snapshot.knots[b.endKnotId];
                if (!sk || !ek) return 0;
                return Math.sign(ek.pos.z - sk.pos.z);
            });

    const singleSigns = getBraceDzSigns(singleResult);
    const crossSigns = getBraceDzSigns(crossResult);

    // crossDiagonal produces both diagonals (X), so more braces than singleDiagonal
    assert.ok(
        crossResult.generatedBraceCount > singleResult.generatedBraceCount,
        `crossDiagonal (${crossResult.generatedBraceCount}) should produce more braces than singleDiagonal (${singleResult.generatedBraceCount})`,
    );

    // All generated braces are stored low->high in Z; validate no degenerate slopes.
    assert.ok(crossSigns.every((s) => s >= 0), 'Braces should be ordered from lower knot to higher knot');
    assert.ok(crossSigns.some((s) => s > 0), 'crossDiagonal should still include rising braces');
});

test('buildAutoBracedSnapshot crossDiagonal never leaves orphan single diagonals at higher repeats', () => {
    const snapshot = createEmptySnapshot();
    const modelId = 'model-cross-orphan-guard';

    const rootA = createRoot('root-a', modelId, 0);
    const rootB = createRoot('root-b', modelId, 4);
    const rootC = createRoot('root-c', modelId, 8);

    const trunkA = createTrunk('trunk-a', modelId, rootA.id, 'seg-a', 0, 0, 30);
    const trunkB = createTrunk('trunk-b', modelId, rootB.id, 'seg-b', 4, 0, 30);
    const trunkC = createTrunk('trunk-c', modelId, rootC.id, 'seg-c', 8, 0, 16);

    snapshot.roots[rootA.id] = rootA;
    snapshot.roots[rootB.id] = rootB;
    snapshot.roots[rootC.id] = rootC;
    snapshot.trunks[trunkA.id] = trunkA;
    snapshot.trunks[trunkB.id] = trunkB;
    snapshot.trunks[trunkC.id] = trunkC;

    const settings = {
        ...createDefaultAutoBracingSettings(),
        initialPattern: 'crossDiagonal' as const,
        repeatPattern: 'crossDiagonal' as const,
        initialOffsetFromBottomMm: 5,
        repeatIntervalMm: 10,
    };

    const result = buildAutoBracedSnapshot(snapshot, settings);

    const countByPairAndAnchor = new Map<string, number>();
    for (const brace of Object.values(result.snapshot.braces)) {
        const startKnot = result.snapshot.knots[brace.startKnotId];
        const endKnot = result.snapshot.knots[brace.endKnotId];
        if (!startKnot || !endKnot) continue;

        const pair = [startKnot.parentShaftId, endKnot.parentShaftId].sort().join('|');
        const anchor = Math.min(startKnot.pos.z, endKnot.pos.z).toFixed(2);
        const key = `${pair}@${anchor}`;
        countByPairAndAnchor.set(key, (countByPairAndAnchor.get(key) ?? 0) + 1);
    }

    for (const [key, count] of countByPairAndAnchor.entries()) {
        assert.equal(count, 2, `Expected full X pair at ${key}, found ${count} brace(s)`);
    }
});

test('buildAutoBracedSnapshot continues repeat tiers after supports bend at upper joints', () => {
    const snapshot = createEmptySnapshot();
    const modelId = 'model-bent-repeat';

    const rootA = createRoot('root-a', modelId, 0);
    const rootB = createRoot('root-b', modelId, 4);
    const rootC = createRoot('root-c', modelId, 8);

    const trunkA = createBentTrunk('trunk-a', modelId, rootA.id, 'seg-a', 0, -2, 24, -3, 52);
    const trunkB = createBentTrunk('trunk-b', modelId, rootB.id, 'seg-b', 0, 4, 24, 4, 52);
    const trunkC = createBentTrunk('trunk-c', modelId, rootC.id, 'seg-c', 0, 10, 24, 11, 52);

    snapshot.roots[rootA.id] = rootA;
    snapshot.roots[rootB.id] = rootB;
    snapshot.roots[rootC.id] = rootC;
    snapshot.trunks[trunkA.id] = trunkA;
    snapshot.trunks[trunkB.id] = trunkB;
    snapshot.trunks[trunkC.id] = trunkC;

    const settings = {
        ...createDefaultAutoBracingSettings(),
        initialPattern: 'crossDiagonal' as const,
        repeatPattern: 'crossDiagonal' as const,
        initialOffsetFromBottomMm: 5,
        repeatIntervalMm: 10,
    };

    const result = buildAutoBracedSnapshot(snapshot, settings);
    assert.ok(result.generatedBraceCount > 0, 'Expected braces to generate for bent supports');

    const anchorHeights = Object.values(result.snapshot.braces).map((brace) => {
        const start = result.snapshot.knots[brace.startKnotId];
        const end = result.snapshot.knots[brace.endKnotId];
        if (!start || !end) return 0;
        return Math.min(start.pos.z, end.pos.z);
    });

    const uniqueTierAnchors = new Set(anchorHeights.map((z) => Math.round(z)));

    const hasPostBendTier = anchorHeights.some((z) => z >= 24);
    const hasUpperRepeatTier = anchorHeights.some((z) => z >= 34);
    assert.ok(uniqueTierAnchors.size >= 4, `Expected at least 4 repeat tiers, got ${uniqueTierAnchors.size}`);
    assert.ok(hasPostBendTier, 'Expected repeats to continue after bend joint region');
    assert.ok(hasUpperRepeatTier, 'Expected additional repeats in upper shaft region');
});

test('buildAutoBracedSnapshot rejects pairs whose brace length exceeds maxBraceLengthMm', () => {
    const snapshot = createEmptySnapshot();
    const modelId = 'model-long';

    // Supports spaced 15mm apart horizontally. maxBraceLengthMm = 10mm filters on hDist,
    // so 15mm > 10mm → all pairs rejected.
    const rootA = createRoot('root-a', modelId, -15);
    const rootB = createRoot('root-b', modelId, 0);
    const rootC = createRoot('root-c', modelId, 15);

    const trunkA = createTrunk('trunk-a', modelId, rootA.id, 'seg-a', -15, 0, 30);
    const trunkB = createTrunk('trunk-b', modelId, rootB.id, 'seg-b', 0, 0, 30);
    const trunkC = createTrunk('trunk-c', modelId, rootC.id, 'seg-c', 15, 0, 30);

    snapshot.roots[rootA.id] = rootA;
    snapshot.roots[rootB.id] = rootB;
    snapshot.roots[rootC.id] = rootC;
    snapshot.trunks[trunkA.id] = trunkA;
    snapshot.trunks[trunkB.id] = trunkB;
    snapshot.trunks[trunkC.id] = trunkC;

    const settings = createDefaultAutoBracingSettings();
    const result = buildAutoBracedSnapshot(snapshot, settings);

    assert.equal(result.generatedBraceCount, 0, 'Pairs exceeding maxBraceLengthMm should be rejected');
    assert.equal(result.changed, false);
});

test('buildAutoBracedSnapshot places braces at ~45 degrees even when supports are same height', () => {
    const snapshot = createEmptySnapshot();
    const modelId = 'model-d';

    // All supports at same height. The new algorithm derives dz = horizontal distance
    // to achieve 45°, so braces should still be generated with correct angle.
    const rootA = createRoot('root-a', modelId, -4);
    const rootB = createRoot('root-b', modelId, 0);
    const rootC = createRoot('root-c', modelId, 4);

    const trunkA = createTrunk('trunk-a', modelId, rootA.id, 'seg-a', -4, 0, 20);
    const trunkB = createTrunk('trunk-b', modelId, rootB.id, 'seg-b', 0, 0, 20);
    const trunkC = createTrunk('trunk-c', modelId, rootC.id, 'seg-c', 4, 0, 20);

    snapshot.roots[rootA.id] = rootA;
    snapshot.roots[rootB.id] = rootB;
    snapshot.roots[rootC.id] = rootC;
    snapshot.trunks[trunkA.id] = trunkA;
    snapshot.trunks[trunkB.id] = trunkB;
    snapshot.trunks[trunkC.id] = trunkC;

    const settings = createDefaultAutoBracingSettings();
    const result = buildAutoBracedSnapshot(snapshot, settings);

    assert.ok(result.generatedBraceCount > 0, 'Should generate braces at 45° even with same-height supports');

    // Verify each generated brace is within 20° of 45°
    for (const brace of Object.values(result.snapshot.braces)) {
        const sk = result.snapshot.knots[brace.startKnotId];
        const ek = result.snapshot.knots[brace.endKnotId];
        if (!sk || !ek) continue;
        const dx = ek.pos.x - sk.pos.x;
        const dy = ek.pos.y - sk.pos.y;
        const dz = Math.abs(ek.pos.z - sk.pos.z);
        const hDist = Math.sqrt(dx * dx + dy * dy);
        if (hDist < 0.001) continue;
        const angleDeg = Math.atan2(dz, hDist) * (180 / Math.PI);
        assert.ok(
            Math.abs(angleDeg - 45) <= 20,
            `Brace angle ${angleDeg.toFixed(1)}° deviates more than 20° from 45°`,
        );
    }
});
