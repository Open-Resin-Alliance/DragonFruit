import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';

import {
    resolveLeafPlacementMeshHit,
    syncSproutTipFromRaycast,
} from '../SupportTypes/Leaf/leafFanningRaycast';
import { leafPlacementStore } from '../SupportTypes/Leaf/leafPlacementState';
import type { SupportData } from '../rendering/SupportBuilder';

type BvhRaycaster = THREE.Raycaster & { firstHitOnly?: boolean };
type BvhGeometry = THREE.BufferGeometry & { boundsTree?: MeshBVH };

function makeTriangleMesh(
    positions: number[],
    options: {
        modelId?: string;
        side?: THREE.Side;
        withBvh?: boolean;
        cavityGeometry?: THREE.BufferGeometry;
    } = {},
): THREE.Mesh {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    if (options.withBvh) {
        (geometry as BvhGeometry).boundsTree = new MeshBVH(geometry);
    }

    const material = new THREE.MeshBasicMaterial({
        side: options.side ?? THREE.FrontSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    if (options.withBvh) {
        mesh.raycast = acceleratedRaycast;
    }
    mesh.userData = {
        ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
        ...(options.cavityGeometry !== undefined ? { cavityGeometry: options.cavityGeometry } : {}),
    };
    mesh.updateMatrixWorld(true);
    return mesh;
}

const dummyPreview: SupportData = {
    id: 'preview-leaf',
    segments: [],
};

test('1. leafPlacementStore.updateFanningTip(null, null) clears tipPosition and surfaceNormal while preserving modelId and skipping no-op writes', () => {
    leafPlacementStore.setHotkeyActive(false);
    leafPlacementStore.setTip(
        { x: 1, y: 2, z: 10 },
        { x: 0, y: 0, z: 1 },
        'model-1',
        'exterior',
    );
    leafPlacementStore.setStage('awaitingSproutTip');

    let writeCount = 0;
    const unsubscribe = leafPlacementStore.subscribe(() => {
        writeCount += 1;
    });

    try {
        // Identical values should not trigger a 60 Hz store write.
        leafPlacementStore.updateFanningTip({ x: 1, y: 2, z: 10 }, { x: 0, y: 0, z: 1 });
        assert.equal(writeCount, 0);

        leafPlacementStore.updateFanningTip(null, null);
        assert.equal(writeCount, 1);

        const snap = leafPlacementStore.getSnapshot();
        assert.equal(snap.tipPosition, null);
        assert.equal(snap.surfaceNormal, null);
        assert.equal(snap.modelId, 'model-1');

        // Repeated clear should also skip redundant writes.
        leafPlacementStore.updateFanningTip(null, null);
        assert.equal(writeCount, 1);
    } finally {
        unsubscribe();
        leafPlacementStore.setHotkeyActive(false);
    }
});

test('2. syncSproutTipFromRaycast clears tipPosition, surfaceNormal, and previewData on off-mesh exit while preserving modelId', () => {
    leafPlacementStore.setHotkeyActive(false);
    leafPlacementStore.setTip(
        { x: 0, y: 0, z: 5 },
        { x: 0, y: 0, z: 1 },
        'model-keep',
        'exterior',
    );
    leafPlacementStore.setStage('awaitingSproutTip');

    const mesh = makeTriangleMesh([0, 0, 10, 10, 0, 10, 0, 10, 10], { modelId: 'model-keep' });

    const onMeshRaycaster = new THREE.Raycaster(
        new THREE.Vector3(1, 1, 50),
        new THREE.Vector3(0, 0, -1),
    );
    const hitSync = syncSproutTipFromRaycast(onMeshRaycaster, [mesh]);
    assert.ok(hitSync.tipPosition && Math.abs(hitSync.tipPosition.z - 10) < 1e-6);

    leafPlacementStore.setPreviewData(dummyPreview);
    assert.notEqual(leafPlacementStore.getSnapshot().previewData, null);

    const offMeshRaycaster = new THREE.Raycaster(
        new THREE.Vector3(50, 50, 50),
        new THREE.Vector3(0, 0, -1),
    );
    const missSync = syncSproutTipFromRaycast(offMeshRaycaster, [mesh]);
    assert.deepEqual(missSync, { tipPosition: null, surfaceNormal: null });

    const snap = leafPlacementStore.getSnapshot();
    assert.equal(snap.tipPosition, null);
    assert.equal(snap.surfaceNormal, null);
    assert.equal(snap.previewData, null);
    assert.equal(snap.modelId, 'model-keep');

    leafPlacementStore.setHotkeyActive(false);
});

test('3. all-clipped hit (z = 20, clipUpper = 15) returns null and clears preview state', () => {
    leafPlacementStore.setHotkeyActive(false);
    leafPlacementStore.setTip(
        { x: 1, y: 1, z: 20 },
        { x: 0, y: 0, z: 1 },
        'model-clipped',
        'exterior',
    );
    leafPlacementStore.setStage('awaitingSproutTip');
    leafPlacementStore.setPreviewData(dummyPreview);

    const mesh = makeTriangleMesh([0, 0, 20, 10, 0, 20, 0, 10, 20], { modelId: 'model-clipped' });
    const raycaster = new THREE.Raycaster(
        new THREE.Vector3(1, 1, 50),
        new THREE.Vector3(0, 0, -1),
    );

    const directHit = resolveLeafPlacementMeshHit(raycaster, [mesh], { clipUpper: 15 });
    assert.equal(directHit, null);

    const synced = syncSproutTipFromRaycast(raycaster, [mesh], { clipUpper: 15 });
    assert.deepEqual(synced, { tipPosition: null, surfaceNormal: null });

    const snap = leafPlacementStore.getSnapshot();
    assert.equal(snap.tipPosition, null);
    assert.equal(snap.surfaceNormal, null);
    assert.equal(snap.previewData, null);
    assert.equal(snap.modelId, 'model-clipped');

    leafPlacementStore.setHotkeyActive(false);
});

test('4. clipped outer (z = 20) + visible inner wall (z = 8, firstHitOnly = true BVH simulation) skips z = 20 and resolves z = 8', () => {
    const mesh = makeTriangleMesh(
        [
            // Clipped outer wall at z = 20
            0, 0, 20,
            10, 0, 20,
            0, 10, 20,
            // Visible inner wall at z = 8
            0, 0, 8,
            10, 0, 8,
            0, 10, 8,
        ],
        { modelId: 'model-bvh', withBvh: true },
    );

    const sawFirstHitOnly: boolean[] = [];
    const originalRaycast = mesh.raycast.bind(mesh);
    mesh.raycast = (rc, intersects) => {
        sawFirstHitOnly.push(Boolean((rc as BvhRaycaster).firstHitOnly));
        originalRaycast(rc, intersects);
    };

    const raycaster: BvhRaycaster = new THREE.Raycaster(
        new THREE.Vector3(1, 1, 50),
        new THREE.Vector3(0, 0, -1),
    );
    raycaster.firstHitOnly = true;

    const hit = resolveLeafPlacementMeshHit(raycaster, [mesh], { clipUpper: 15 });
    assert.ok(hit, 'expected visible inner wall hit');
    assert.ok(Math.abs(hit.point.z - 8) < 1e-6, `expected z = 8, got ${hit.point.z}`);
    assert.deepEqual(sawFirstHitOnly, [true, true]);

    leafPlacementStore.setHotkeyActive(false);
    leafPlacementStore.setStage('awaitingSproutTip');
    const synced = syncSproutTipFromRaycast(raycaster, [mesh], { clipUpper: 15 });
    assert.ok(synced.tipPosition && Math.abs(synced.tipPosition.z - 8) < 1e-6);
    assert.ok(synced.surfaceNormal && Math.abs(synced.surfaceNormal.z - 1) < 1e-6);

    leafPlacementStore.setHotkeyActive(false);
});

test('5. placementSurface === "interior" hits userData.cavityGeometry (z = 12, -Z normal) instead of exterior shell (z = 20, +Z normal)', () => {
    // Cavity ceiling triangle at z = 12 with downward (-Z) normal.
    const cavityGeometry = new THREE.BufferGeometry();
    cavityGeometry.setAttribute(
        'position',
        new THREE.Float32BufferAttribute([0, 0, 12, 0, 10, 12, 10, 0, 12], 3),
    );
    cavityGeometry.computeVertexNormals();

    // Exterior shell triangle at z = 20 with upward (+Z) normal.
    const exteriorMesh = makeTriangleMesh(
        [0, 0, 20, 10, 0, 20, 0, 10, 20],
        {
            modelId: 'model-cavity',
            side: THREE.DoubleSide,
            cavityGeometry,
        },
    );

    const raycaster = new THREE.Raycaster(
        new THREE.Vector3(1, 1, 0),
        new THREE.Vector3(0, 0, 1),
    );

    const exteriorHit = resolveLeafPlacementMeshHit(raycaster, [exteriorMesh], {
        placementSurface: 'exterior',
    });
    assert.ok(exteriorHit && Math.abs(exteriorHit.point.z - 20) < 1e-6);

    leafPlacementStore.setHotkeyActive(false);
    leafPlacementStore.setStage('awaitingSproutTip');
    const interiorSync = syncSproutTipFromRaycast(raycaster, [exteriorMesh], {
        placementSurface: 'interior',
    });
    assert.ok(interiorSync.tipPosition, 'expected interior cavity hit');
    assert.ok(Math.abs(interiorSync.tipPosition.z - 12) < 1e-6, `expected z = 12, got ${interiorSync.tipPosition.z}`);
    assert.ok(interiorSync.surfaceNormal, 'expected interior surface normal');
    assert.ok(Math.abs(interiorSync.surfaceNormal.z - (-1)) < 1e-6, `expected -Z normal, got ${interiorSync.surfaceNormal.z}`);

    leafPlacementStore.setHotkeyActive(false);
});
