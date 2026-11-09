import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
    paintSupportBlockers,
    clearSupportBlockers,
    deleteSupportBlockers,
    getSupportBlockedCount,
    getSupportBlockedTriangles,
    isSupportBlocked,
    isSupportBlockedContact,
    setSupportBlockedTriangles,
    beginSupportBlockerStroke,
    finishSupportBlockerStroke,
    endSupportBlockerStroke,
    getSupportBlockersVersion,
} from '../autoSupport/supportBlockers';

/** Unit square in XY: two triangles, indices (0,1,2) and (0,2,3). */
function squareGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        0, 0, 0,
        10, 0, 0,
        10, 10, 0,
        0, 10, 0,
    ]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    return g;
}

test('dab blocks every triangle with a vertex inside the radius', () => {
    const id = 'dab-covers-square';
    const added = paintSupportBlockers(id, squareGeometry(), new THREE.Vector3(5, 5, 0), 20);
    assert.equal(added, 2);
    assert.equal(getSupportBlockedCount(id), 2);
    assert.ok(isSupportBlocked(id, 0) && isSupportBlocked(id, 1));
    deleteSupportBlockers(id);
});

test('small dab blocks only the touched triangle', () => {
    const id = 'dab-corner';
    // Near vertex 1 (10,0,0), which belongs only to triangle 0.
    const added = paintSupportBlockers(id, squareGeometry(), new THREE.Vector3(9.9, 0.1, 0), 0.5);
    assert.equal(added, 1);
    assert.ok(isSupportBlocked(id, 0));
    assert.ok(!isSupportBlocked(id, 1));
    deleteSupportBlockers(id);
});

test('dab-spacing guard collapses repeated dabs', () => {
    const id = 'dab-spacing';
    const geo = squareGeometry();
    assert.equal(paintSupportBlockers(id, geo, new THREE.Vector3(5, 5, 0), 20), 2);
    assert.equal(paintSupportBlockers(id, geo, new THREE.Vector3(5, 5, 0), 20), 0);
    deleteSupportBlockers(id);
});

test('clear empties the mask and bumps the version', () => {
    const id = 'dab-clear';
    const before = getSupportBlockersVersion();
    paintSupportBlockers(id, squareGeometry(), new THREE.Vector3(5, 5, 0), 20);
    assert.equal(clearSupportBlockers(id), true);
    assert.equal(getSupportBlockedCount(id), 0);
    assert.equal(clearSupportBlockers(id), false);
    assert.ok(getSupportBlockersVersion() > before);
    deleteSupportBlockers(id);
});

test('stroke finish reports the diff for history', () => {
    const id = 'dab-stroke';
    beginSupportBlockerStroke(id);
    paintSupportBlockers(id, squareGeometry(), new THREE.Vector3(5, 5, 0), 20);
    const diff = finishSupportBlockerStroke();
    assert.deepEqual(diff, { modelId: id, before: [], after: [0, 1] });
    // No change → no history entry.
    beginSupportBlockerStroke(id);
    endSupportBlockerStroke(id);
    assert.equal(finishSupportBlockerStroke(), null);
    deleteSupportBlockers(id);
});

test('set replaces the mask wholesale for undo/redo', () => {
    const id = 'dab-set';
    paintSupportBlockers(id, squareGeometry(), new THREE.Vector3(5, 5, 0), 20);
    setSupportBlockedTriangles(id, [1]);
    assert.deepEqual([...getSupportBlockedTriangles(id)], [1]);
    setSupportBlockedTriangles(id, []);
    assert.equal(getSupportBlockedCount(id), 0);
    deleteSupportBlockers(id);
});

test('contact resolution hits the underside face and honors the mask', () => {
    const id = 'dab-contact';
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10));
    mesh.updateMatrixWorld();
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 0, -7), new THREE.Vector3(0, 0, 1));
    // Empty mask → false with no raycast surprises.
    assert.equal(isSupportBlockedContact(id, mesh, 0, 0, -5), false);
    const hits = ray.intersectObject(mesh, false);
    const face = hits.length > 0 ? hits[0].faceIndex : null;
    if (face == null) throw new Error('expected a bottom contact face');
    setSupportBlockedTriangles(id, [face]);
    assert.equal(isSupportBlockedContact(id, mesh, 0, 0, -5), true);
    // Known-face shortcut agrees without raycasting.
    assert.equal(isSupportBlockedContact(id, mesh, 0, 0, -5, face), true);
    assert.equal(isSupportBlockedContact(id, mesh, 0, 0, -5, face + 100), false);
    // A top contact is unblocked.
    assert.equal(isSupportBlockedContact(id, mesh, 0, 0, 5), false);
    deleteSupportBlockers(id);
});

test('brush size clamps to its range', async () => {
    const { getSupportBlockerBrushSizeMm, setSupportBlockerBrushSizeMm } =
        await import('../autoSupport/supportBlockers');
    const initial = getSupportBlockerBrushSizeMm();
    try {
        setSupportBlockerBrushSizeMm(4);
        assert.equal(getSupportBlockerBrushSizeMm(), 4);
        setSupportBlockerBrushSizeMm(100);
        assert.equal(getSupportBlockerBrushSizeMm(), 10);
        setSupportBlockerBrushSizeMm(-5);
        assert.equal(getSupportBlockerBrushSizeMm(), 0.5);
    } finally {
        setSupportBlockerBrushSizeMm(initial);
    }
});
