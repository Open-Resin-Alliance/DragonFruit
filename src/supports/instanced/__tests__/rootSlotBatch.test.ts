import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import {
  ROOT_RENDER_LIFT_MM,
  type InstancedRoot,
} from '../../SupportPrimitives/Roots/InstancedRootsGroup';
import type { Vec3 } from '../../types';
import {
  INSTANCE_FLAG_VISIBLE,
  INSTANCE_TYPE_ROOT,
  getInstanceFlag,
  readType,
} from '../instanceFlags';
import {
  JOINT_HOVER_EMISSIVE_INTENSITY,
  JOINT_MARQUEE_COLOR,
} from '../instancedPalette';
import { buildRootSlotIndex, type RootSlotGroup, type RootSlotIndex } from '../rootSlots';
import {
  ROOT_DISK_BATCH_KEY,
  ROOT_SLOT_DATA,
  ROOT_SPHERE_BATCH_KEY,
  applyRootSlotStateChanges,
  computeRootSlotStates,
  diffRootSlotStates,
  writeAllRootSlots,
  writeRootConeMatrix,
  writeRootDiskMatrix,
  writeRootSlot,
  writeRootSphereMatrix,
} from '../rootSlotBatch';
import { SupportInstanceBatch } from '../supportInstanceBatch';

const at = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

function root(
  id: string,
  supportId: string,
  basePos: Vec3,
  overrides: Partial<Omit<InstancedRoot, 'id' | 'supportId' | 'basePos'>> = {},
): InstancedRoot {
  return {
    id,
    supportId,
    basePos,
    bottomRadius: 4,
    topRadius: 1,
    effectiveDiskHeight: 0.1,
    coneHeight: 0.6,
    ...overrides,
  };
}

/**
 * root-1 has the full stack in the 0.25 bucket, root-2 is the disk-only shape
 * (its own raw ratio is 0.2725, so it would share that bucket), root-3 is a
 * second bucket with a different top radius.
 */
function groups(): RootSlotGroup[] {
  return [
    {
      color: '#ff8800',
      roots: [
        root('root-1', 'sup-1', at(1, 1, 2)),
        root('root-2', 'sup-1', at(2, 1, 2), {
          topRadius: 1.09,
          effectiveDiskHeight: 0.2,
          coneHeight: 0,
        }),
      ],
    },
    {
      color: '#888888',
      roots: [root('root-3', 'sup-2', at(3, 1, 2), { topRadius: 2, coneHeight: 0.4 })],
    },
  ];
}

function batchFor(capacity = 1): SupportInstanceBatch {
  return new SupportInstanceBatch(new THREE.CylinderGeometry(1, 1, 1, 4), capacity);
}

function batchesFor(index: RootSlotIndex, capacity = 1): Map<string, SupportInstanceBatch> {
  const batches = new Map<string, SupportInstanceBatch>();
  if (index.disks.length > 0) batches.set(ROOT_DISK_BATCH_KEY, batchFor(capacity));
  if (index.spheres.length > 0) batches.set(ROOT_SPHERE_BATCH_KEY, batchFor(capacity));
  for (const bucket of index.buckets) batches.set(bucket.key, batchFor(capacity));
  return batches;
}

function attribute<T extends THREE.BufferAttribute>(
  batch: SupportInstanceBatch,
  name: string,
): T {
  return batch.geometry.getAttribute(name) as T;
}

function matrixOf(batch: SupportInstanceBatch, instance: number): number[] {
  const array = attribute<THREE.InstancedBufferAttribute>(batch, 'instanceMatrix')
    .array as Float32Array;
  return Array.from(array.subarray(instance * 16, instance * 16 + 16));
}

function matrixAt(batch: SupportInstanceBatch, instance: number): THREE.Matrix4 {
  return new THREE.Matrix4().fromArray(matrixOf(batch, instance));
}

function decomposed(batch: SupportInstanceBatch, instance: number): {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
} {
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrixAt(batch, instance).decompose(position, quaternion, scale);
  return { position, quaternion, scale };
}

