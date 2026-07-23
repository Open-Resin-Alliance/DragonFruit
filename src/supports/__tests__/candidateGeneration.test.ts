import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
    generateCandidates,
    deduplicateCandidates,
    candidateFromIsland,
} from '../autoSupport/candidateGeneration';
import { createDefaultAutoSupportSettings } from '../autoSupport/settings';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';
import type { CandidatePoint } from '../autoSupport/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock DetectedIsland for testing.
 *
 * Defaults: voxel source, contact at (10, 20, baseZ) in world mm,
 * baseZ = 30 (or overrides.baseZ / overrides.contact.z if provided).
 *
 * When overriding contact or baseZ individually, keep them consistent
 * (baseZ should equal contact.z) for realistic test data.
 */
function makeIsland(overrides: Partial<DetectedIsland> = {}): DetectedIsland {
    const baseZ = overrides.baseZ ?? overrides.contact?.z ?? 30;
    return {
        id: 'test-id',
        source: 'voxel',
        contact: new THREE.Vector3(10, 20, baseZ),
        baseZ,
        areaMm2: 0.1,
        ...overrides,
    } as DetectedIsland;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('generateCandidates does not filter by supported flag (handled by filterAlreadySupported)', () => {
    const islands = [
        makeIsland({ id: 'a' }),
        makeIsland({ id: 'b', supported: true }),
        makeIsland({ id: 'c', supported: false }),
    ];
    const settings = createDefaultAutoSupportSettings();
    const candidates = generateCandidates(islands, settings);

    assert.equal(candidates.length, 3);
});

test('generateCandidates does not filter grounded islands (handled upstream by Plate toggle)', () => {
    const islands = [
        makeIsland({ id: 'a' }),
        makeIsland({ id: 'b', grounded: true }),
        makeIsland({ id: 'c', grounded: false }),
    ];
    const settings = createDefaultAutoSupportSettings();
    const candidates = generateCandidates(islands, settings);

    // Grounded filtering is the caller's responsibility — applyFilter()
    // in the Islands panel already respects the Plate toggle.
    assert.equal(candidates.length, 3);
});

test('generateCandidates filters by minIslandAreaMm2', () => {
    const islands = [
        makeIsland({ id: 'a', areaMm2: 0.01 }),
        makeIsland({ id: 'b', areaMm2: 0.05 }),
        makeIsland({ id: 'c', areaMm2: 0.10 }),
    ];
    const settings = {
        ...createDefaultAutoSupportSettings(),
        minIslandAreaMm2: 0.05,
    };
    const candidates = generateCandidates(islands, settings);

    assert.equal(candidates.length, 2);
    const ids = candidates.map((c) => c.id);
    assert.ok(ids.includes('b'));
    assert.ok(ids.includes('c'));
    assert.ok(!ids.includes('a'));
});

test('generateCandidates sorts by priority descending', () => {
    // With the same area, areaScore = 0.6 for all candidates.
    // Priority differentiation comes from zHeight: lower zHeight → higher zScore → higher priority.
    const islands = [
        makeIsland({
            id: 'x',
            baseZ: 2,
            contact: new THREE.Vector3(0, 0, 2),
            areaMm2: 0.1,
        }),
        makeIsland({
            id: 'y',
            baseZ: 8,
            contact: new THREE.Vector3(0, 0, 8),
            areaMm2: 0.1,
        }),
        makeIsland({
            id: 'z',
            baseZ: 5,
            contact: new THREE.Vector3(0, 0, 5),
            areaMm2: 0.1,
        }),
    ];
    const settings = createDefaultAutoSupportSettings();
    const candidates = generateCandidates(islands, settings);

    assert.equal(candidates.length, 3);
    const ids = candidates.map((c) => c.id);
    // x (z=2, priority=0.825) → z (z=5, priority=0.7125) → y (z=8, priority=0.6)
    assert.deepStrictEqual(ids, ['x', 'z', 'y']);
});

test('deduplicateCandidates removes candidates within tipInfluenceRadiusMm', () => {
    // 3 candidates: 2 at the same position, 1 far away.
    const candidates: CandidatePoint[] = [
        {
            id: 'a',
            tipPos: { x: 0, y: 0, z: 5 },
            tipNormal: { x: 0, y: 0, z: -1 },
            modelId: '',
            source: 'voxel',
            islandAreaMm2: 0.1,
            zHeight: 5,
            overhangAngleDeg: 45,
            priority: 0.9,
        },
        {
            id: 'b',
            tipPos: { x: 0, y: 0, z: 5 },
            tipNormal: { x: 0, y: 0, z: -1 },
            modelId: '',
            source: 'voxel',
            islandAreaMm2: 0.1,
            zHeight: 5,
            overhangAngleDeg: 45,
            priority: 0.7,
        },
        {
            id: 'c',
            tipPos: { x: 5, y: 5, z: 5 },
            tipNormal: { x: 0, y: 0, z: -1 },
            modelId: '',
            source: 'voxel',
            islandAreaMm2: 0.1,
            zHeight: 5,
            overhangAngleDeg: 45,
            priority: 0.5,
        },
    ];
    const settings = {
        ...createDefaultAutoSupportSettings(),
        tipInfluenceRadiusMm: 2.0,
    };
    const deduped = deduplicateCandidates(candidates, settings);

    assert.equal(deduped.length, 2);
    const ids = deduped.map((c) => c.id);
    assert.ok(ids.includes('a'), 'higher-priority candidate at overlapping position kept');
    assert.ok(ids.includes('c'), 'far-away candidate kept');
    assert.ok(!ids.includes('b'), 'lower-priority candidate at same position removed');
});

test('candidateFromIsland maps all fields correctly', () => {
    const contact = new THREE.Vector3(12, 34, 56);
    const island = makeIsland({
        id: 'island-1',
        source: 'voxel',
        contact,
        baseZ: 56,
        areaMm2: 2.5,
    });

    const candidate = candidateFromIsland(island);

    assert.equal(candidate.id, 'island-1');
    assert.deepStrictEqual(candidate.tipPos, { x: 12, y: 34, z: 56 });
    assert.equal(candidate.zHeight, 56);
    assert.equal(candidate.islandAreaMm2, 2.5);
    assert.equal(candidate.source, 'voxel');
    assert.equal(candidate.modelId, '');
    assert.deepStrictEqual(candidate.tipNormal, { x: 0, y: 0, z: -1 });
});
