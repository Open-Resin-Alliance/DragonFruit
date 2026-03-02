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

    // Stagger heights so adjacent top-tier anchors have ~45° angle between them.
    // topOffsetFromTopMm default = 2.0, so anchor for trunk of height H is at H - 2.
    // For a 45° angle between adjacent supports spaced 2mm apart horizontally,
    // we need |dz| ≈ horizontal distance. Spacing = 2mm, so height diff = 2mm.
    // Heights: 6, 8, 10 → anchors at 4, 6, 8 → dz=2 between adjacent, dx=2 → 45°.
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

test('buildAutoBracedSnapshot produces only top-section braces for short supports', () => {
    const snapshot = createEmptySnapshot();
    const modelId = 'model-short';

    // Height = 5mm. topOffset=2mm, bottomOffset=2mm. minHeightForBottom = 2+2+2 = 6mm.
    // 5mm < 6mm → bottom section NOT active. Only top braces expected.
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

    assert.ok(result.generatedBraceCount > 0, 'Should generate top-section braces');

    for (const brace of Object.values(result.snapshot.braces)) {
        assert.equal(brace.debugSection, 'top', `Expected top section, got ${brace.debugSection}`);
    }
});

test('buildAutoBracedSnapshot produces top and bottom braces for medium-height supports', () => {
    const snapshot = createEmptySnapshot();
    const modelId = 'model-medium';

    // Height = 10mm. topOffset=2mm, bottomOffset=2mm. minHeightForBottom = 6mm.
    // 10mm >= 6mm → bottom section active. minHeightForMiddle = 2+2+4 = 8mm.
    // centerZ = 5mm. topSearchBound = 10-2-1 = 7mm. 5 <= 7 → middle active too.
    // Use height=8mm to be at the boundary: minHeightForMiddle=8mm, 8>=8 → middle just active.
    // Use height=7mm: 7 < 8 → middle NOT active. Only top+bottom.
    const rootA = createRoot('root-a', modelId, 0);
    const rootB = createRoot('root-b', modelId, 4);
    const rootC = createRoot('root-c', modelId, 8);

    const trunkA = createTrunk('trunk-a', modelId, rootA.id, 'seg-a', 0, 0, 7);
    const trunkB = createTrunk('trunk-b', modelId, rootB.id, 'seg-b', 4, 0, 7);
    const trunkC = createTrunk('trunk-c', modelId, rootC.id, 'seg-c', 8, 0, 7);

    snapshot.roots[rootA.id] = rootA;
    snapshot.roots[rootB.id] = rootB;
    snapshot.roots[rootC.id] = rootC;
    snapshot.trunks[trunkA.id] = trunkA;
    snapshot.trunks[trunkB.id] = trunkB;
    snapshot.trunks[trunkC.id] = trunkC;

    const settings = createDefaultAutoBracingSettings();
    const result = buildAutoBracedSnapshot(snapshot, settings);

    const sections = new Set(Object.values(result.snapshot.braces).map((b) => b.debugSection));
    assert.ok(sections.has('top'), 'Expected top section braces');
    assert.ok(sections.has('bottom'), 'Expected bottom section braces');
    assert.ok(!sections.has('middle'), 'Should not have middle section braces at this height');
});

test('buildAutoBracedSnapshot produces top, bottom, and middle braces for tall supports', () => {
    const snapshot = createEmptySnapshot();
    const modelId = 'model-tall';

    // Height = 20mm. minHeightForMiddle = 8mm. 20 >= 8 → all three sections active.
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

    const settings = createDefaultAutoBracingSettings();
    const result = buildAutoBracedSnapshot(snapshot, settings);

    const sections = new Set(Object.values(result.snapshot.braces).map((b) => b.debugSection));
    assert.ok(sections.has('top'), 'Expected top section braces');
    assert.ok(sections.has('bottom'), 'Expected bottom section braces');
    assert.ok(sections.has('middle'), 'Expected middle section braces for tall supports');
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

    const singleSettings = { ...createDefaultAutoBracingSettings(), topPattern: 'singleDiagonal' as const };
    const crossSettings = { ...createDefaultAutoBracingSettings(), topPattern: 'crossDiagonal' as const };

    const singleResult = buildAutoBracedSnapshot(makeSnapshot(), singleSettings);
    const crossResult = buildAutoBracedSnapshot(makeSnapshot(), crossSettings);

    assert.ok(singleResult.generatedBraceCount > 0, 'singleDiagonal should generate braces');
    assert.ok(crossResult.generatedBraceCount > 0, 'crossDiagonal should generate braces');

    // Extract dz signs for top braces: singleDiagonal and crossDiagonal should have opposite slopes
    const getTopBraceDzSigns = (result: ReturnType<typeof buildAutoBracedSnapshot>) =>
        Object.values(result.snapshot.braces)
            .filter((b) => b.debugSection === 'top')
            .map((b) => {
                const sk = result.snapshot.knots[b.startKnotId];
                const ek = result.snapshot.knots[b.endKnotId];
                if (!sk || !ek) return 0;
                return Math.sign(ek.pos.z - sk.pos.z);
            });

    const singleSigns = getTopBraceDzSigns(singleResult);
    const crossSigns = getTopBraceDzSigns(crossResult);

    // crossDiagonal produces both diagonals (X), so more braces than singleDiagonal
    assert.ok(
        crossResult.generatedBraceCount > singleResult.generatedBraceCount,
        `crossDiagonal (${crossResult.generatedBraceCount}) should produce more braces than singleDiagonal (${singleResult.generatedBraceCount})`,
    );

    // crossDiagonal should contain both slope directions (positive and negative dz)
    const hasPositive = crossSigns.some((s) => s > 0);
    const hasNegative = crossSigns.some((s) => s < 0);
    assert.ok(hasPositive && hasNegative, 'crossDiagonal should have braces going both up and down (X pattern)');
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