function colorOf(batch: SupportInstanceBatch, instance: number): THREE.Color {
  const array = attribute<THREE.InstancedBufferAttribute>(batch, 'color').array as Float32Array;
  return new THREE.Color(array[instance * 3], array[instance * 3 + 1], array[instance * 3 + 2]);
}

function ratioOf(batch: SupportInstanceBatch, instance: number): number {
  return (attribute<THREE.InstancedBufferAttribute>(batch, 'iRatio').array as Float32Array)[instance];
}

function dataOf(batch: SupportInstanceBatch, instance: number): number {
  return (attribute<THREE.InstancedBufferAttribute>(batch, 'iData').array as Uint32Array)[instance];
}

function closeTo(actual: number, expected: number, epsilon = 1e-5): boolean {
  return Math.abs(actual - expected) < epsilon;
}

function assertPoint(actual: THREE.Vector3, expected: { x: number; y: number; z: number }): void {
  assert.ok(closeTo(actual.x, expected.x), `x ${actual.x} != ${expected.x}`);
  assert.ok(closeTo(actual.y, expected.y), `y ${actual.y} != ${expected.y}`);
  assert.ok(closeTo(actual.z, expected.z), `z ${actual.z} != ${expected.z}`);
}

function assertColor(actual: THREE.Color, expected: THREE.Color): void {
  // The palette clamps the emissive lift at white; `Color.addScalar` does not.
  assert.ok(closeTo(actual.r, Math.min(1, expected.r), 1e-6), `r ${actual.r} != ${expected.r}`);
  assert.ok(closeTo(actual.g, Math.min(1, expected.g), 1e-6), `g ${actual.g} != ${expected.g}`);
  assert.ok(closeTo(actual.b, Math.min(1, expected.b), 1e-6), `b ${actual.b} != ${expected.b}`);
}

test('writeAllRootSlots fills the disk, top-ball and cone batches in producer order', () => {
  const index = buildRootSlotIndex(groups());
  const batches = batchesFor(index);

  writeAllRootSlots(index, batches);

  const disks = batches.get(ROOT_DISK_BATCH_KEY)!;
  const spheres = batches.get(ROOT_SPHERE_BATCH_KEY)!;
  assert.equal(disks.count, 3);
  assert.equal(disks.geometry.instanceCount, 3);
  assert.equal(spheres.count, 2);
  assert.equal(batches.get('0.25')!.count, 1);
  assert.equal(batches.get('0.5')!.count, 1);

  // Every record has a disk instance of its own; the cone-bearing ones also
  // hold dense cone and top-ball instances.
  assert.deepEqual(
    index.disks.map((record) => record.diskInstance),
    [0, 1, 2],
  );
  for (const record of index.disks) {
    assertPoint(decomposed(disks, record.diskInstance).position, {
      x: record.slot.basePos.x,
      y: record.slot.basePos.y,
      z: record.slot.basePos.z + ROOT_RENDER_LIFT_MM + record.slot.diskHeight / 2,
    });
  }
  for (const record of index.spheres) {
    const { position, scale } = decomposed(spheres, record.sphereInstance as number);
    assertPoint(position, {
      x: record.slot.basePos.x,
      y: record.slot.basePos.y,
      z:
        record.slot.basePos.z +
        ROOT_RENDER_LIFT_MM +
        record.slot.diskHeight +
        record.slot.coneHeight,
    });
    const topRadius = Math.max(0.001, record.slot.topRadius);
    assert.ok(closeTo(scale.x, topRadius));
    assert.ok(closeTo(scale.y, topRadius));
    assert.ok(closeTo(scale.z, topRadius));
  }
});

