import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { clearHistory } from '../../history/historyStore';
import { runAutoPlace } from '../autoSupport/autoPlace';
import { setModelMesh } from '../autoSupport/meshStore';
import { resetStore, getSnapshot, resetKickstandsInState } from '../state';
import { initializeBVH, accelerateGeometry } from '@/utils/bvh';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';

function makeIsland(id: string, x: number, y: number, z: number): DetectedIsland {
    return {
        id,
        source: 'minima',
        class: 'minimaOnly',
        contact: new THREE.Vector3(x, y, z),
        baseZ: z,
        areaMm2: 0.05,
        layerSpan: [0, Math.round(z / 0.05)],
    };
}

/**
 * A merged member's knot is placed by walking the host trunk's own segment
 * span, and the post-resize orphan pass then measures that knot's drift against
 * the same span. The merge search used to walk a fabricated `(0, 0, rootTopZ)`
 * line from the WORLD ORIGIN, which coincides with the host's real span only
 * for a trunk rooted at the origin. On a host rooted a few mm off-origin the
 * knot landed on that wrong line and the validator culled the member as
 * `drift` — placed and then silently thrown away, leaving the island it was
 * meant to hold unsupported. That is how the reported model lost every minima
 * member on its lowest edge, the edge that anchors the print.
 *
 * The single-segment host is what makes the two lines diverge along the whole
 * segment: a trunk long enough to carry a construction joint gives the search
 * a shared endpoint at that joint, which hides the discrepancy.
 */
test('merged members survive the orphan pass on a host rooted away from the origin', () => {
    resetStore();
    resetKickstandsInState();
    clearHistory();

    // Flat underside at z = 5 — low enough that the auto-placed trunk is a
    // single-segment "small island" pillar (socket barely above its root top).
    initializeBVH();
    const geometry = new THREE.BoxGeometry(40, 40, 10);
    geometry.translate(0, 0, 10);
    accelerateGeometry(geometry);
    const mesh = new THREE.Mesh(geometry);
    mesh.updateMatrixWorld();
    setModelMesh('model-a', mesh);

    // Host rooted at (0, 6); neighbour 2.8 mm away — inside the 4 mm gridless
    // merge radius, so it must attach to the host rather than duplicate it.
    const islands = [makeIsland('host', 0, 6, 5), makeIsland('neighbour', 1.4, 3.6, 5)];

    const result = runAutoPlace(islands, 'model-a', {
        debugSkipAutoBracing: true,
        stabilizationEnabled: false,
    });

    const report = result.analytics?.forestReport;
    assert.ok(report, 'forest report produced');

    const drift = (report.orphans ?? []).filter((o) => o.reason === 'drift');
    assert.deepEqual(
        drift.map((o) => `${o.id}: ${o.detail}`),
        [],
        'no member is culled as drifted off its host shaft',
    );

    // ... so every island's contact is actually reached by a placed support.
    const tips = [
        ...Object.values(getSnapshot().trunks),
        ...Object.values(getSnapshot().branches),
        ...Object.values(getSnapshot().leaves),
    ]
        .map((e) => e.contactCone?.pos)
        .filter((p): p is { x: number; y: number; z: number } => Boolean(p));

    for (const island of islands) {
        const nearest = Math.min(...tips.map((p) =>
            Math.hypot(p.x - island.contact.x, p.y - island.contact.y, p.z - island.contact.z)));
        assert.ok(nearest <= 0.6, `${island.id} is supported (nearest tip ${nearest.toFixed(2)}mm)`);
    }

    setModelMesh('model-a', null);
});
