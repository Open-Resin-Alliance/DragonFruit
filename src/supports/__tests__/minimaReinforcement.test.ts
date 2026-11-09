import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { computeMinimaReinforcementPoints } from '../autoSupport/minimaReinforcement';
import { createDefaultAutoSupportSettings } from '../autoSupport/settings';
import { MINIMA_RING_COUNT, MINIMA_RING_RADIUS_MM } from '../autoSupport/constants';
import { collectContactPositions, runAutoPlace } from '../autoSupport/autoPlace';
import { setModelMesh } from '../autoSupport/meshStore';
import { getSnapshot, resetKickstandsInState, resetStore } from '../state';
import { clearHistory } from '../../history/historyStore';
import { accelerateGeometry, initializeBVH } from '@/utils/bvh';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';

/** A cone pointing straight down, apex at `apexZ`, half-angle `halfAngleDeg`
 *  from the vertical axis (so a 60° half-angle is a 30°-from-horizontal flank). */
function makeDownConeMesh(halfAngleDeg: number, apexZ: number): THREE.Mesh {
    const height = 4;
    const radius = height * Math.tan((halfAngleDeg * Math.PI) / 180);
    const geometry = new THREE.ConeGeometry(radius, height, 64);
    geometry.rotateZ(Math.PI);
    geometry.rotateX(Math.PI / 2);
    geometry.translate(0, 0, apexZ + height / 2);
    const mesh = new THREE.Mesh(geometry);
    mesh.updateMatrixWorld();
    return mesh;
}

function minimaIsland(id: string, x: number, y: number, z: number, cls = 'minimaOnly'): DetectedIsland {
    return {
        id,
        source: 'minima',
        class: cls as DetectedIsland['class'],
        contact: new THREE.Vector3(x, y, z),
        baseZ: z,
    };
}

const settings = createDefaultAutoSupportSettings();

test('a minima on an overhang flank gets a full ring at the ring radius', () => {
    // 30°-from-horizontal flank: at 2.5 mm out, the surface has risen
    // 2.5 / tan(60°) = 1.44 mm — inside the band (≥ 0.2, ≤ 2.5 at 45°).
    const mesh = makeDownConeMesh(60, 20);
    const points = computeMinimaReinforcementPoints(
        [minimaIsland('m0', 0, 0, 20)],
        mesh,
        settings,
    );

    assert.equal(points.length, MINIMA_RING_COUNT, 'every ring direction finds the flank');
    for (const p of points) {
        const dist = Math.hypot(p.x - 0, p.y - 0);
        assert.ok(
            Math.abs(dist - MINIMA_RING_RADIUS_MM) < 1e-6,
            `point sits on the ring (r=${dist.toFixed(3)})`,
        );
        assert.ok(
            Math.abs(p.z - (20 + 2.5 / Math.tan(Math.PI / 3))) < 0.02,
            `point sits on the flank surface (z=${p.z.toFixed(3)})`,
        );
        assert.equal(p.islandId, 'm0');
    }
});

test('a flat around the minima is not a flank, and a needle is too steep to grip', () => {
    // Underside of a box at z = 20: same height all around the minima, so no
    // direction has a flank to ring.
    const boxGeometry = new THREE.BoxGeometry(40, 40, 10);
    boxGeometry.translate(0, 0, 25);
    const box = new THREE.Mesh(boxGeometry);
    box.updateMatrixWorld();
    assert.deepEqual(
        computeMinimaReinforcementPoints([minimaIsland('m0', 0, 0, 20)], box, settings),
        [],
        'a flat underside gets no ring — its tip is the whole feature',
    );

    // 20° half-angle needle: the flank at 2.5 mm out is 6.9 mm above the apex,
    // far past the 45° self-support band — a needle holds itself.
    const needle = makeDownConeMesh(20, 20);
    assert.deepEqual(
        computeMinimaReinforcementPoints([minimaIsland('m0', 0, 0, 20)], needle, settings),
        [],
        'a needle flank is steeper than the self-support angle and is left to its tip',
    );
});

test('only minima the voxel mask missed are reinforced', () => {
    const mesh = makeDownConeMesh(60, 20);
    assert.deepEqual(
        computeMinimaReinforcementPoints([minimaIsland('m0', 0, 0, 20, 'intersection')], mesh, settings),
        [],
        'a minima coincident with a voxel island is already covered by the island passes',
    );
    assert.deepEqual(
        computeMinimaReinforcementPoints(
            [{ ...minimaIsland('v0', 0, 0, 20), source: 'voxel', class: undefined }],
            mesh,
            settings,
        ),
        [],
        'non-minima islands are not reinforced',
    );
});

test('a minima tip ends up held by its own tip plus a ring of contacts', () => {
    resetStore();
    resetKickstandsInState();
    clearHistory();

    // 20 mm tip hanging from a 30°-from-horizontal cone, so the ring lands on
    // the cone's own flank and the tip support stays clear of the model.
    initializeBVH();
    const mesh = makeDownConeMesh(60, 20);
    accelerateGeometry(mesh.geometry);
    setModelMesh('model-a', mesh);

    const result = runAutoPlace([minimaIsland('m0', 0, 0, 20)], 'model-a', {
        debugSkipAutoBracing: true,
        // Stabilization anchors teeth up a bare cone's radiating edges, which
        // lands them on this feature too — off, so the ring is what is measured.
        stabilizationEnabled: false,
    });

    const bySource = result.analytics?.forestReport?.diagnostics?.candidatesBySource;
    assert.equal(bySource?.reinforcement, MINIMA_RING_COUNT, 'the ring reaches placement');

    const contacts = collectContactPositions(getSnapshot());
    assert.ok(contacts.length >= MINIMA_RING_COUNT + 1,
        `${MINIMA_RING_COUNT + 1} contacts expected (tip + ring), got ${contacts.length}`);
    // The ring is a base, not decoration: contacts sit off the tip's axis.
    const ringed = contacts.filter((c) => Math.hypot(c.x, c.y) > 1);
    assert.ok(ringed.length >= MINIMA_RING_COUNT,
        `ring contacts sit off the minima's axis (${ringed.length} of ${contacts.length})`);

    // ... and the crown chunks: ring pillars are stamped with their own origin,
    // declared convertible, so the consolidation pass pulls them onto the pillar
    // they ring (one plate contact per chunk) wherever the link clears the
    // model. On this cone the tip pillar leans off its own axis, so its crown
    // links pierce the section and only some convert; the plate contacts still
    // come out below one-per-contact.
    const snapshot = getSnapshot();
    const roots = Object.keys(snapshot.roots).length;
    assert.ok(
        roots < MINIMA_RING_COUNT + 1,
        `the crown chunks: ${roots} plate contacts for ${MINIMA_RING_COUNT + 1} contacts`,
    );
    assert.ok(
        Object.values(snapshot.trunks).some((t) => t.origin === 'reinforcement'),
        'ring pillars carry the reinforcement origin (what makes them convertible)',
    );

    // Re-running on the now-supported model stacks nothing: the ring sits
    // inside ALREADY_SUPPORTED_RADIUS_MM of its own minima, so the tips the
    // first run placed filter every direction.
    const trunksAfterFirst = Object.keys(getSnapshot().trunks).length;
    const second = runAutoPlace([minimaIsland('m0', 0, 0, 20)], 'model-a', {
        debugSkipAutoBracing: true,
        stabilizationEnabled: false,
    });
    assert.equal(second.changed, false, 'a second run adds nothing');
    assert.equal(Object.keys(getSnapshot().trunks).length, trunksAfterFirst);

    setModelMesh('model-a', null);
});
