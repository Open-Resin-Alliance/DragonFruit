import assert from 'node:assert/strict';
import test from 'node:test';

import {
    planSupportTree,
    clusterCandidates,
    selectCoreCandidate,
    computeCandidateDistance,
} from '../autoSupport/treeFanOut';

import type { CandidatePoint } from '../autoSupport/types';

import { createDefaultAutoSupportSettings } from '../autoSupport/settings';

function makeCandidate(overrides: Partial<CandidatePoint> = {}): CandidatePoint {
    return {
        id: overrides.id ?? 'c1',
        tipPos: overrides.tipPos ?? { x: 10, y: 20, z: 30 },
        tipNormal: overrides.tipNormal ?? { x: 0, y: 0, z: -1 },
        modelId: overrides.modelId ?? 'model-1',
        source: overrides.source ?? 'voxel',
        islandAreaMm2: overrides.islandAreaMm2 ?? 0.5,
        zHeight: overrides.zHeight ?? 30,
        overhangAngleDeg: overrides.overhangAngleDeg ?? 45,
        priority: overrides.priority ?? 0.5,
    };
}

// ---------------------------------------------------------------------------
// 1. anchors for low-Z
// ---------------------------------------------------------------------------

test('anchors for low-Z', () => {
    const settings = createDefaultAutoSupportSettings();
    const candidate = makeCandidate({ id: 'low', zHeight: 3 });

    const plan = planSupportTree([candidate], settings);

    assert.equal(plan.anchors.length, 1);
    assert.equal(plan.anchors[0].candidate.id, 'low');
    assert.equal(plan.trunks.length, 0);
});

// ---------------------------------------------------------------------------
// 2. standalone trunk for isolated candidate
// ---------------------------------------------------------------------------

test('standalone trunk for isolated candidate', () => {
    const settings = createDefaultAutoSupportSettings();
    const solo = makeCandidate({ id: 'solo', zHeight: 10 });

    const plan = planSupportTree([solo], settings);

    assert.equal(plan.trunks.length, 1);
    assert.equal(plan.trunks[0].candidate.id, 'solo');
    assert.equal(plan.anchors.length, 0);
    assert.equal(plan.branches.length, 0);
    assert.equal(plan.leaves.length, 0);
});

// ---------------------------------------------------------------------------
// 3. tree cluster for nearby candidates
// ---------------------------------------------------------------------------

test('tree cluster for nearby candidates', () => {
    const settings = createDefaultAutoSupportSettings();
    // Three candidates within a single 15mm grid cell → one cluster
    const core = makeCandidate({
        id: 'core',
        tipPos: { x: 10, y: 10, z: 30 },
        islandAreaMm2: 3.0,
        zHeight: 30,
    });
    const satA = makeCandidate({
        id: 'satA',
        tipPos: { x: 20, y: 10, z: 30 },
        islandAreaMm2: 0.5,
        zHeight: 30,
    });
    const satB = makeCandidate({
        id: 'satB',
        tipPos: { x: 10, y: 20, z: 30 },
        islandAreaMm2: 0.3,
        zHeight: 30,
    });

    const plan = planSupportTree([core, satA, satB], settings);

    // Core (largest area) becomes the trunk
    assert.equal(plan.trunks.length, 1);
    assert.equal(plan.trunks[0].candidate.id, 'core');

    // Satellites are 10mm from core (>2.5mm MAX_LEAF_SPAN, <=20mm maxBranchReach)
    // → both become branches
    assert.equal(plan.branches.length, 2);
    const branchIds = plan.branches.map(b => b.candidate.id).sort();
    assert.deepEqual(branchIds, ['satA', 'satB']);

    assert.equal(plan.leaves.length, 0);
    assert.equal(plan.anchors.length, 0);
});

// ---------------------------------------------------------------------------
// 4. clusterCandidates groups by proximity
// ---------------------------------------------------------------------------

test('clusterCandidates groups by proximity', () => {
    const clusterRadiusMm = 15;
    // Two close pairs and one far-away solitary → 3 clusters
    const a1 = makeCandidate({ id: 'a1', tipPos: { x: 0, y: 0, z: 30 } });
    const a2 = makeCandidate({ id: 'a2', tipPos: { x: 10, y: 10, z: 30 } });
    const b1 = makeCandidate({ id: 'b1', tipPos: { x: 100, y: 0, z: 30 } });
    const b2 = makeCandidate({ id: 'b2', tipPos: { x: 110, y: 10, z: 30 } });
    const solo = makeCandidate({ id: 'solo', tipPos: { x: 200, y: 200, z: 30 } });

    const clusters = clusterCandidates([a1, a2, b1, b2, solo], clusterRadiusMm);

    assert.equal(clusters.length, 3);

    const clusterIds = clusters
        .map(c => c.map(p => p.id).sort().join(','))
        .sort();

    assert.deepEqual(clusterIds, ['a1,a2', 'b1,b2', 'solo']);
});

// ---------------------------------------------------------------------------
// 5. selectCoreCandidate picks best
// ---------------------------------------------------------------------------

test('selectCoreCandidate picks best', () => {
    // Score: 60% area (normalized) + 40% lower-Z (normalized via 1 - z/maxZ)
    const best = makeCandidate({
        id: 'best',
        islandAreaMm2: 3.0,
        zHeight: 10,
    });
    const smallHigh = makeCandidate({
        id: 'smallHigh',
        islandAreaMm2: 1.0,
        zHeight: 20,
    });

    const core = selectCoreCandidate([smallHigh, best]);

    // best: areaScore=0.6*(3/3)=0.60, zScore=0.4*(1-10/20)=0.20 → 0.80
    // smallHigh: areaScore=0.6*(1/3)=0.20, zScore=0.4*(1-20/20)=0.00 → 0.20
    assert.equal(core.id, 'best');
});

// ---------------------------------------------------------------------------
// 6. computeCandidateDistance
// ---------------------------------------------------------------------------

test('computeCandidateDistance', () => {
    const a = makeCandidate({ id: 'a', tipPos: { x: 0, y: 0, z: 0 } });
    const b = makeCandidate({ id: 'b', tipPos: { x: 3, y: 4, z: 12 } });

    const dist = computeCandidateDistance(a, b);
    // sqrt(3² + 4² + 12²) = sqrt(9 + 16 + 144) = sqrt(169) = 13
    assert.equal(dist, 13);
});

// ---------------------------------------------------------------------------
// 7. maxBranchReachMm limits fan-out
// ---------------------------------------------------------------------------

test('maxBranchReachMm limits fan-out', () => {
    const settings = createDefaultAutoSupportSettings();
    settings.maxBranchReachMm = 5;

    const core = makeCandidate({
        id: 'core',
        tipPos: { x: 10, y: 10, z: 30 },
        islandAreaMm2: 3.0,
        zHeight: 30,
    });
    // 10mm away from core (> maxBranchReachMm of 5) → standalone trunk
    const farSat = makeCandidate({
        id: 'farSat',
        tipPos: { x: 20, y: 10, z: 30 },
        islandAreaMm2: 0.5,
        zHeight: 30,
    });

    const plan = planSupportTree([core, farSat], settings);

    // Both end up as standalone trunks
    assert.equal(plan.trunks.length, 2);
    const trunkIds = plan.trunks.map(t => t.candidate.id).sort();
    assert.deepEqual(trunkIds, ['core', 'farSat']);

    assert.equal(plan.branches.length, 0);
    assert.equal(plan.leaves.length, 0);
});
