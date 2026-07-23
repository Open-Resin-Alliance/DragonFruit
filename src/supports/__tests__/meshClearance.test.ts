import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { initializeBVH, accelerateGeometry } from '../../utils/bvh';
import { linePassesMeshClearance } from '../autoBracing/meshClearance';
import { registerMeshForAutoBrace, unregisterMeshForAutoBrace } from '../autoBracing/meshGeometryStore';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

// BVH must be initialized before any geometry is created or raycasting used.
initializeBVH();

/**
 * Create a box geometry, build its BVH, and register it in the mesh store.
 * Returns the modelId so tests can reference it.
 */
function registerBoxModel(
    modelId: string,
    boxSize: { x: number; y: number; z: number },
    worldPos: { x: number; y: number; z: number },
): string {
    const geo = new THREE.BoxGeometry(boxSize.x, boxSize.y, boxSize.z);
    accelerateGeometry(geo);
    const matrix = new THREE.Matrix4().makeTranslation(worldPos.x, worldPos.y, worldPos.z);
    registerMeshForAutoBrace(modelId, geo, matrix);
    return modelId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('linePassesMeshClearance returns true when no model is registered', () => {
    // No model registered → can't check → allow
    const result = linePassesMeshClearance(
        { x: 0, y: 0, z: 10 },
        { x: 0, y: 10, z: 10 },
        'nonexistent-model',
        0.7,
    );
    assert.equal(result, true);
});

test('linePassesMeshClearance returns true for degenerate segment (length < 0.1mm)', () => {
    const modelId = 'degenerate-test';
    registerBoxModel(modelId, { x: 5, y: 5, z: 5 }, { x: 0, y: 0, z: 0 });

    // Near-zero-length segment
    const result = linePassesMeshClearance(
        { x: 0, y: 0, z: 10 },
        { x: 0, y: 0.05, z: 10 },
        modelId,
        0.7,
    );
    assert.equal(result, true);

    unregisterMeshForAutoBrace(modelId);
});

test('linePassesMeshClearance detects centerline collision', () => {
    // A 10×10×10 box centered at (5, 5, 5) — spans 0-10 on all axes.
    const modelId = 'centerline-test';
    registerBoxModel(modelId, { x: 10, y: 10, z: 10 }, { x: 5, y: 5, z: 5 });

    // Brace that goes straight through the box center
    const result = linePassesMeshClearance(
        { x: 5, y: -5, z: 5 },
        { x: 5, y: 15, z: 5 },
        modelId,
        0.7,
    );
    assert.equal(result, false, 'centerline should hit the box');

    unregisterMeshForAutoBrace(modelId);
});

test('linePassesMeshClearance detects perimeter whisker clip', () => {
    // Box at world (5, 2, 5), 10 wide (X), 4 tall (Y local -2..2, world 0..4), 10 deep (Z).
    // Centerline runs along X at y=4.2 (0.2mm above box top) — centerline clears.
    // But whisker rays extend toward the box (radius 0.35mm), reaching y=3.85
    // which is inside the box — the whisker ray should hit.
    const modelId = 'clip-test';
    registerBoxModel(modelId, { x: 10, y: 4, z: 10 }, { x: 5, y: 2, z: 5 });

    const result = linePassesMeshClearance(
        { x: -2, y: 4.2, z: 5 },
        { x: 12, y: 4.2, z: 5 },
        modelId,
        0.7,
    );
    assert.equal(result, false, 'perimeter whisker should clip the box even though centerline clears');

    unregisterMeshForAutoBrace(modelId);
});

test('linePassesMeshClearance returns true when brace is completely clear', () => {
    // Box at origin is 10×10×10 wide, but our brace is far away
    const modelId = 'clear-test';
    registerBoxModel(modelId, { x: 10, y: 10, z: 10 }, { x: 5, y: 5, z: 5 });

    // Brace far outside the box (at y=20, box ends at y=10)
    const result = linePassesMeshClearance(
        { x: 5, y: 20, z: 2 },
        { x: 5, y: 20, z: 8 },
        modelId,
        0.7,
    );
    assert.equal(result, true, 'brace far away should be clear');

    unregisterMeshForAutoBrace(modelId);
});