test('the disk sits on the plate, lifted, stood up onto Z by Rx(90°)', () => {
  const index = buildRootSlotIndex(groups());
  const batches = batchesFor(index);
  writeAllRootSlots(index, batches);
  const disks = batches.get(ROOT_DISK_BATCH_KEY)!;

  for (const record of index.disks) {
    const { position, quaternion, scale } = decomposed(disks, record.diskInstance);
    const { slot } = record;

    assert.ok(closeTo(position.z, slot.basePos.z + 0.01 + slot.diskHeight / 2));
    assert.ok(closeTo(position.x, slot.basePos.x));
    assert.ok(closeTo(position.y, slot.basePos.y));

    // The cylinder is authored Y-up: its height axis must be world Z.
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);
    assertPoint(up, at(0, 0, 1));

    const bottomRadius = Math.max(0.001, slot.bottomRadius);
    assert.ok(closeTo(scale.x, bottomRadius));
    assert.ok(closeTo(scale.y, Math.max(0.001, slot.diskHeight)));
    assert.ok(closeTo(scale.z, bottomRadius));
    assert.equal(ratioOf(disks, record.diskInstance), 1);
  }
});

test('the base cone spans the disk’s top face to the top ball, at the bucket ratio', () => {
  const index = buildRootSlotIndex(groups());
  const batches = batchesFor(index);
  writeAllRootSlots(index, batches);

  for (const record of index.buckets.flatMap((bucket) => bucket.records)) {
    const batch = batches.get(record.bucketKey as string)!;
    const instance = record.coneInstance as number;
    const { position, quaternion, scale } = decomposed(batch, instance);
    const { slot } = record;

    assert.ok(
      closeTo(
        position.z,
        slot.basePos.z + ROOT_RENDER_LIFT_MM + slot.diskHeight + slot.coneHeight / 2,
      ),
    );
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);
    assertPoint(up, at(0, 0, 1));

    const bottomRadius = Math.max(0.001, slot.bottomRadius);
    assert.ok(closeTo(scale.x, bottomRadius));
    assert.ok(closeTo(scale.y, Math.max(0.001, slot.coneHeight)));
    assert.ok(closeTo(scale.z, bottomRadius));
    // The bucket's geometry carries the taper; the instance reports it for a
    // later shader taper.
    assert.ok(closeTo(ratioOf(batch, instance), record.ratio, 1e-6));
  }

  const widened = index.buckets.find((bucket) => bucket.key === '0.5')!;
  assert.equal(widened.ratio, 0.5);
  assert.ok(closeTo(ratioOf(batches.get('0.5')!, widened.records[0].coneInstance as number), 0.5));
});

test('the top ball is a uniform sphere at the cone’s small end, unrotated', () => {
  const index = buildRootSlotIndex(groups());
  const batches = batchesFor(index);
  writeAllRootSlots(index, batches);
  const spheres = batches.get(ROOT_SPHERE_BATCH_KEY)!;

  for (const record of index.spheres) {
    const { quaternion, scale } = decomposed(spheres, record.sphereInstance as number);
    assert.ok(closeTo(quaternion.angleTo(new THREE.Quaternion()), 0, 1e-6));
    const topRadius = Math.max(0.001, record.slot.topRadius);
    assert.ok(closeTo(scale.x, topRadius));
    assert.ok(closeTo(scale.y, topRadius));
    assert.ok(closeTo(scale.z, topRadius));
    assert.equal(ratioOf(spheres, record.sphereInstance as number), 1);
  }
});

test('a root with no cone draws only its disk', () => {
  const index = buildRootSlotIndex(groups());
  const batches = batchesFor(index);
  writeAllRootSlots(index, batches);

  const diskOnly = index.slots[1];
  assert.equal(diskOnly.slot.coneHeight, 0);
  assert.equal(diskOnly.coneInstance, undefined);
  // Its disk is still drawn, at the plate.
  const disks = batches.get(ROOT_DISK_BATCH_KEY)!;
  assertPoint(decomposed(disks, diskOnly.diskInstance).position, {
    x: 2,
    y: 1,
    z: 2 + ROOT_RENDER_LIFT_MM + 0.1,
  });

  // It belongs to no cone batch: the buckets hold only cone-bearing roots.
  const allConeRecords = index.buckets.flatMap((bucket) => bucket.records);
  assert.equal(allConeRecords.some((record) => record.id === diskOnly.id), false);
});

