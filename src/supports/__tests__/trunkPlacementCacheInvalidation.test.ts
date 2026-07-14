import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import { initializeBVH, accelerateGeometry } from '../../utils/bvh';
import { setSettings } from '../Settings/state';
import { createDefaultSettings } from '../Settings/types';
import { buildTrunkData, clearPlacementCache } from '../SupportTypes/Trunk/trunkBuilder';

function applyTestSettings(tipLengthMm = 1.2) {
    const settings = createDefaultSettings();
    settings.roots.diskHeightMm = 1.0;
    settings.roots.coneHeightMm = 1.0;
    settings.roots.diameterMm = 3.0;
    settings.shaft.diameterMm = 1.5;
    settings.tip.lengthMm = tipLengthMm;
    setSettings(settings);
    return settings;
}

function makeSphereMesh(): THREE.Mesh {
    initializeBVH();
    const geometry = new THREE.SphereGeometry(2, 16, 16);
    accelerateGeometry(geometry);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.position.set(0, 0, 5);
    mesh.updateMatrixWorld(true);
    return mesh;
}

function previewInput(mesh: THREE.Mesh) {
    return {
        tipPos: { x: 0.5, y: 0, z: 10 },
        tipNormal: { x: 0, y: 0, z: -1 },
        modelId: 'model-cache-invalidation',
        mesh,
        isPreview: true,
    };
}

test('hover placement cache must not survive a mesh world-matrix change', () => {
    applyTestSettings();
    clearPlacementCache();
    const mesh = makeSphereMesh();

    // Sphere blocks the straight drop: the preview routes around it.
    const routed = buildTrunkData(previewInput(mesh));
    assert.equal(routed.error, undefined);
    assert.ok(routed.route.joints.length > 0, 'setup: sphere in the way must produce a routed support');

    // Model transform: move the sphere far out of the way.
    mesh.position.set(100, 0, 5);
    mesh.updateMatrixWorld(true);

    // Same hover bucket → without invalidation the stale routed result is
    // served even though nothing obstructs the straight drop anymore.
    const afterMove = buildTrunkData(previewInput(mesh));
    assert.equal(afterMove.error, undefined);
    assert.equal(
        afterMove.route.joints.length,
        0,
        'stale cached route served after the mesh moved: placement cache was not invalidated on matrix drift',
    );
});

test('hover placement cache must not survive a support-settings change', () => {
    applyTestSettings(1.2);
    clearPlacementCache();
    const mesh = makeSphereMesh();
    // Keep the obstacle away from the tip: plain straight support.
    mesh.position.set(100, 0, 5);
    mesh.updateMatrixWorld(true);

    const before = buildTrunkData(previewInput(mesh));
    assert.equal(before.error, undefined);
    const socketZBefore = before.route.socketPos.z;

    // User changes the cone length: the socket must move with it.
    applyTestSettings(3.0);

    const after = buildTrunkData(previewInput(mesh));
    assert.equal(after.error, undefined);
    const socketZAfter = after.route.socketPos.z;

    assert.ok(
        Math.abs((socketZBefore - socketZAfter) - 1.8) < 0.25,
        `socket must drop by the cone-length delta (~1.8mm); before=${socketZBefore.toFixed(3)} after=${socketZAfter.toFixed(3)}`,
    );
});
