import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import {
  getDiskCenter,
  getDiskRotation,
} from '../../SupportPrimitives/ContactDisk/contactDiskUtils';
import { getConeQuaternion } from '../../SupportPrimitives/ContactCone/contactConeUtils';
import type { InstancedContactCone } from '../../SupportPrimitives/ContactCone/InstancedContactConeGroup';
import type { SupportTipProfile } from '../../SupportPrimitives/ContactCone/types';
import type { Vec3 } from '../../types';
import {
  INSTANCE_FLAG_DISK_SHADE,
  INSTANCE_PROFILE_DISK,
  INSTANCE_PROFILE_LEGACY,
  INSTANCE_PROFILE_SPHERE,
  INSTANCE_TYPE_CONE,
  getInstanceFlag,
  readProfile,
  readType,
} from '../instanceFlags';
import {
  JOINT_HOVER_EMISSIVE_INTENSITY,
  JOINT_MARQUEE_COLOR,
} from '../instancedPalette';
import { buildConeSlotIndex, type ConeSlotGroup, type ConeSlotIndex } from '../coneSlots';
import {
  CONE_DISK_BATCH_KEY,
  CONE_DISK_PRIMITIVE_DATA,
  CONE_TIP_BATCH_KEY,
  applyConeSlotStateChanges,
  computeConeSlotStates,
  coneSlotData,
  diffConeSlotStates,
  writeAllConeSlots,
  writeConeBodyMatrix,
  writeConeDiskMatrix,
  writeConeSlot,
  writeConeTipMatrix,
} from '../coneSlotBatch';
import { SupportInstanceBatch } from '../supportInstanceBatch';

const at = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

function diskProfile(
  contactDiameterMm = 0.4,
  bodyDiameterMm = 1.23,
  lengthMm = 3,
): SupportTipProfile {
  return {
    type: 'disk',
    contactDiameterMm,
    bodyDiameterMm,
    lengthMm,
    penetrationMm: 0.05,
    diskThicknessMm: 0.1,
    maxStandoffMm: 0.25,
    standoffAngleThreshold: Math.PI / 4,
  };
}

function sphereProfile(
  contactDiameterMm = 0.4,
  bodyDiameterMm = 1.244,
  lengthMm = 4,
): SupportTipProfile {
  return {
    type: 'sphere',
    sphereRadiusRatio: 1.5,
    contactDiameterMm,
    bodyDiameterMm,
    lengthMm,
    penetrationMm: 0.05,
  };
}

function cone(
  id: string,
  supportId: string,
  pos: Vec3,
  normal: Vec3,
  profile: SupportTipProfile,
  extra: Partial<InstancedContactCone> = {},
): InstancedContactCone {
  return { id, supportId, pos, normal, profile, ...extra };
}

/**
 * One body bucket (`3.1`) holding a disk cone, a sphere cone and a disk cone on
 * another support along a different axis: enough to prove profile merging and
 * per-record transforms without a second geometry.
 */
function groups(): ConeSlotGroup[] {
  return [
    {
      color: '#a1a1a1',
      cones: [
        cone('disk-1', 'sup-1', at(0, 0, 1), at(0, 0, -1), diskProfile()),
        cone('sphere-1', 'sup-1', at(1, 0, 1), at(0, 0, -1), sphereProfile(), {
          surfaceNormal: at(0.2, 0, -0.98),
        }),
      ],
    },
    {
      color: '#b2b2b2',
      cones: [
        cone('disk-2', 'sup-2', at(0, 2, 1), at(1, 0, 0), diskProfile()),
      ],
    },
  ];
}

/** Nib depth: the writer's input, never the index's. */
const penetrationOf = (slot: { kind: string }): number => (slot.kind === 'disk' ? 0.5 : 0);

function batchFor(capacity = 1): SupportInstanceBatch {
  return new SupportInstanceBatch(new THREE.CylinderGeometry(1, 1, 1, 4), capacity);
}