test('the lift is the legacy 0.01 mm, and a caller can override it', () => {
  const index = buildRootSlotIndex(groups());
  const batch = batchFor();
  batch.resizeTo(1, ROOT_SLOT_DATA, 1);
  const slot = index.slots[0].slot;

  assert.equal(ROOT_RENDER_LIFT_MM, 0.01);

  writeRootDiskMatrix(batch, 0, slot);
  assert.ok(closeTo(decomposed(batch, 0).position.z, slot.basePos.z + 0.01 + slot.diskHeight / 2));

  writeRootDiskMatrix(batch, 0, slot, 0.5);
  assert.ok(closeTo(decomposed(batch, 0).position.z, slot.basePos.z + 0.5 + slot.diskHeight / 2));

  writeRootConeMatrix(batch, 0, slot, 0);
  assert.ok(closeTo(decomposed(batch, 0).position.z, slot.basePos.z + slot.diskHeight + slot.coneHeight / 2));

  writeRootSphereMatrix(batch, 0, slot, 0);
  assert.ok(closeTo(decomposed(batch, 0).position.z, slot.basePos.z + slot.diskHeight + slot.coneHeight));
});

test('every root instance carries the root data word', () => {
  const index = buildRootSlotIndex(groups());
  const batches = batchesFor(index);
  writeAllRootSlots(index, batches);

  assert.equal(readType(ROOT_SLOT_DATA), INSTANCE_TYPE_ROOT);
  assert.equal(getInstanceFlag(ROOT_SLOT_DATA, INSTANCE_FLAG_VISIBLE), true);

  for (const record of index.disks) {
    assert.equal(dataOf(batches.get(ROOT_DISK_BATCH_KEY)!, record.diskInstance), ROOT_SLOT_DATA);
  }
  for (const bucket of index.buckets) {
    for (const record of bucket.records) {
      assert.equal(dataOf(batches.get(bucket.key)!, record.coneInstance as number), ROOT_SLOT_DATA);
    }
  }
  for (const record of index.spheres) {
    assert.equal(dataOf(batches.get(ROOT_SPHERE_BATCH_KEY)!, record.sphereInstance as number), ROOT_SLOT_DATA);
  }
});

test('base state is the produced group colour; hover and marquee lift it with no matrix change', () => {
  const index = buildRootSlotIndex(groups());
  const batches = batchesFor(index);
  writeAllRootSlots(index, batches);

  const disks = batches.get(ROOT_DISK_BATCH_KEY)!;
  const record = index.slots[0];
  const before = {
    disk: matrixOf(disks, record.diskInstance),
    cone: matrixOf(batches.get('0.25')!, record.coneInstance as number),
    sphere: matrixOf(batches.get(ROOT_SPHERE_BATCH_KEY)!, record.sphereInstance as number),
  };
  const baseColor = colorOf(disks, record.diskInstance);
  assertColor(baseColor, new THREE.Color('#ff8800'));

  writeRootSlot(batches, index, record.id, 'hover');
  const hoverColor = colorOf(disks, record.diskInstance);
  assert.ok(closeTo(hoverColor.r, Math.min(1, baseColor.r + JOINT_HOVER_EMISSIVE_INTENSITY), 1e-6));
  assert.ok(closeTo(hoverColor.g, Math.min(1, baseColor.g + JOINT_HOVER_EMISSIVE_INTENSITY), 1e-6));
  assert.ok(closeTo(hoverColor.b, Math.min(1, baseColor.b + JOINT_HOVER_EMISSIVE_INTENSITY), 1e-6));

  // The overlays drew the same geometry, so nothing scales.
  assert.deepEqual(matrixOf(disks, record.diskInstance), before.disk);
  assert.deepEqual(matrixOf(batches.get('0.25')!, record.coneInstance as number), before.cone);
  assert.deepEqual(
    matrixOf(batches.get(ROOT_SPHERE_BATCH_KEY)!, record.sphereInstance as number),
    before.sphere,
  );

  writeRootSlot(batches, index, record.id, 'marquee');
  assertColor(
    colorOf(disks, record.diskInstance),
    new THREE.Color(JOINT_MARQUEE_COLOR).addScalar(JOINT_HOVER_EMISSIVE_INTENSITY),
  );
  assert.deepEqual(matrixOf(disks, record.diskInstance), before.disk);

  writeRootSlot(batches, index, record.id, 'base');
  assertColor(colorOf(disks, record.diskInstance), baseColor);
});

