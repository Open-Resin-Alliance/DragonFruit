import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { footprintFromPoints } from '@/volumeAnalysis/Islands/voxelFootprint';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';
import { cullLoadSurplusStandaloneOverhangs } from '../autoSupport/autoPlace';
import type { ForestLedgerEntry } from '../autoSupport/types';
import type { SupportState } from '../types';

function draftWithStandalone(): SupportState {
    const draft = {
        roots: {}, trunks: {}, branches: {}, leaves: {}, twigs: {}, sticks: {},
        braces: {}, anchors: {}, kickstands: {}, knots: {},
        selectedId: null, selectedCategory: null,
        hoveredId: null, hoveredCategory: 'none', interactionWarning: null,
    } as unknown as SupportState;
    (draft.roots as Record<string, unknown>).root = {
        id: 'root', modelId: 'm', transform: { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
        diameter: 2, diskHeight: 0.5, coneHeight: 1,
    };
    (draft.trunks as Record<string, unknown>).t = {
        id: 't', modelId: 'm', rootId: 'root', origin: 'standalone',
        segments: [{
            id: 'seg', diameter: 1,
            bottomJoint: { id: 'b', pos: { x: 0, y: 0, z: 0 }, diameter: 1 },
            topJoint: { id: 'top', pos: { x: 0, y: 0, z: 10 }, diameter: 1 },
        }],
        contactCone: {
            id: 'cone', pos: { x: 0, y: 0, z: 10 }, normal: { x: 0, y: 0, z: -1 },
            profile: { type: 'disk', contactDiameterMm: 0.3, bodyDiameterMm: 1, lengthMm: 2, penetrationMm: 0.1 },
        },
    };
    return draft;
}

function island(id: string, areaMm2: number): DetectedIsland {
    const points = [
        { x: -0.25, y: -0.25 }, { x: 0, y: -0.25 }, { x: 0.25, y: -0.25 },
        { x: -0.25, y: 0 }, { x: 0, y: 0 }, { x: 0.25, y: 0 },
        { x: -0.25, y: 0.25 }, { x: 0, y: 0.25 }, { x: 0.25, y: 0.25 },
    ];
    return {
        id,
        source: 'overhang',
        contact: new THREE.Vector3(0, 0, 10),
        baseZ: 10,
        areaMm2,
        contactVoxels: footprintFromPoints(points),
    };
}

const LEDGER: ForestLedgerEntry[] = [{
    displayId: 'o217-a', kind: 'trunk', entityId: 't', areaMm2: 0.53,
    zHeight: 10, preset: 'structure', bandShaftMm: 1,
}];

test('a bare standalone overhang pillar on a non-deficit island is culled', () => {
    const result = cullLoadSurplusStandaloneOverhangs(
        draftWithStandalone(), LEDGER, [island('o217', 0.53)], 'm', 5.5,
    );
    assert.deepEqual(result.removed, ['o217-a']);
    assert.equal(Object.keys(result.draft.trunks).length, 0);
    assert.equal(Object.keys(result.draft.roots).length, 0);
    assert.equal(result.ledger.length, 0);
});

test('a sub-0.75 mm² sliver is culled even when its contact is not credited to the island row', () => {
    // The eye-socket case: the pillar's tip does not land on the region's own
    // footprint, so the load budget sees demand with no capacity and calls it a
    // deficit. A sliver that small is not a load path either way.
    const misplaced = island('o217', 0.5);
    misplaced.contactVoxels = footprintFromPoints([
        { x: 99.75, y: -0.25 }, { x: 100, y: -0.25 }, { x: 100.25, y: -0.25 },
        { x: 99.75, y: 0 }, { x: 100, y: 0 }, { x: 100.25, y: 0 },
        { x: 99.75, y: 0.25 }, { x: 100, y: 0.25 }, { x: 100.25, y: 0.25 },
    ]);
    const result = cullLoadSurplusStandaloneOverhangs(
        draftWithStandalone(), LEDGER, [misplaced], 'm', 5.5,
    );
    assert.deepEqual(result.removed, ['o217-a']);
});

test('a 2 mm² overhang keeps its standalone pillar', () => {
    const result = cullLoadSurplusStandaloneOverhangs(
        draftWithStandalone(), LEDGER, [island('o217', 2)], 'm', 5.5,
    );
    assert.deepEqual(result.removed, []);
});

test('a standalone pillar carrying a real deficit stays', () => {
    const result = cullLoadSurplusStandaloneOverhangs(
        draftWithStandalone(), LEDGER, [island('o217', 50)], 'm', 5.5,
    );
    assert.deepEqual(result.removed, []);
    assert.equal(Object.keys(result.draft.trunks).length, 1);
});

test('a start island keeps its standalone pillar even when the load is small', () => {
    const startIsland = { ...island('o217', 0.53), startIsland: true };
    const result = cullLoadSurplusStandaloneOverhangs(
        draftWithStandalone(), LEDGER, [startIsland], 'm', 5.5,
    );
    assert.deepEqual(result.removed, []);
});

test('a hosted standalone trunk is not culled', () => {
    const draft = draftWithStandalone();
    (draft.knots as Record<string, unknown>).leafKnot = {
        id: 'leafKnot', parentShaftId: 'seg', pos: { x: 0, y: 0, z: 9 }, diameter: 1,
    };
    const result = cullLoadSurplusStandaloneOverhangs(
        draft, LEDGER, [island('o217', 0.53)], 'm', 5.5,
    );
    assert.deepEqual(result.removed, []);
    assert.equal(Object.keys(result.draft.trunks).length, 1);
});
