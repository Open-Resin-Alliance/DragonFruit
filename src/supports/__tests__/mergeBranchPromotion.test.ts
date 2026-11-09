import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { runAutoPlace } from '../autoSupport/autoPlace';
import { getSnapshot, resetStore, resetKickstandsInState, setSnapshot } from '../state';
import { setSettings } from '../Settings/state';
import { createDefaultSettings } from '../Settings/types';
import { initializeBVH } from '@/utils/bvh';
import { footprintFromPoints } from '@/volumeAnalysis/Islands/voxelFootprint';
import { buildTrunkData } from '../SupportTypes/Trunk/trunkBuilder';
import type { DetectedIsland } from '@/volumeAnalysis/Islands/types';

/**
 * The gridless merge's BRANCH promotion: a merged candidate whose knot-to-tip
 * span exceeds `MAX_LEAF_SPAN_BEFORE_BRANCH_MM` becomes a branch, not a leaf.
 *
 * Reaching the arm needs a genuinely long span, and an accurate knot search
 * leaves little room for one: the knot snaps to the highest sample that clears
 * the steep minimum, so a candidate at the host's own height bridges about
 * 2 × its lateral distance. The candidates here sit ABOVE the host's shaft top
 * instead — level with its contact cone — so the highest legal knot is the top
 * of the shaft and the member really is long (8.4mm knot→tip).
 */

const MODEL = 'model-a';

/** A trunk built by the production builder, so its joints are the real ones. */
function builtHost(tipZ: number) {
    const { root, trunk } = buildTrunkData({
        tipPos: new THREE.Vector3(0, 0, tipZ),
        tipNormal: new THREE.Vector3(0, 0, 1),
        modelId: MODEL,
    });
    const segments = (trunk as { segments: Array<{ bottomJoint?: { pos: { z: number } } }> }).segments;
    const midJointZ = segments[1]?.bottomJoint?.pos.z;
    assert.ok(midJointZ !== undefined, 'a built trunk must expose a mid-shaft joint');
    return { root, trunk, midJointZ };
}

/** A small island beside the host, low enough to be a merge candidate. */
function islandAt(x: number, z: number): DetectedIsland {
    return {
        id: 'I',
        source: 'voxel',
        contact: new THREE.Vector3(x, 0, z),
        baseZ: z,
        areaMm2: 2,
        contactVoxels: footprintFromPoints([
            { x, y: 0 },
            { x: x + 0.25, y: 0 },
            { x, y: 0.25 },
            { x: x + 0.25, y: 0.25 },
        ]),
    } as unknown as DetectedIsland;
}

/** Run the ladder against a scene that already contains the built host. */
function runAgainstHost(
    host: ReturnType<typeof builtHost>,
    candidate: DetectedIsland,
    minBranchAngleDeg: number,
) {
    resetStore();
    resetKickstandsInState();
    initializeBVH();
    const settings = createDefaultSettings();
    settings.grid.enabled = false;
    settings.grid.minBranchAngleDeg = minBranchAngleDeg;
    setSettings(settings);

    const before = getSnapshot() as unknown as Record<string, Record<string, unknown>>;
    setSnapshot({
        ...before,
        roots: { ...before.roots, [host.root.id]: host.root },
        trunks: { ...before.trunks, [host.trunk.id]: host.trunk },
    } as never);

    return runAutoPlace([candidate], MODEL, {
        debugSkipAutoBracing: true,
        stabilizationEnabled: false,
    } as never);
}

test('a long merge onto a host becomes a BRANCH, not a leaf', () => {
    const host = builtHost(40);
    const result = runAgainstHost(host, islandAt(3.8, host.midJointZ + 20), 20);

    assert.equal(result.placed.branch, 1, 'the long member should be a branch');
    assert.equal(result.placed.leaf, 0, 'and not a leaf');
    assert.equal(result.placed.trunk, 0, 'and not a standalone trunk');
});

test('the same scene under DEFAULT settings places a standalone trunk instead', () => {
    const host = builtHost(40);
    const result = runAgainstHost(host, islandAt(3.8, host.midJointZ + 20), 60);

    assert.equal(result.placed.branch, 0);
    assert.equal(result.placed.trunk, 1, 'the merge is refused and the candidate stands alone');
});

/**
 * The boundary, not just the two ends: the arm turns on the departure angle, so
 * the setting that admits it is exactly one degree either side of this line.
 */
test('the branch arm turns on grid.minBranchAngleDeg within one degree', () => {
    const host = builtHost(40);
    const refused = runAgainstHost(host, islandAt(3.8, host.midJointZ + 20), 51);
    const admitted = runAgainstHost(host, islandAt(3.8, host.midJointZ + 20), 50);

    assert.equal(refused.placed.branch, 0, 'gate 51 (39° from vertical) refuses the 40° departure');
    assert.equal(admitted.placed.branch, 1, 'gate 50 (40°) admits it');
});

/**
 * And the arm is bounded: the reach is a PLAN radius, so a candidate outside it
 * is not a merge at all and stands alone. Height is not part of the bound, so a
 * candidate level with (or above) the host's joints is still in reach and
 * attaches lower down the shaft. Without this the two tests above could be
 * passing for the wrong reason: if EVERY candidate branched, they would too.
 */
test('a candidate out of merge reach stands alone', () => {
    const host = builtHost(40);
    const outOfReach = runAgainstHost(host, islandAt(8, host.midJointZ), 20);
    assert.equal(outOfReach.placed.trunk, 1, '8mm away in plan is out of the 4mm merge reach');
    assert.equal(outOfReach.placed.branch + outOfReach.placed.leaf, 0, 'and nothing was bridged');

    const sameHeight = runAgainstHost(host, islandAt(3.8, host.midJointZ + 20), 20);
    assert.equal(sameHeight.placed.trunk, 0,
        'inside the plan reach a second plate contact is not stood, whatever the height');
    assert.equal(sameHeight.placed.branch, 1, 'the arm attaches lower down the host shaft');
});

test('the run is deterministic', () => {
    const host = builtHost(40);
    const a = runAgainstHost(host, islandAt(3.8, host.midJointZ), 20);
    const b = runAgainstHost(host, islandAt(3.8, host.midJointZ), 20);
    assert.deepEqual(a.placed, b.placed);
});