test('computeRootSlotStates lets marquee win over hover, over batch-drawn slots only', () => {
  const index = buildRootSlotIndex(groups());

  assert.deepEqual([...computeRootSlotStates(index, 'sup-1', []).entries()], [
    [0, 'hover'],
    [1, 'hover'],
  ]);
  assert.deepEqual([...computeRootSlotStates(index, 'sup-1', ['sup-2']).entries()], [
    [0, 'hover'],
    [1, 'hover'],
    [2, 'marquee'],
  ]);
  assert.deepEqual([...computeRootSlotStates(index, 'sup-1', ['sup-1']).entries()], [
    [0, 'marquee'],
    [1, 'marquee'],
  ]);
  assert.equal(computeRootSlotStates(index, null, []).size, 0);
  assert.equal(computeRootSlotStates(index, 'missing', ['missing']).size, 0);
});

test('diffRootSlotStates reports only the slots that changed, ascending, ending as base', () => {
  assert.deepEqual(
    diffRootSlotStates(
      new Map([[0, 'hover'], [2, 'marquee']]),
      new Map([[0, 'hover'], [1, 'marquee'], [2, 'hover']]),
    ),
    [
      { id: 1, state: 'marquee' },
      { id: 2, state: 'hover' },
    ],
  );
  assert.deepEqual(diffRootSlotStates(new Map([[1, 'marquee' as const]]), new Map()), [
    { id: 1, state: 'base' },
  ]);
  assert.deepEqual(diffRootSlotStates(new Map(), new Map()), []);
});

test('applying a diff writes the changed roots and leaves the rest alone', () => {
  const index = buildRootSlotIndex(groups());
  const batches = batchesFor(index);
  writeAllRootSlots(index, batches);

  const disks = batches.get(ROOT_DISK_BATCH_KEY)!;
  const untouched = index.slots[2];
  const before = {
    matrix: matrixOf(disks, untouched.diskInstance),
    color: colorOf(disks, untouched.diskInstance),
  };

  const hovered = computeRootSlotStates(index, 'sup-1', []);
  applyRootSlotStateChanges(index, diffRootSlotStates(new Map(), hovered), batches);

  assertColor(
    colorOf(disks, 0),
    new THREE.Color('#ff8800').addScalar(JOINT_HOVER_EMISSIVE_INTENSITY),
  );
  assert.deepEqual(matrixOf(disks, untouched.diskInstance), before.matrix);
  assert.deepEqual(colorOf(disks, untouched.diskInstance), before.color);

  applyRootSlotStateChanges(
    index,
    diffRootSlotStates(hovered, computeRootSlotStates(index, null, [])),
    batches,
  );
  assertColor(colorOf(disks, 0), new THREE.Color('#ff8800'));

  assert.throws(
    () => applyRootSlotStateChanges(index, [{ id: 99, state: 'hover' }], batches),
    /slot 99 is outside/,
  );
});

