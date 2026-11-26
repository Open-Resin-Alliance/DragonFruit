import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { resetStore } from '../state';
import { buildContactOverride } from '../supportTypeRegistry';
import { initializeBVH, accelerateGeometry } from '@/utils/bvh';
import { setSettings } from '../Settings/state';
import { createDefaultSettings } from '../Settings/types';
import { getFinalSocketPosition } from '../SupportPrimitives/ContactCone/contactConeUtils';
import { buildStumpData } from '../SupportTypes/Stump/stumpBuilder';
import type { Stump } from '../types';

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

test('a stump aligns joint.pos and socketJointId with getFinalSocketPosition under wall standoff and short spans', () => {
  resetStore();
  const defaults = createDefaultSettings();
  setSettings({
    ...defaults,
    tip: {
      ...defaults.tip,
      coneAngleMode: 'adaptive',
      adaptiveConeAngleOffsetDeg: 30,
      maxStandoffMm: 1.0,
    },
  });

  try {
    initializeBVH();
    const wall = new THREE.BoxGeometry(1, 2, 1).translate(-0.85, 0, 2.2);
    accelerateGeometry(wall);
    const mesh = new THREE.Mesh(wall, new THREE.MeshBasicMaterial());
    mesh.updateMatrixWorld(true);

    const override = buildContactOverride('stump');
    assert.ok(override, 'the stump registers a contact override');

    const tipNormal = { x: Math.sin(Math.PI / 3), y: 0, z: -Math.cos(Math.PI / 3) };
    const result = override({
      tipPos: { x: 0, y: 0, z: 2.0 },
      tipNormal,
      modelId: 'model-a',
      mesh,
    });
    assert.equal(result?.refusal, undefined);

    const stump = result?.placed.entity as Stump;
    const finalSocket = getFinalSocketPosition(stump.contactCone);
    assert.ok((stump.contactCone.diskLengthOverride ?? 0) > 0.15,
      `wall box triggers standoff backoff (got ${stump.contactCone.diskLengthOverride})`);
    for (const axis of ['x', 'y', 'z'] as const) {
      assert.ok(
        Math.abs(stump.joint.pos[axis] - finalSocket[axis]) < 1e-9,
        `stump.joint.pos.${axis} (${stump.joint.pos[axis]}) matches getFinalSocketPosition (${finalSocket[axis]})`,
      );
    }
    assert.equal(stump.contactCone.socketJointId, stump.joint.id);
  } finally {
    setSettings(createDefaultSettings());
    resetStore();
  }
});

test('a short-span stump aligns joint.pos.z and socketJointId when socketPos.z shifts off 1.1', () => {
  resetStore();
  setSettings(createDefaultSettings());

  try {
    const shortSpan = buildStumpData({
      tipPos: { x: 0, y: 0, z: 1.23 },
      tipNormal: { x: 0, y: 0, z: -1 },
      modelId: 'model-a',
    }).stump;
    const shortSocket = getFinalSocketPosition(shortSpan.contactCone);
    assert.ok(Math.abs(shortSocket.z - 1.1) > 0.02, `socket.z shifted off 1.1 (got ${shortSocket.z})`);
    for (const axis of ['x', 'y', 'z'] as const) {
      assert.ok(
        Math.abs(shortSpan.joint.pos[axis] - shortSocket[axis]) < 1e-9,
        `short stump joint.pos.${axis} (${shortSpan.joint.pos[axis]}) matches getFinalSocketPosition (${shortSocket[axis]})`,
      );
    }
    assert.equal(shortSpan.contactCone.socketJointId, shortSpan.joint.id);
  } finally {
    setSettings(createDefaultSettings());
    resetStore();
  }
});

test('a stump whose contact sits below the root top at tipZ = 0.5 is refused as STUMP_BELOW_ROOT', () => {
  resetStore();
  const defaults = createDefaultSettings();
  setSettings({
    ...defaults,
    tip: {
      ...defaults.tip,
      lengthMm: 6,
    },
  });

  try {
    const result = placeStumpOn(0.5);
    assert.equal(result?.refusal, 'STUMP_BELOW_ROOT');
    const stump = result?.placed.entity as Stump;
    assert.equal(stump.joint.pos.z, 1.1);
  } finally {
    setSettings(createDefaultSettings());
    resetStore();
  }
});