function batchesFor(index: ConeSlotIndex, capacity = 1): Map<string, SupportInstanceBatch> {
  const batches = new Map<string, SupportInstanceBatch>();
  for (const bucket of index.bodies) batches.set(bucket.key, batchFor(capacity));
  if (index.tips.length > 0) batches.set(CONE_TIP_BATCH_KEY, batchFor(capacity));
  if (index.disks.length > 0) batches.set(CONE_DISK_BATCH_KEY, batchFor(capacity));
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

/** The instance's radius, read off the matrix's first basis column. */
function radialScale(batch: SupportInstanceBatch, instance: number): number {
  return new THREE.Vector3().setFromMatrixColumn(matrixAt(batch, instance), 0).length();
}

/** The instance's local-Y extent, which is the frustum's height. */
function lengthScale(batch: SupportInstanceBatch, instance: number): number {
  return new THREE.Vector3().setFromMatrixColumn(matrixAt(batch, instance), 1).length();
}

test('writeAllConeSlots fills one body bucket, the tip batch and the disk batch in producer order', () => {
  const index = buildConeSlotIndex(groups());
  const batches = batchesFor(index);

  writeAllConeSlots(index, batches, penetrationOf);

  const body = batches.get('3.1')!;
  const tips = batches.get(CONE_TIP_BATCH_KEY)!;
  const disks = batches.get(CONE_DISK_BATCH_KEY)!;
  assert.equal(body.count, 3);
  assert.equal(body.geometry.instanceCount, 3);
  assert.equal(tips.count, 3);
  assert.equal(disks.count, 2);

  // Body instances are dense inside the bucket, and each record's tip instance
  // is the dense index across the whole list: writing a slot writes every
  // primitive it owns.
  assert.deepEqual(new Set(index.slots.map((record) => record.bodyInstance)).size, 3);
  for (const record of index.slots) {
    const offset = record.slot.kind === 'disk' ? record.slot.diskThickness : 0;
    assertPoint(new THREE.Vector3().setFromMatrixPosition(matrixAt(tips, record.tipInstance)), {
      x: record.slot.pos.x + record.slot.surfaceNormal.x * offset,
      y: record.slot.pos.y + record.slot.surfaceNormal.y * offset,
      z: record.slot.pos.z + record.slot.surfaceNormal.z * offset,
    });
    assert.ok(closeTo(radialScale(tips, record.tipInstance), record.slot.contactRadius));
  }
});

test('the body matrix spans start to socket, from the template’s +y to its −y', () => {
  const index = buildConeSlotIndex(groups());
  const batches = batchesFor(index);
  writeAllConeSlots(index, batches, penetrationOf);
  const body = batches.get('3.1')!;

  for (const record of index.slots) {
    const { slot } = record;
    const offset = slot.kind === 'disk' ? slot.diskThickness : 0;
    const start = {
      x: slot.pos.x + slot.surfaceNormal.x * offset,
      y: slot.pos.y + slot.surfaceNormal.y * offset,
      z: slot.pos.z + slot.surfaceNormal.z * offset,
    };
    const socket = {
      x: start.x + slot.normal.x * slot.lengthMm,
      y: start.y + slot.normal.y * slot.lengthMm,
      z: start.z + slot.normal.z * slot.lengthMm,
    };
    const matrix = matrixAt(body, record.bodyInstance);

    // `+y` is rotated onto `-normal`, so the template's `+y` cap is the contact
    // end and its `-y` cap the socket.
    assertPoint(new THREE.Vector3(0, 0.5, 0).applyMatrix4(matrix), start);
    assertPoint(new THREE.Vector3(0, -0.5, 0).applyMatrix4(matrix), socket);
    assertPoint(
      new THREE.Vector3().setFromMatrixPosition(matrix),
      {
        x: start.x + slot.normal.x * (slot.lengthMm / 2),
        y: start.y + slot.normal.y * (slot.lengthMm / 2),
        z: start.z + slot.normal.z * (slot.lengthMm / 2),
      },
    );

    assert.ok(closeTo(radialScale(body, record.bodyInstance), slot.contactRadius));
    assert.ok(closeTo(lengthScale(body, record.bodyInstance), slot.lengthMm));
    // The bucket's geometry ratio is the instance ratio a shader taper would read.
    assert.ok(closeTo(ratioOf(body, record.bodyInstance), record.bodyRatio, 1e-6));
  }
});

test('the body rotation is exactly the legacy cone quaternion', () => {
  const index = buildConeSlotIndex(groups());
  const batches = batchesFor(index);
  writeAllConeSlots(index, batches, penetrationOf);
  const body = batches.get('3.1')!;

  for (const record of index.slots) {
    const expected = getConeQuaternion(record.slot.normal);
    const actual = decomposed(body, record.bodyInstance).quaternion;
    assert.ok(closeTo(actual.angleTo(expected), 0, 1e-6));
  }
});

test('the tip is the contact point, unrotated, at the contact radius', () => {
  const index = buildConeSlotIndex(groups());
  const batches = batchesFor(index);
  writeAllConeSlots(index, batches, penetrationOf);
  const tips = batches.get(CONE_TIP_BATCH_KEY)!;

  for (const record of index.tips) {
    const { slot } = record;
    const offset = slot.kind === 'disk' ? slot.diskThickness : 0;
    const matrix = matrixAt(tips, record.tipInstance);

    assertPoint(new THREE.Vector3().setFromMatrixPosition(matrix), {
      x: slot.pos.x + slot.surfaceNormal.x * offset,
      y: slot.pos.y + slot.surfaceNormal.y * offset,
      z: slot.pos.z + slot.surfaceNormal.z * offset,
    });
    assert.ok(
      closeTo(
        decomposed(tips, record.tipInstance).quaternion.angleTo(new THREE.Quaternion()),
        0,
        1e-6,
      ),
    );
    assert.ok(closeTo(radialScale(tips, record.tipInstance), slot.contactRadius));
    assert.equal(ratioOf(tips, record.tipInstance), 1);
  }
});

test('the nib centre is pulled back by half the penetration and aligned to the surface', () => {
  const index = buildConeSlotIndex(groups());
  const batches = batchesFor(index);
  writeAllConeSlots(index, batches, penetrationOf);
  const disks = batches.get(CONE_DISK_BATCH_KEY)!;

  for (const record of index.disks) {
    const { slot } = record;
    const matrix = matrixAt(disks, record.diskInstance);
    const centre = getDiskCenter(slot.pos, slot.surfaceNormal, slot.diskThickness);
    const penetration = penetrationOf(slot);

    assertPoint(new THREE.Vector3().setFromMatrixPosition(matrix), {
      x: centre.x - slot.surfaceNormal.x * (penetration / 2),
      y: centre.y - slot.surfaceNormal.y * (penetration / 2),
      z: centre.z - slot.surfaceNormal.z * (penetration / 2),
    });

    const expected = getDiskRotation(slot.surfaceNormal);
    const actual = decomposed(disks, record.diskInstance as number).quaternion;
    assert.ok(closeTo(actual.angleTo(expected), 0, 1e-6));

    assert.ok(closeTo(radialScale(disks, record.diskInstance), slot.contactRadius));
    assert.ok(
      closeTo(lengthScale(disks, record.diskInstance), slot.diskThickness + penetration),
    );
    assert.equal(ratioOf(disks, record.diskInstance), 1);
  }
});

test('a lower penetration shrinks the nib but never its radius', () => {
  const index = buildConeSlotIndex(groups());
  const batches = batchesFor(index);
  writeAllConeSlots(index, batches, penetrationOf);
  const record = index.disks[0];
  const diskBatch = batches.get(CONE_DISK_BATCH_KEY)!;

  writeConeDiskMatrix(diskBatch, record.diskInstance, record.slot, 0.5);
  const thick = lengthScale(diskBatch, record.diskInstance);
  writeConeDiskMatrix(diskBatch, record.diskInstance, record.slot, 0);
  const thin = lengthScale(diskBatch, record.diskInstance);

  assert.ok(closeTo(thick - thin, 0.5));
  assert.ok(closeTo(radialScale(diskBatch, record.diskInstance), record.slot.contactRadius));
  // A negative penetration is clamped, not inverted.
  writeConeDiskMatrix(diskBatch, record.diskInstance, record.slot, -1);
  assert.ok(closeTo(lengthScale(diskBatch, record.diskInstance), record.slot.diskThickness));
});

test('the data words carry the cone type, the profile and the nib’s disk shade bit', () => {
  const index = buildConeSlotIndex(groups());
  const batches = batchesFor(index);
  writeAllConeSlots(index, batches, penetrationOf);

  const body = batches.get('3.1')!;
  const tips = batches.get(CONE_TIP_BATCH_KEY)!;
  const disks = batches.get(CONE_DISK_BATCH_KEY)!;

  const profileCode = { disk: INSTANCE_PROFILE_DISK, sphere: INSTANCE_PROFILE_SPHERE, legacy: INSTANCE_PROFILE_LEGACY };

  for (const record of index.slots) {
    for (const word of [
      dataOf(body, record.bodyInstance),
      dataOf(tips, record.tipInstance),
    ]) {
      assert.equal(readType(word), INSTANCE_TYPE_CONE);
      assert.equal(readProfile(word), profileCode[record.kind]);
      assert.equal(getInstanceFlag(word, INSTANCE_FLAG_DISK_SHADE), false);
    }
    assert.equal(dataOf(body, record.bodyInstance), coneSlotData(record.kind));
  }

  for (const record of index.disks) {
    const word = dataOf(disks, record.diskInstance);
    assert.equal(readType(word), INSTANCE_TYPE_CONE);
    assert.equal(readProfile(word), INSTANCE_PROFILE_DISK);
    assert.equal(getInstanceFlag(word, INSTANCE_FLAG_DISK_SHADE), true);
    assert.equal(word, CONE_DISK_PRIMITIVE_DATA);
  }
});

test('base state is the produced group colour, in the space a vertex colour is read in', () => {
  const index = buildConeSlotIndex(groups());
  const batches = batchesFor(index);
  writeAllConeSlots(index, batches, penetrationOf);

  const body = batches.get('3.1')!;
  for (const record of index.slots) {
    assertColor(colorOf(body, record.bodyInstance), new THREE.Color(record.color));
  }
});

test('hover and marquee lift the colour and leave every matrix alone', () => {
  const index = buildConeSlotIndex(groups());
  const batches = batchesFor(index);
  writeAllConeSlots(index, batches, penetrationOf);

  const body = batches.get('3.1')!;
  const tips = batches.get(CONE_TIP_BATCH_KEY)!;
  const disks = batches.get(CONE_DISK_BATCH_KEY)!;
  const record = index.slots[0];
  const before = {
    body: matrixOf(body, record.bodyInstance),
    tip: matrixOf(tips, record.tipInstance),
    disk: matrixOf(disks, record.diskInstance as number),
  };
  const baseColor = colorOf(body, record.bodyInstance);

  writeConeSlot(batches, index, record.id, 'hover', penetrationOf);

  const hoverColor = colorOf(body, record.bodyInstance);
  assert.ok(closeTo(hoverColor.r, Math.min(1, baseColor.r + JOINT_HOVER_EMISSIVE_INTENSITY), 1e-6));
  assert.ok(closeTo(hoverColor.g, Math.min(1, baseColor.g + JOINT_HOVER_EMISSIVE_INTENSITY), 1e-6));
  assert.ok(closeTo(hoverColor.b, Math.min(1, baseColor.b + JOINT_HOVER_EMISSIVE_INTENSITY), 1e-6));

  // A contact cone has no hover scale: the overlays drew the same geometry.
  assert.deepEqual(matrixOf(body, record.bodyInstance), before.body);
  assert.deepEqual(matrixOf(tips, record.tipInstance), before.tip);
  assert.deepEqual(matrixOf(disks, record.diskInstance as number), before.disk);

  // The tip and nib lift too: they are the same support's highlight.
  assertColor(colorOf(tips, record.tipInstance), hoverColor);
  assertColor(colorOf(disks, record.diskInstance as number), hoverColor);

  writeConeSlot(batches, index, record.id, 'marquee', penetrationOf);
  const marquee = new THREE.Color(JOINT_MARQUEE_COLOR).addScalar(JOINT_HOVER_EMISSIVE_INTENSITY);
  assertColor(colorOf(body, record.bodyInstance), marquee);
  assert.deepEqual(matrixOf(body, record.bodyInstance), before.body);

  // Back to base restores the produced colour.
  writeConeSlot(batches, index, record.id, 'base', penetrationOf);
  assertColor(colorOf(body, record.bodyInstance), baseColor);
});

test('computeConeSlotStates lets marquee win over hover, over batch-drawn slots only', () => {
  const index = buildConeSlotIndex(groups());

  const hover = computeConeSlotStates(index, 'sup-1', []);
  assert.deepEqual([...hover.entries()], [[0, 'hover'], [1, 'hover']]);

  const both = computeConeSlotStates(index, 'sup-1', ['sup-2']);
  assert.deepEqual([...both.entries()], [
    [0, 'hover'],
    [1, 'hover'],
    [2, 'marquee'],
  ]);

  const marqueeWins = computeConeSlotStates(index, 'sup-1', ['sup-1']);
  assert.deepEqual([...marqueeWins.entries()], [[0, 'marquee'], [1, 'marquee']]);

  assert.equal(computeConeSlotStates(index, null, []).size, 0);
  assert.equal(computeConeSlotStates(index, 'missing', ['missing']).size, 0);
});

test('diffConeSlotStates reports only the slots that changed, ascending, ending as base', () => {
  assert.deepEqual(
    diffConeSlotStates(
      new Map([[0, 'hover'], [2, 'marquee']]),
      new Map([[0, 'hover'], [2, 'hover'], [1, 'marquee']]),
    ),
    [
      { id: 1, state: 'marquee' },
      { id: 2, state: 'hover' },
    ],
  );

  assert.deepEqual(diffConeSlotStates(new Map([[4, 'hover' as const]]), new Map()), [
    { id: 4, state: 'base' },
  ]);
  assert.deepEqual(diffConeSlotStates(new Map(), new Map()), []);
});

test('applying a diff writes the changed slots and leaves the rest alone', () => {
  const index = buildConeSlotIndex(groups());
  const batches = batchesFor(index);
  writeAllConeSlots(index, batches, penetrationOf);

  const body = batches.get('3.1')!;
  const untouched = index.slots[2];
  const before = {
    matrix: matrixOf(body, untouched.bodyInstance),
    color: colorOf(body, untouched.bodyInstance),
  };

  const hovered = computeConeSlotStates(index, 'sup-1', []);
  applyConeSlotStateChanges(
    index,
    diffConeSlotStates(new Map(), hovered),
    batches,
    penetrationOf,
  );

  const hoveredColor = new THREE.Color('#a1a1a1').addScalar(JOINT_HOVER_EMISSIVE_INTENSITY);
  assertColor(colorOf(body, 0), hoveredColor);
  assert.deepEqual(matrixOf(body, untouched.bodyInstance), before.matrix);
  assert.deepEqual(colorOf(body, untouched.bodyInstance), before.color);

  // Hover ends: the changed slots go back to base, not to their lifted state.
  applyConeSlotStateChanges(
    index,
    diffConeSlotStates(hovered, computeConeSlotStates(index, null, [])),
    batches,
    penetrationOf,
  );
  assertColor(colorOf(body, 0), new THREE.Color('#a1a1a1'));

  assert.throws(
    () => applyConeSlotStateChanges(index, [{ id: 99, state: 'hover' }], batches, penetrationOf),
    /slot 99 is outside/,
  );
});

test('growth preserves the live instances and drops three’s cached instance cap', () => {
  const oneGroup = buildConeSlotIndex([groups()[0]]);
  const index = buildConeSlotIndex(groups());

  const batches = batchesFor(index, 1);
  const body = batches.get('3.1')!;
  const geometry = body.geometry as THREE.InstancedBufferGeometry & {
    _maxInstanceCount?: number;
  };
  writeAllConeSlots(oneGroup, batches, penetrationOf);

  assert.equal(body.count, 2);
  const firstMatrix = matrixOf(body, 0);
  const firstColor = colorOf(body, 0);

  // What three caches on the first bind: the attribute capacity it saw then.
  geometry._maxInstanceCount = body.capacity;

  writeAllConeSlots(index, batches, penetrationOf);
  assert.equal(body.count, 3);
  assert.ok(body.capacity >= 3);
  assert.equal(geometry._maxInstanceCount, undefined, 'the draw is not clamped to the old capacity');
  assert.equal(body.geometry, geometry, 'growth replaces attributes, never the geometry');
  assert.deepEqual(matrixOf(body, 0), firstMatrix);
  assert.deepEqual(colorOf(body, 0), firstColor);

  // A shrink inside the current capacity rebinds nothing, so the cached cap stays.
  geometry._maxInstanceCount = body.capacity;
  writeAllConeSlots(oneGroup, batches, penetrationOf);
  assert.equal(body.count, 2);
  assert.equal(geometry._maxInstanceCount, body.capacity);
});

test('a batch the index no longer names is emptied, never left drawing the old layout', () => {
  const index = buildConeSlotIndex(groups());
  const batches = batchesFor(index);
  batches.set('0.9', batchFor());
  writeAllConeSlots(index, batches, penetrationOf);
  assert.equal(batches.get('0.9')!.count, 0, 'a stale bucket is emptied by the same call');

  const diskBatch = batches.get(CONE_DISK_BATCH_KEY)!;
  assert.equal(diskBatch.count, 2);

  // An index with no disk-profile cone at all empties the nib batch; the body
  // bucket and the tips stay.
  const spheresOnly = buildConeSlotIndex([
    {
      color: '#a1a1a1',
      cones: [cone('sphere-only', 'sup-1', at(0, 0, 0), at(0, 0, 1), sphereProfile())],
    },
  ]);
  writeAllConeSlots(spheresOnly, batches, penetrationOf);
  assert.equal(diskBatch.count, 0);
  assert.equal(batches.get('3.1')!.count, 1);
  assert.equal(batches.get(CONE_TIP_BATCH_KEY)!.count, 1);
});

test('a batch the index does not name is a loud failure, not a silent skip', () => {
  const index = buildConeSlotIndex(groups());
  assert.throws(
    () => writeAllConeSlots(index, new Map(), penetrationOf),
    /no batch for "3\.1"/,
  );

  const batches = batchesFor(index);
  batches.delete(CONE_TIP_BATCH_KEY);
  assert.throws(
    () => writeAllConeSlots(index, batches, penetrationOf),
    /no batch for "tip"/,
  );

  const noDiskBatches = batchesFor(index);
  noDiskBatches.delete(CONE_DISK_BATCH_KEY);
  assert.throws(
    () => writeAllConeSlots(index, noDiskBatches, penetrationOf),
    /no batch for "disk"/,
  );
});

test('an empty index is a no-op and writes into no batch', () => {
  const empty = buildConeSlotIndex([]);
  const batches = new Map<string, SupportInstanceBatch>();

  writeAllConeSlots(empty, batches, penetrationOf);
  assert.equal(batches.size, 0);
});

test('the per-primitive writers are public, so a drag can move one cone', () => {
  const index = buildConeSlotIndex(groups());
  const batches = batchesFor(index);
  writeAllConeSlots(index, batches, penetrationOf);

  const record = index.slots[0];
  const slot = { ...record.slot, pos: at(5, 5, 5) };

  writeConeBodyMatrix(batches.get('3.1')!, record.bodyInstance, slot);
  writeConeTipMatrix(batches.get(CONE_TIP_BATCH_KEY)!, record.tipInstance, slot);
  writeConeDiskMatrix(
    batches.get(CONE_DISK_BATCH_KEY)!,
    record.diskInstance as number,
    slot,
    penetrationOf(slot),
  );

  assertPoint(
    new THREE.Vector3().setFromMatrixPosition(
      matrixAt(batches.get('3.1')!, record.bodyInstance),
    ),
    {
      x: 5,
      y: 5,
      z: 5 - slot.diskThickness - slot.lengthMm / 2,
    },
  );
  assertPoint(
    new THREE.Vector3().setFromMatrixPosition(
      matrixAt(batches.get(CONE_DISK_BATCH_KEY)!, record.diskInstance as number),
    ),
    { x: 5, y: 5, z: 5 - slot.diskThickness / 2 + 0.25 },
  );
});
