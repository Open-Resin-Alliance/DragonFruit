import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as THREE from 'three';
import { supportPainterStore } from '../supportPainterStore';
import { generateSupportsFromPainter } from '../supportScriptingEngine';
import { type ROIRegion } from '../supportPainterTypes';
import { resetStore as resetSupportStore, getSnapshot as getSupportSnapshot, setSnapshot as setSupportSnapshot } from '@/supports/state';
import { deleteSupportsForRoi } from '@/supports/PlacementLogic/SupportModelLinker';
import { updateTipProfile, setSettings, createDefaultSettings } from '@/supports/Settings';

describe('Support Painter - Z-Minima Automated Leaf Support Placement', () => {

  it('should successfully place a Leaf support branching off a nearby trunk for clustered minima', async () => {
    // 1. Reset support and painter stores
    resetSupportStore();
    supportPainterStore.clearAll();
    
    // Shorten the tip length so the vertical shaft of Trunk A extends higher up,
    // which makes the candidate Point B much closer to the trunk segment.
    updateTipProfile({ lengthMm: 1.0 });

    // 2. Set up a mock BufferGeometry with two local Z-minima tips
    // Point A: (0, 0, 5) - Local minimum (processed first since Z is lower)
    // Point B: (1.2, 0, 5.5) - Local minimum (processed second, within 4mm search interval)
    const vertices = new Float32Array([
      // Pyramid A (Tip A at 0, 0, 5)
      0, 0, 5,     // 0: Tip A
      -1, -1, 10,  // 1
      1, -1, 10,   // 2
      0, 1, 10,    // 3

      // Pyramid B (Tip B at 1.2, 0, 5.5)
      1.2, 0, 5.5,   // 4: Tip B
      0.2, -1, 10,   // 5
      2.2, -1, 10,   // 6
      1.2, 1, 10,    // 7
    ]);

    const normals = new Float32Array([
      0, 0, -1,    // 0: Tip A normal points straight down
      0, 0, 1,     // 1
      0, 0, 1,     // 2
      0, 0, 1,     // 3

      0, 0, -1,    // 4: Tip B normal points straight down
      0, 0, 1,     // 5
      0, 0, 1,     // 6
      0, 0, 1,     // 7
    ]);

    const indices = [
      // Pyramid A triangles (inverted winding to point normals downwards)
      0, 2, 1,
      0, 3, 2,
      0, 1, 3,

      // Pyramid B triangles (inverted winding to point normals downwards)
      4, 6, 5,
      4, 7, 6,
      4, 5, 7,
    ];

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geom.setIndex(indices);

    const mat = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = 'mock-mesh-leaf-test'; // Triggers clean mock mesh bypass in processPointPlacement
    mesh.updateMatrixWorld(true);

    // 3. Register a MinimaIslands ROI covering the mock geometry faces
    const modelId = 'test-model-uuid';
    const regionId = 'test-minima-region';
    const region: ROIRegion = {
      id: regionId,
      brushType: 'MinimaIslands',
      seedTriangleId: 0,
      triangleIds: new Set([0, 1, 2, 3, 4, 5]),
      color: '#7ED321',
      proposedOnly: false,
      createdAt: Date.now(),
    };

    const regionsMap = new Map<string, ROIRegion>([[regionId, region]]);
    supportPainterStore.restoreRegions(regionsMap);

    // 4. Run support generation
    await generateSupportsFromPainter(modelId, mesh, [region]);

    // 5. Assert that exactly one vertical trunk and one branching Leaf are created
    const supportSnapshot = getSupportSnapshot();
    const trunks = Object.values(supportSnapshot.trunks);
    const leaves = Object.values(supportSnapshot.leaves);
    const knots = Object.values(supportSnapshot.knots);

    assert.strictEqual(trunks.length, 1, 'Should place exactly one vertical trunk at Point A');
    assert.strictEqual(leaves.length, 1, 'Should branch Point B as a Leaf support');
    assert.strictEqual(knots.length, 1, 'Should create exactly one parent Knot on the trunk segment');

    // Verify trunk is placed at Tip A
    const primaryTrunk = trunks[0];
    assert.ok(primaryTrunk.contactCone, 'Primary trunk must have a contact cone');
    const tipPos = primaryTrunk.contactCone.pos;
    assert.ok(Math.abs(tipPos.x - 0) < 0.1);
    assert.ok(Math.abs(tipPos.y - 0) < 0.1);
    assert.ok(Math.abs(tipPos.z - 5) < 0.1);

    // Verify leaf is placed at Tip B
    const leaf = leaves[0];
    assert.ok(leaf.contactCone, 'Leaf must have a contact cone');
    const leafTipPos = leaf.contactCone.pos;
    assert.ok(Math.abs(leafTipPos.x - 1.2) < 0.1);
    assert.ok(Math.abs(leafTipPos.y - 0) < 0.1);
    assert.ok(Math.abs(leafTipPos.z - 5.5) < 0.1);

    // Verify parent knot connection
    const knot = knots[0];
    assert.strictEqual(leaf.parentKnotId, knot.id, 'Leaf must connect to the created Knot');
    const segmentIds = primaryTrunk.segments.map(s => s.id);
    assert.ok(segmentIds.includes(knot.parentShaftId), 'Knot must be hosted on one of the primary trunk segments');

    // Verify correct ROI linkage
    assert.strictEqual(primaryTrunk.roiId, regionId, 'Primary trunk must have the correct roiId');
    assert.strictEqual(leaf.roiId, regionId, 'Leaf must have the correct roiId');

    // 5a. Call deleteSupportsForRoi and verify that both the trunk, knot, and leaf are deleted cleanly
    const stateBeforeDelete = getSupportSnapshot();
    const stateAfterDelete = deleteSupportsForRoi(stateBeforeDelete, regionId);
    setSupportSnapshot(stateAfterDelete);

    const snapshotAfterDelete = getSupportSnapshot();
    assert.strictEqual(Object.keys(snapshotAfterDelete.trunks).length, 0, 'Trunks should be cleanly deleted');
    assert.strictEqual(Object.keys(snapshotAfterDelete.leaves).length, 0, 'Leaves should be cleanly deleted');
    assert.strictEqual(Object.keys(snapshotAfterDelete.knots).length, 0, 'Knots should be cleanly deleted');

    // 6. Clean up modified settings to prevent leaking into subsequent tests
    setSettings(createDefaultSettings());
  });
});
