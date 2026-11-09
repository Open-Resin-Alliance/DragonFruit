/**
 * A tip the lattice cannot serve is still a tip that needs a support.
 *
 * Grid mode refuses a candidate whose node is occupied and whose attachment to
 * the host standing there is refused too (two contacts at the same height give
 * the branch nothing to rise over, which is the `sameZ` refusal). Before the
 * fallback, that tip was dropped: the run reported it as
 * `grid_reject_no_attachment` and the island it belonged to stayed unsupported.
 * Now the candidate is retried with the grid off for itself alone, so it lands
 * as an ordinary placement beside the grid forest instead of nowhere.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { initializeBVH, accelerateGeometry } from '@/utils/bvh';
import { computeAutoSupportPlan } from '../autoSupport/autoPlace';
import { setModelMesh } from '../autoSupport/meshStore';
import { createDefaultSettings } from '../Settings/types';
import { setSettings } from '../Settings/state';
import { resetKickstandsInState, resetStore } from '../state';
import { footprintFromPoints } from '../../volumeAnalysis/Islands/voxelFootprint';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';

const MODEL_ID = 'grid-fallback';
const GRID_SPACING_MM = 4;
const UNDERSIDE_Z = 18;

/**
 * A 24 x 1.4 mm sliver over a post, the shape that refuses on the lattice: its
 * ring samples sit about one spacing apart at one height, so the first trunk
 * takes the node and every neighbouring tip finds a host it cannot leave
 * steeply enough to reach.
 */
function sliverOverPost(): { mesh: THREE.Mesh; islands: DetectedIsland[] } {
    initializeBVH();
    const geometry = mergeGeometries([
        new THREE.BoxGeometry(24, 1.4, 1.2).translate(0, 0, UNDERSIDE_Z + 0.6),
        new THREE.BoxGeometry(2, 2, UNDERSIDE_Z).translate(0, 0, UNDERSIDE_Z / 2),
    ])!;
    accelerateGeometry(geometry);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.updateMatrixWorld(true);

    const voxels: { x: number; y: number; z: number }[] = [];
    for (let x = -12; x <= 12; x += 0.25) {
        for (let y = -0.5; y <= 0.5; y += 0.25) voxels.push({ x, y, z: UNDERSIDE_Z });
    }
    const islands: DetectedIsland[] = [{
        id: 'o-rib',
        source: 'overhang',
        class: 'voxelOnly',
        contact: new THREE.Vector3(-10, 0, UNDERSIDE_Z),
        baseZ: UNDERSIDE_Z,
        areaMm2: 24 * 1.4,
        overhangAngleDeg: 0,
        surfaceNormal: { x: 0, y: 0, z: -1 },
        contactVoxels: footprintFromPoints(voxels),
    }];
    return { mesh, islands };
}

test('a tip whose lattice node cannot take it is placed without the grid', () => {
    const { mesh, islands } = sliverOverPost();
    const settings = createDefaultSettings();
    settings.grid.enabled = true;
    settings.grid.spacingMm = GRID_SPACING_MM;

    resetStore();
    resetKickstandsInState();
    setSettings(settings);
    setModelMesh(MODEL_ID, mesh);
    try {
        const plan = computeAutoSupportPlan(
            islands,
            MODEL_ID,
            { debugSkipAutoBracing: true, stabilizationEnabled: false },
            undefined,
            mesh,
        );
        assert.ok(plan);

        // Every tip the fixture offers is supported: a region can emit more than
        // one candidate (the ring), so the count itself is not the contract.
        const placed = Object.values(plan.result.placed).reduce((sum, count) => sum + count, 0);
        assert.ok(placed >= 2, `the tips are supported (placed ${JSON.stringify(plan.result.placed)})`);

        const refusals = Object.entries(plan.analytics.rejectionReasons)
            .filter(([reason]) => reason.startsWith('grid_reject'));
        assert.deepEqual(refusals, [], 'the grid refusal is a fallback, not a rejection');

        assert.ok(
            (plan.analytics.forestReport?.diagnostics?.gridFallbacks ?? 0) >= 1,
            'and the report says a tip was placed off the lattice',
        );
    } finally {
        setModelMesh(MODEL_ID, null);
        resetStore();
        resetKickstandsInState();
    }
});
