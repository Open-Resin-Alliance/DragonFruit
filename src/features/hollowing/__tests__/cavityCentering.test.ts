import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { centerCavityPositions } from '../cavityCentering';

// Regression guard for the VOXL cavity-alignment bug: the persisted cavity must
// be recentered by the SAME `−model.geometry.center` that ExportManager bakes
// into the model STL. The old code encoded the cavity RAW (an identity
// transform), which these assertions would reject.

test('centerCavityPositions translates every triple by −center', () => {
  const positions = new Float32Array([
    1, 2, 3,
    4, 5, 6,
    -7, -8, -9,
  ]);
  const center = { x: 10, y: 20, z: 30 };

  const out = centerCavityPositions(positions, center);

  assert.deepEqual(Array.from(out), [
    1 - 10, 2 - 20, 3 - 30,
    4 - 10, 5 - 20, 6 - 30,
    -7 - 10, -8 - 20, -9 - 30,
  ]);
});

test('centerCavityPositions does not mutate the input (in-session cavity is shared)', () => {
  const positions = new Float32Array([1, 2, 3, 4, 5, 6]);
  const snapshot = Array.from(positions);
  const center = { x: 1, y: 1, z: 1 };

  const out = centerCavityPositions(positions, center);

  assert.deepEqual(Array.from(positions), snapshot, 'input array must be untouched');
  assert.notStrictEqual(out, positions, 'must return a new array');
  assert.equal(out.length, positions.length);
});

test('recentering by the model center aligns the cavity frame with the model STL', () => {
  // Model + cavity in the same raw in-session frame, offset from origin.
  const modelPositions = new Float32Array([
    0, 0, 0,
    20, 0, 0,
    20, 40, 0,
    0, 40, 0,
  ]);
  const cavityPositions = new Float32Array([
    5, 5, 0,
    15, 5, 0,
    15, 35, 0,
    5, 35, 0,
  ]);

  // C = the model bbox center — exactly what ExportManager bakes into the STL.
  const modelBbox = new THREE.Box3().setFromArray(modelPositions);
  const modelCenter = modelBbox.getCenter(new THREE.Vector3());

  // Model STL is exported translated by −C (ExportManager behavior).
  const exportedModelBbox = modelBbox.clone().translate(modelCenter.clone().negate());
  // Cavity is persisted via the helper (translated by −C).
  const exportedCavity = centerCavityPositions(cavityPositions, modelCenter);
  const exportedCavityBbox = new THREE.Box3().setFromArray(exportedCavity);

  // The cavity's offset from the model center is preserved after recentering,
  // so on reload the verbatim cavity sits in the same frame as the model.
  const exportedModelCenter = exportedModelBbox.getCenter(new THREE.Vector3());
  const exportedCavityCenter = exportedCavityBbox.getCenter(new THREE.Vector3());
  // Model+cavity are concentric here, so both land at the origin.
  assert.ok(exportedModelCenter.length() < 1e-6, 'centered model sits at origin');
  assert.ok(exportedCavityCenter.length() < 1e-6, 'recentered cavity sits at origin');
});
