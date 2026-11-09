import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { runAutoPlace } from '../autoSupport/autoPlace';
import { setModelMesh } from '../autoSupport/meshStore';
import type { AutoPlaceResult } from '../autoSupport/types';
import { getSnapshot, resetStore, resetKickstandsInState } from '../state';
import { getSettings, setSettings } from '../Settings/state';
import { createDefaultSettings } from '../Settings/types';
import { initializeBVH, accelerateGeometry } from '@/utils/bvh';
import { footprintFromPoints } from '@/volumeAnalysis/Islands/voxelFootprint';
import type { DetectedIsland } from '@/volumeAnalysis/Islands/types';

/** Rebuilding the same mixed scene must produce the same placement outcome. */

const MODEL = 'model-a';

/** A hollow box: a sealed interior cavity the trunk route cannot reach. */
function cavityMesh() {
    const box = (w: number, h: number, d: number, x: number, y: number, z: number) => {
        const g = new THREE.BoxGeometry(w, h, d);
        g.translate(x, y, z);
        return g;
    };
    // Interior cavity x,y within (-8, 8), z within (2, 6).
    const geometry = mergeGeometries([
        box(2, 20, 12, -9, 0, 3),
        box(2, 20, 12, 9, 0, 3),
        box(20, 2, 12, 0, -9, 3),
        box(20, 2, 12, 0, 9, 3),
        box(20, 20, 2, 0, 0, 1),
        box(20, 20, 2, 0, 0, 7),
    ])!;
    accelerateGeometry(geometry);
    const mesh = new THREE.Mesh(geometry);
    mesh.updateMatrixWorld();
    return mesh;
}

/** A wide flat overhang: the grid path. */
function planarIsland(): DetectedIsland {
    const voxels: { x: number; y: number; z?: number }[] = [];
    for (let x = -10; x <= 10; x += 0.25) {
        for (let y = -10; y <= 10; y += 0.25) {
            voxels.push({ x, y, z: 6.5 });
        }
    }
    return {
        id: 'o-planar',
        source: 'overhang',
        contact: new THREE.Vector3(0, 0, 6.5),
        baseZ: 6.5,
        areaMm2: 400,
        contactVoxels: footprintFromPoints(voxels),
    };
}

/** A curved region well away from the planar one: the organic/standalone path. */
function organicIsland(): DetectedIsland {
    const voxels: { x: number; y: number; z?: number }[] = [];
    for (let x = 30; x <= 50; x += 0.25) {
        for (let y = 30; y <= 50; y += 0.25) {
            voxels.push({ x, y, z: 25 + ((x - 40) * (x - 40)) / 20 });
        }
    }
    return {
        id: 'o-organic',
        source: 'overhang',
        contact: new THREE.Vector3(40, 40, 25),
        baseZ: 25,
        areaMm2: 400,
        contactVoxels: footprintFromPoints(voxels),
    };
}

/** A high isolated tip: the trunk/leaf path with nothing near to fan onto. */
function islandTip(): DetectedIsland {
    return {
        id: 'i-tip',
        source: 'voxel',
        contact: new THREE.Vector3(-30, -30, 40),
        baseZ: 40,
        areaMm2: 0.5,
        layerSpan: [0, 800],
    };
}

/** A small tip inside the hollow box: the cavity fallback. */
function cavityTip(): DetectedIsland {
    return {
        id: 'i-cavity',
        source: 'voxel',
        contact: new THREE.Vector3(0, 0, 5.5),
        baseZ: 5.5,
        areaMm2: 1,
        layerSpan: [0, 110],
    };
}

/** A tip below the anchor band (5mm): the near-plate short-circuit. */
function lowAnchorTip(): DetectedIsland {
    return {
        id: 'i-low',
        source: 'voxel',
        contact: new THREE.Vector3(60, 0, 3),
        baseZ: 3,
        areaMm2: 1,
        layerSpan: [0, 60],
    };
}

