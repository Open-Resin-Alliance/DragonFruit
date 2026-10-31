import assert from 'node:assert/strict';
import * as THREE from 'three';
import test from 'node:test';
import { buildProxyTiles } from '../supportProxyTiles';
import type { FlatProxyGeometry } from '../supportProxyTiles';
import type { InstancedShaft } from '../SupportPrimitives/Shaft/InstancedShaftGroup';
import type { InstancedRoot } from '../SupportPrimitives/Roots/InstancedRootsGroup';
import type { InstancedJoint } from '../SupportPrimitives/Joint/InstancedJointGroup';

function emptyGeometry(): FlatProxyGeometry {
  return { straightShafts: [], curvedShafts: [], roots: [], joints: [], cones: [] };
}

function shaft(x: number, y: number, i: number): InstancedShaft {
  return {
    id: `s${i}`,
    supportId: 'p',
    start: { x, y, z: 0 },
    end: { x, y, z: 10 },
    diameter: 1,
    diameterEnd: 0.8,
  } as InstancedShaft;
}

function root(x: number, y: number, i: number): InstancedRoot {
  return {
    id: `r${i}`,
    basePos: { x, y, z: 0 },
    bottomRadius: 2,
    topRadius: 0.5,
    effectiveDiskHeight: 0.3,
    coneHeight: 1.2,
  } as InstancedRoot;
}

function joint(x: number, y: number, i: number): InstancedJoint {
  return { id: `j${i}`, pos: { x, y, z: 5 }, diameter: 1 } as InstancedJoint;
}

function spread(count: number): FlatProxyGeometry {
  const geometry = emptyGeometry();
  for (let i = 0; i < count; i += 1) {
    const x = -90 + (i % 60) * 3;
    const y = -50 + (i % 37) * 2.5;
    if (i % 3 === 0) geometry.straightShafts.push(shaft(x, y, i));
    else if (i % 3 === 1) geometry.roots.push(root(x, y, i));
    else geometry.joints.push(joint(x, y, i));
  }
  return geometry;
}

test('a large support set is partitioned into tiles without losing a primitive', () => {
  const live = spread(4000);
  const tiles = buildProxyTiles(live, emptyGeometry()).live;

  assert.ok(tiles.length > 1, 'the grid is used above the threshold');
  const shaftIds = tiles.flatMap((tile) => tile.straightShafts.map((entry) => entry.id));
  const rootIds = tiles.flatMap((tile) => tile.roots.map((entry) => entry.id));
  const jointIds = tiles.flatMap((tile) => tile.joints.map((entry) => entry.id));

  assert.equal(shaftIds.length, live.straightShafts.length);
  assert.equal(rootIds.length, live.roots.length);
  assert.equal(jointIds.length, live.joints.length);
  assert.equal(new Set(shaftIds).size, shaftIds.length, 'each shaft lands in exactly one tile');
  assert.equal(new Set(rootIds).size, rootIds.length);
  assert.equal(new Set(jointIds).size, jointIds.length);
});

test('each tile sphere contains the primitives it was built from', () => {
  const live = spread(4000);
  for (const tile of buildProxyTiles(live, emptyGeometry()).live) {
    assert.ok(tile.sphere, 'a partitioned tile has a culling sphere');
    for (const entry of tile.straightShafts) {
      assert.ok(tile.sphere.containsPoint(new THREE.Vector3(entry.start.x, entry.start.y, entry.start.z)));
      assert.ok(tile.sphere.containsPoint(new THREE.Vector3(entry.end.x, entry.end.y, entry.end.z)));
    }
    for (const entry of tile.roots) {
      assert.ok(tile.sphere.containsPoint(new THREE.Vector3(entry.basePos.x, entry.basePos.y, entry.basePos.z)));
    }
    for (const entry of tile.joints) {
      assert.ok(tile.sphere.containsPoint(new THREE.Vector3(entry.pos.x, entry.pos.y, entry.pos.z)));
    }
  }
});

test('a small set stays in one uncullable tile', () => {
  const live = spread(30);
  const tiles = buildProxyTiles(live, emptyGeometry()).live;

  assert.equal(tiles.length, 1);
  assert.equal(tiles[0].sphere, null, 'one tile spanning the set must not be culled');
  assert.equal(tiles[0].straightShafts.length, live.straightShafts.length);
});