test('growth preserves the live instances and drops three’s cached instance cap', () => {
  const oneGroup = buildRootSlotIndex([groups()[0]]);
  const index = buildRootSlotIndex(groups());

  const batches = batchesFor(index, 1);
  const disks = batches.get(ROOT_DISK_BATCH_KEY)!;
  const geometry = disks.geometry as THREE.InstancedBufferGeometry & {
    _maxInstanceCount?: number;
  };
  writeAllRootSlots(oneGroup, batches);

  assert.equal(disks.count, 2);
  const firstMatrix = matrixOf(disks, 0);
  const firstColor = colorOf(disks, 0);

  geometry._maxInstanceCount = disks.capacity;
  writeAllRootSlots(index, batches);
  assert.equal(disks.count, 3);
  assert.ok(disks.capacity >= 3);
  assert.equal(geometry._maxInstanceCount, undefined);
  assert.equal(disks.geometry, geometry);
  assert.deepEqual(matrixOf(disks, 0), firstMatrix);
  assert.deepEqual(colorOf(disks, 0), firstColor);

  geometry._maxInstanceCount = disks.capacity;
  writeAllRootSlots(oneGroup, batches);
  assert.equal(disks.count, 2);
  assert.equal(geometry._maxInstanceCount, disks.capacity);
});

test('a batch the index no longer names is emptied, never left drawing the old layout', () => {
  const index = buildRootSlotIndex(groups());
  const batches = batchesFor(index);
  batches.set('0.9', batchFor());
  writeAllRootSlots(index, batches);
  assert.equal(batches.get('0.9')!.count, 0);

  const diskOnly = buildRootSlotIndex([
    { color: '#ff8800', roots: [root('disk-only', 'sup-1', at(0, 0, 1), { coneHeight: 0 })] },
  ]);
  writeAllRootSlots(diskOnly, batches);
  assert.equal(batches.get(ROOT_DISK_BATCH_KEY)!.count, 1);
  assert.equal(batches.get(ROOT_SPHERE_BATCH_KEY)!.count, 0);
  assert.equal(batches.get('0.25')!.count, 0);
  assert.equal(batches.get('0.5')!.count, 0);
});

test('a batch the index does not name is a loud failure, not a silent skip', () => {
  const index = buildRootSlotIndex(groups());
  assert.throws(() => writeAllRootSlots(index, new Map()), /no batch for "disk"/);

  const noSpheres = batchesFor(index);
  noSpheres.delete(ROOT_SPHERE_BATCH_KEY);
  assert.throws(() => writeAllRootSlots(index, noSpheres), /no batch for "sphere"/);

  const noBucket = batchesFor(index);
  noBucket.delete('0.5');
  assert.throws(() => writeAllRootSlots(index, noBucket), /no batch for "0\.5"/);
});

test('an empty index is a no-op and writes into no batch', () => {
  const batches = new Map<string, SupportInstanceBatch>();
  writeAllRootSlots(buildRootSlotIndex([]), batches);
  assert.equal(batches.size, 0);
});

test('the per-primitive writers are public, so a drag can move one root', () => {
  const index = buildRootSlotIndex(groups());
  const batches = batchesFor(index);
  writeAllRootSlots(index, batches);

  const record = index.slots[0];
  const slot = { ...record.slot, basePos: at(9, 9, 9) };

  writeRootDiskMatrix(batches.get(ROOT_DISK_BATCH_KEY)!, record.diskInstance, slot);
  writeRootConeMatrix(batches.get('0.25')!, record.coneInstance as number, slot);
  writeRootSphereMatrix(
    batches.get(ROOT_SPHERE_BATCH_KEY)!,
    record.sphereInstance as number,
    slot,
  );

  assertPoint(decomposed(batches.get(ROOT_DISK_BATCH_KEY)!, record.diskInstance).position, {
    x: 9,
    y: 9,
    z: 9 + ROOT_RENDER_LIFT_MM + slot.diskHeight / 2,
  });
  assertPoint(
    decomposed(batches.get(ROOT_SPHERE_BATCH_KEY)!, record.sphereInstance as number).position,
    { x: 9, y: 9, z: 9 + ROOT_RENDER_LIFT_MM + slot.diskHeight + slot.coneHeight },
  );
});