/**
 * A voxel host well away from everything else, so the fanning pair below has a
 * shaft to attach to without disturbing the other islands.
 */
function fanHost(): DetectedIsland {
    return {
        id: 'i-fan-host',
        source: 'voxel',
        contact: new THREE.Vector3(80, 80, 40),
        baseZ: 40,
        areaMm2: 30,
        layerSpan: [0, 800],
    };
}

/**
 * A sub-threshold overhang at a given offset from that host's shaft. Two are
 * used: one within the fan's reach, and one at ~9.8mm outside it, which flips
 * between a standalone trunk and a fanned leaf with the fan radius.
 */
function fanTarget(xOffsetMm: number, zOffsetMm: number): DetectedIsland {
    return {
        id: `o-fan-${xOffsetMm}-${zOffsetMm}`,
        source: 'overhang',
        contact: new THREE.Vector3(80 + xOffsetMm, 80, 40 + zOffsetMm),
        baseZ: 40 + zOffsetMm,
        areaMm2: 16,
        contactVoxels: footprintFromPoints([
            { x: 80 + xOffsetMm, y: 80 },
            { x: 80 + xOffsetMm + 0.25, y: 80 },
            { x: 80 + xOffsetMm, y: 80.25 },
            { x: 80 + xOffsetMm + 0.25, y: 80.25 },
        ]),
    };
}

/** The placement outcome compared between identical runs. */
interface RunSignature {
    placed: AutoPlaceResult['placed'];
    rejectedCandidates: number;
    changed: boolean;
    /** The visible outcome, keyed by `SupportState` collection. */
    inStore: Record<string, number>;
    forest: { hostCount: number; leafCount: number; branchCount: number; bareHosts: number } | null;
}

function runSignature(gridEnabled: boolean): RunSignature {
    resetStore();
    resetKickstandsInState();
    initializeBVH();
    setModelMesh(MODEL, cavityMesh());

    // Check repeatability in both grid and gridless placement modes.
    const settings = createDefaultSettings();
    settings.grid.enabled = gridEnabled;
    setSettings(settings);

    const result = runAutoPlace(
        [
            planarIsland(), organicIsland(), islandTip(), cavityTip(), lowAnchorTip(),
            // The fanning pair: one in reach, one beyond it.
            fanHost(), fanTarget(3, -7), fanTarget(4, 9),
        ],
        MODEL,
        { debugSkipAutoBracing: true, stabilizationEnabled: false },
    );

    const state = getSnapshot() as unknown as Record<string, Record<string, unknown>>;
    const forest = result.analytics?.forestReport;

    const signature = {
        // What the placement ladder decided, per type.
        placed: { ...result.placed },
        rejectedCandidates: result.rejectedCandidates,
        changed: result.changed,
        // What ended up in the store -- the thing a user would see.
        inStore: {
            trunks: Object.keys(state.trunks ?? {}).length,
            branches: Object.keys(state.branches ?? {}).length,
            leaves: Object.keys(state.leaves ?? {}).length,
            twigs: Object.keys(state.twigs ?? {}).length,
            sticks: Object.keys(state.sticks ?? {}).length,
            anchors: Object.keys(state.stumps ?? {}).length,
            knots: Object.keys(state.knots ?? {}).length,
            roots: Object.keys(state.roots ?? {}).length,
        },
        // The report's own view, which the UI and the logs read.
        forest: forest
            ? {
                hostCount: forest.hostCount,
                leafCount: forest.leafCount,
                branchCount: forest.branchCount,
                bareHosts: forest.bareHosts.length,
            }
            : null,
    };

    setModelMesh(MODEL, null);
    return signature;
}


test('a second run of the same scene is identical', () => {
    // Compare runs with each other, not with incidental recorded counts.
    assert.deepEqual(runSignature(true), runSignature(true));
    assert.deepEqual(runSignature(false), runSignature(false));
});
