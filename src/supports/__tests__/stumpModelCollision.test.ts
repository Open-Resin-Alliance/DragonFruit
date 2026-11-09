import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { resetStore } from '../state';
import { buildContactOverride } from '../supportTypeRegistry';
import { initializeBVH, accelerateGeometry } from '@/utils/bvh';
import { setSettings } from '../Settings/state';
import { createDefaultSettings } from '../Settings/types';

/**
 * A stump must not print through the model.
 *
 * A stump stands where the model is close to the plate, and its socket end (the
 * joint ball plus the cone's wide end) sits a fixed millimetre above the plate.
 * An underside that clears the contact can still be met by that wide end, which
 * is how a rendered stump ends up as a blob with the surface cutting through it.
 * A type with its own contact override returns before the grid's collision gate,
 * so the stump checks its own body.
 */

const CONTACT_X = 0;
const CONTACT_Y = 0;

/** A 20 × 20 mm slab whose bottom face sits at `bottomZ`. */
function slabAt(bottomZ: number): THREE.Mesh {
  initializeBVH();
  const geometry = new THREE.BoxGeometry(20, 20, 2);
  accelerateGeometry(geometry);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  mesh.position.set(CONTACT_X, CONTACT_Y, bottomZ + 1);
  mesh.updateMatrixWorld(true);
  return mesh;
}

/** Place a stump on a downward-facing contact at the slab's bottom face. */
function placeStumpOn(bottomZ: number, mesh?: THREE.Mesh) {
  const override = buildContactOverride('stump');
  assert.ok(override, 'the stump registers a contact override');
  return override({
    tipPos: { x: CONTACT_X, y: CONTACT_Y, z: bottomZ },
    tipNormal: { x: 0, y: 0, z: -1 },
    modelId: 'model-a',
    mesh: mesh ?? slabAt(bottomZ),
  });
}

test('a stump whose socket end would run into the model is refused', () => {
  resetStore();
  setSettings(createDefaultSettings());

  // Contact 1.6 mm off the plate: the stump has to reach its fixed root height,
  // so the joint ball ends up 0.5 mm below the surface, inside it.
  const result = placeStumpOn(1.6);
  assert.equal(result?.refusal, 'COLLISION_WITH_MODEL');
});

test('a stump that clears the model is placed', () => {
  resetStore();
  setSettings(createDefaultSettings());

  // Contact 2 mm off the plate: the 0.9 mm of cone plus the joint ball clear the
  // surface, which is what a stump is for.
  const result = placeStumpOn(2.0);
  assert.equal(result?.refusal, undefined);
  assert.equal(result?.placed.typeId, 'stump');
});

/** A ceiling slab the contact sits on, plus a wall standing beside the socket at `wallX`. */
function ceilingWithWall(wallX: number): THREE.Mesh {
  initializeBVH();
  const ceiling = new THREE.BoxGeometry(20, 20, 2).translate(0, 0, 4);
  const wall = new THREE.BoxGeometry(2, 2, 10).translate(wallX + 1, 0, 6);
  const merged = mergeGeometries([ceiling, wall], false);
  assert.ok(merged);
  accelerateGeometry(merged);
  const mesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial());
  mesh.updateMatrixWorld(true);
  return mesh;
}

test('a stump whose body would run into a wall beside it is refused', () => {
  resetStore();
  setSettings(createDefaultSettings());

  // The ceiling is 3 mm up, so the cone is long and the socket ball clears it;
  // the wall's face is 0.5 mm from the socket's axis, inside the cone's own
  // radius. Nothing on the axis sees it.
  const result = placeStumpOn(3, ceilingWithWall(0.5));
  assert.equal(result?.refusal, 'COLLISION_WITH_MODEL');
});

test('the same stump with the wall moved away is placed', () => {
  resetStore();
  setSettings(createDefaultSettings());

  const result = placeStumpOn(3, ceilingWithWall(4));
  assert.equal(result?.refusal, undefined);
});

test('a stump on a model lifted well clear of the plate is placed', () => {
  resetStore();
  setSettings(createDefaultSettings());

  const result = placeStumpOn(30);
  assert.equal(result?.refusal, undefined);
});
