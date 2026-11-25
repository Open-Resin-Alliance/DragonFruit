import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
    isStartIsland,
    markStartIslands,
    sameLayerStartTips,
    startRecipeForArea,
    START_SUPPORT_CONSTANTS,
} from '../autoSupport/startIslands';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';

function island(over: Partial<DetectedIsland> = {}): DetectedIsland {
    return {
        id: 'v0',
        source: 'voxel',
        contact: new THREE.Vector3(0, 0, 10),
        baseZ: 10,
        areaMm2: 2,
        isDetached: true,
        ...over,
    };
}

test('a small detached 2 mm² island is a start with a two-contact base', () => {
    const start = island({ areaMm2: 2 });
    assert.equal(isStartIsland(start), true);
    const recipe = startRecipeForArea(2);
    assert.equal(recipe.minContacts, 2);
    assert.equal(recipe.coverageRadiusMm, START_SUPPORT_CONSTANTS.smallRadiusMm);
    assert.equal(recipe.coverageTarget, 0.99);
});

test('a narrow 1 mm-wide rib start is a start, recipe from its area', () => {
    const rib = island({ id: 'v-rib', areaMm2: 0.4 });
    assert.equal(isStartIsland(rib), true);
    assert.equal(startRecipeForArea(rib.areaMm2!).minContacts, 1,
        'a sub-0.5 mm² rib start needs one contact, not a three-point base it cannot fit');
});

test('a large 20 mm² flat start needs a three-point base', () => {
    const flat = island({ id: 'v-flat', areaMm2: 20 });
    assert.equal(isStartIsland(flat), true);
    const recipe = startRecipeForArea(20);
    assert.equal(recipe.minContacts, 3);
    assert.equal(recipe.coverageRadiusMm, START_SUPPORT_CONSTANTS.largeRadiusMm);
});

test('a non-start overhang is not a start', () => {
    const overhang = island({ source: 'overhang', isDetached: undefined, overhangAngleDeg: 30 });
    assert.equal(isStartIsland(overhang), false);
    assert.equal(markStartIslands([overhang])[0].startIsland, false);
});

test('an explicit startIsland stamp wins over the source heuristic', () => {
    assert.equal(isStartIsland(island({ source: 'minima', isDetached: undefined, startIsland: true })), true);
    assert.equal(isStartIsland(island({ startIsland: false })), false);
});

test('same-layer start tips ignore contacts at another cross-section', () => {
    const tips = [
        { x: 0, y: 0, z: 10.0 },
        { x: 0.5, y: 0, z: 10.1 },
        { x: 0.2, y: 0.2, z: 11.2 }, // a contact one layer up: must not suppress the start
        { x: 0.1, y: 0, z: 8.9 },
    ];
    const same = sameLayerStartTips(tips, 10);
    assert.deepEqual(same.map((t) => t.z), [10.0, 10.1],
        'only the 10 mm cross-section counts for the start recipe');
});
