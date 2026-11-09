import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import { HIDDEN_INSTANCE_MATRIX } from '../../SupportPrimitives/hiddenInstanceMatrix';
import {
  INSTANCE_SEG_KIND_STRAIGHT,
  INSTANCE_SEG_KIND_TAPERED,
  INSTANCE_TYPE_SHAFT,
  packInstanceFlags,
  readSegKind,
  readType,
} from '../instanceFlags';
import { JOINT_HOVER_EMISSIVE_INTENSITY, JOINT_MARQUEE_COLOR } from '../instancedPalette';
import { buildShaftSlotIndex, type ShaftSlotGroup, type ShaftSlotIndex } from '../shaftSlots';
import {
  SHAFT_HOVER_DIAMETER_SCALE,
  SHAFT_STRAIGHT_BATCH_KEY,
  SHAFT_STRAIGHT_SLOT_DATA,
  SHAFT_TAPERED_SLOT_DATA,
  applyShaftSlotStateChanges,
  computeShaftSlotStates,
  diffShaftSlotStates,
  shaftVisualScale,
  writeAllShaftSlots,
  writeShaftSlot,
  writeShaftSlotMatrix,
} from '../shaftSlotBatch';
import { SupportInstanceBatch } from '../supportInstanceBatch';

const at = (x: number, y: number, z: number) => ({ x, y, z });

/**
 * Two colours, two straight shafts along different axes, and tapered shafts in
 * two ratio buckets (0.72 quantizes into 0.7's bucket).
 */
function groups(): ShaftSlotGroup[] {
  return [
    {
      color: '#888888',
      shafts: [
        { id: 'st-1', supportId: 'sup-1', start: at(1, 2, 3), end: at(1, 2, 13), diameter: 1.4 },
        { id: 'tp-1', supportId: 'sup-1', start: at(0, 0, 0), end: at(0, 4, 0), diameter: 1, diameterEnd: 0.7 },
      ],
    },
    {
      color: '#80fffd',
      shafts: [
        { id: 'st-2', supportId: 'sup-2', start: at(0, 0, 0), end: at(2, 0, 0), diameter: 1 },
        { id: 'tp-2', supportId: 'sup-2', start: at(0, 0, 2), end: at(0, 4, 2), diameter: 1, diameterEnd: 0.72 },
        { id: 'tp-3', supportId: 'sup-2', start: at(0, 0, 4), end: at(0, 4, 4), diameter: 2, diameterEnd: 1 },
      ],
    },
  ];
}

function batchFor(capacity = 1): SupportInstanceBatch {
  return new SupportInstanceBatch(new THREE.BoxGeometry(1, 1, 1), capacity);
}

/** One batch per shape the index needs, as the component creates them. */
function batchesFor(
  index: ShaftSlotIndex,
  capacity = 1,
): Map<string, SupportInstanceBatch> {
  const batches = new Map<string, SupportInstanceBatch>();
  if (index.straight.length > 0) batches.set(SHAFT_STRAIGHT_BATCH_KEY, batchFor(capacity));
  for (const bucket of index.tapered) batches.set(bucket.key, batchFor(capacity));
  return batches;
}

function attribute<T extends THREE.BufferAttribute>(batch: SupportInstanceBatch, name: string): T {
  return batch.geometry.getAttribute(name) as T;
}

function matrixOf(batch: SupportInstanceBatch, instance: number): number[] {
  const array = attribute<THREE.InstancedBufferAttribute>(batch, 'instanceMatrix').array as Float32Array;
  return Array.from(array.subarray(instance * 16, instance * 16 + 16));
}

function matrixAt(batch: SupportInstanceBatch, instance: number): THREE.Matrix4 {
  return new THREE.Matrix4().fromArray(matrixOf(batch, instance));
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

/** The instance's radius, read off the matrix's first basis column. */
function radialScale(batch: SupportInstanceBatch, instance: number): number {
  return new THREE.Vector3().setFromMatrixColumn(matrixAt(batch, instance), 0).length();
}

function lengthScale(batch: SupportInstanceBatch, instance: number): number {
  return new THREE.Vector3().setFromMatrixColumn(matrixAt(batch, instance), 1).length();
}

function closeTo(actual: number, expected: number, epsilon = 1e-5): boolean {
  return Math.abs(actual - expected) < epsilon;
}

function assertPoint(actual: THREE.Vector3, expected: { x: number; y: number; z: number }): void {
  assert.ok(closeTo(actual.x, expected.x), `x ${actual.x} != ${expected.x}`);
  assert.ok(closeTo(actual.y, expected.y), `y ${actual.y} != ${expected.y}`);
  assert.ok(closeTo(actual.z, expected.z), `z ${actual.z} != ${expected.z}`);
}

test('writeAllShaftSlots puts every record in the batch that draws it, in producer order', () => {
  const index = buildShaftSlotIndex(groups());
  const batches = batchesFor(index);

  writeAllShaftSlots(index, batches);

  const straight = batches.get(SHAFT_STRAIGHT_BATCH_KEY)!;
  assert.equal(straight.count, 2);
  assert.equal(straight.geometry.instanceCount, 2);

  assert.deepEqual(
    index.tapered.map((bucket) => bucket.key),
    ['0.7', '0.5'],
  );
  assert.equal(batches.get('0.7')!.count, 2);
  assert.equal(batches.get('0.5')!.count, 1);

  // Straight slots are dense, so `record.instance` is the drawn instance: the
  // batch at instance i is the producer's i-th straight shaft.
  for (const record of index.straight) {
    const matrix = matrixAt(straight, record.instance);
    assertPoint(new THREE.Vector3().setFromMatrixPosition(matrix), {
      x: (record.slot.start.x + record.slot.end.x) / 2,
      y: (record.slot.start.y + record.slot.end.y) / 2,
      z: (record.slot.start.z + record.slot.end.z) / 2,
    });
  }
});

test('a slot transform spans start to end, from the template’s −y to its +y', () => {
  const index = buildShaftSlotIndex(groups());
  const batches = batchesFor(index);
  writeAllShaftSlots(index, batches);
  const straight = batches.get(SHAFT_STRAIGHT_BATCH_KEY)!;

  for (const record of index.straight) {
    const matrix = matrixAt(straight, record.instance);
    // The unit cylinder is 1 tall, so the template's ends are at y = ±0.5.
    assertPoint(new THREE.Vector3(0, -0.5, 0).applyMatrix4(matrix), record.slot.start);
    assertPoint(new THREE.Vector3(0, 0.5, 0).applyMatrix4(matrix), record.slot.end);

    // The two radial axes are the drawn diameter; the axis along the segment is
    // its length, so a hover lift cannot lengthen a shaft.
    assert.ok(closeTo(radialScale(straight, record.instance), record.slot.diameter));
    const dx = record.slot.end.x - record.slot.start.x;
    const dy = record.slot.end.y - record.slot.start.y;
    const dz = record.slot.end.z - record.slot.start.z;
    assert.ok(closeTo(lengthScale(straight, record.instance), Math.sqrt(dx * dx + dy * dy + dz * dz)));
  }
});

test('a tapered slot’s matrix is the same composition; the bucket’s cone carries the taper', () => {
  const index = buildShaftSlotIndex(groups());
  const batches = batchesFor(index);
  writeAllShaftSlots(index, batches);

  const widened = index.tapered.find((bucket) => bucket.key === '0.5')!;
  const batch = batches.get(widened.key)!;
  const record = widened.slots[0];
  const matrix = matrixAt(batch, record.instance);

  assertPoint(new THREE.Vector3(0, -0.5, 0).applyMatrix4(matrix), record.slot.start);
  assertPoint(new THREE.Vector3(0, 0.5, 0).applyMatrix4(matrix), record.slot.end);
  assert.ok(closeTo(radialScale(batch, record.instance), record.slot.diameter));
});

test('a shaft below the drawn length keeps its slot and draws nothing', () => {
  const batch = batchFor(1);
  batch.resizeTo(1, SHAFT_STRAIGHT_SLOT_DATA, 1);

  writeShaftSlotMatrix(batch, 0, { start: at(0, 0, 0), end: at(0, 0, 0.0005), diameter: 1 });

  assert.deepEqual(matrixOf(batch, 0), HIDDEN_INSTANCE_MATRIX.toArray());
});

test('writeShaftSlot writes the bucket ratio, the straight ratio and the segment kind', () => {
  const index = buildShaftSlotIndex(groups());
  const batches = batchesFor(index);
  writeAllShaftSlots(index, batches);

  const straight = batches.get(SHAFT_STRAIGHT_BATCH_KEY)!;
  for (const record of index.straight) {
    assert.equal(ratioOf(straight, record.instance), 1);
    assert.equal(dataOf(straight, record.instance), SHAFT_STRAIGHT_SLOT_DATA);
  }

  for (const bucket of index.tapered) {
    const batch = batches.get(bucket.key)!;
    for (const record of bucket.slots) {
      // The writer writes the slot's own ratio, which is the bucket's: the cone
      // template and the instance agree, so no shaft is drawn at two widths.
      assert.ok(closeTo(ratioOf(batch, record.instance), bucket.ratio, 1e-6));
      assert.equal(dataOf(batch, record.instance), SHAFT_TAPERED_SLOT_DATA);
    }
  }

  const straightWord = packInstanceFlags({
    visible: true,
    type: INSTANCE_TYPE_SHAFT,
    segKind: INSTANCE_SEG_KIND_STRAIGHT,
  });
  const taperedWord = packInstanceFlags({
    visible: true,
    type: INSTANCE_TYPE_SHAFT,
    segKind: INSTANCE_SEG_KIND_TAPERED,
  });
  assert.equal(SHAFT_STRAIGHT_SLOT_DATA, straightWord);
  assert.equal(SHAFT_TAPERED_SLOT_DATA, taperedWord);
  assert.equal(readType(straightWord), INSTANCE_TYPE_SHAFT);
  assert.equal(readSegKind(straightWord), INSTANCE_SEG_KIND_STRAIGHT);
  assert.equal(readSegKind(taperedWord), INSTANCE_SEG_KIND_TAPERED);
});

test('base state is the produced group colour, in the space a vertex colour is read in', () => {
  const index = buildShaftSlotIndex(groups());
  const batches = batchesFor(index);
  writeAllShaftSlots(index, batches);

  for (const record of index.slots) {
    const batch = batches.get(record.bucketKey ?? SHAFT_STRAIGHT_BATCH_KEY)!;
    const expected = new THREE.Color(record.color);
    const actual = colorOf(batch, record.instance);
    assert.ok(closeTo(actual.r, expected.r, 1e-6));
    assert.ok(closeTo(actual.g, expected.g, 1e-6));
    assert.ok(closeTo(actual.b, expected.b, 1e-6));
  }
});

test('hover widens the shaft 1.02 and lifts its colour by the overlay’s emissive', () => {
  assert.equal(shaftVisualScale('base'), 1);
  assert.equal(shaftVisualScale('hover'), SHAFT_HOVER_DIAMETER_SCALE);
  assert.equal(shaftVisualScale('marquee'), SHAFT_HOVER_DIAMETER_SCALE);

  const index = buildShaftSlotIndex(groups());
  const batches = batchesFor(index);
  writeAllShaftSlots(index, batches);

  const batch = batches.get(SHAFT_STRAIGHT_BATCH_KEY)!;
  const record = index.straight[0];
  const baseColor = colorOf(batch, record.instance);
  const length = lengthScale(batch, record.instance);

  writeShaftSlot(batch, index, record.id, 'hover');

  assert.ok(closeTo(radialScale(batch, record.instance), record.slot.diameter * 1.02));
  assert.ok(closeTo(lengthScale(batch, record.instance), length), 'the lift never stretches the shaft');
  assert.equal(ratioOf(batch, record.instance), 1);

  const hoverColor = colorOf(batch, record.instance);
  assert.ok(closeTo(hoverColor.r, Math.min(1, baseColor.r + JOINT_HOVER_EMISSIVE_INTENSITY), 1e-6));
  assert.ok(closeTo(hoverColor.g, Math.min(1, baseColor.g + JOINT_HOVER_EMISSIVE_INTENSITY), 1e-6));
  assert.ok(closeTo(hoverColor.b, Math.min(1, baseColor.b + JOINT_HOVER_EMISSIVE_INTENSITY), 1e-6));
});

test('marquee draws the bulk colour lifted, whatever colour the slot was produced in', () => {
  const index = buildShaftSlotIndex(groups());
  const batches = batchesFor(index);
  writeAllShaftSlots(index, batches);

  const batch = batches.get(SHAFT_STRAIGHT_BATCH_KEY)!;
  const record = index.straight[0];
  writeShaftSlot(batch, index, record.id, 'marquee');

  const expected = new THREE.Color(JOINT_MARQUEE_COLOR).addScalar(JOINT_HOVER_EMISSIVE_INTENSITY);
  const actual = colorOf(batch, record.instance);
  assert.ok(closeTo(actual.r, Math.min(1, expected.r), 1e-6));
  assert.ok(closeTo(actual.g, Math.min(1, expected.g), 1e-6));
  assert.ok(closeTo(actual.b, Math.min(1, expected.b), 1e-6));
});

test('computeShaftSlotStates lets marquee win over hover, over batch-drawn slots only', () => {
  const index = buildShaftSlotIndex(groups());

  const hover = computeShaftSlotStates(index, 'sup-1', []);
  assert.deepEqual([...hover.entries()], [[0, 'hover'], [1, 'hover']]);

  const both = computeShaftSlotStates(index, 'sup-1', ['sup-2']);
  assert.deepEqual([...both.entries()], [
    [0, 'hover'],
    [1, 'hover'],
    [2, 'marquee'],
    [3, 'marquee'],
    [4, 'marquee'],
  ]);

  const marqueeWins = computeShaftSlotStates(index, 'sup-1', ['sup-1']);
  assert.deepEqual([...marqueeWins.entries()], [[0, 'marquee'], [1, 'marquee']]);

  assert.equal(computeShaftSlotStates(index, null, []).size, 0);
  assert.equal(computeShaftSlotStates(index, 'missing', ['missing']).size, 0);
});

test('diffShaftSlotStates reports only the slots that changed, ascending, ending as base', () => {
  const changes = diffShaftSlotStates(
    new Map<number, 'hover' | 'marquee'>([[0, 'hover'], [3, 'marquee']]),
    new Map<number, 'hover' | 'marquee'>([[0, 'hover'], [3, 'hover'], [2, 'marquee']]),
  );
  assert.deepEqual(changes, [
    { id: 2, state: 'marquee' },
    { id: 3, state: 'hover' },
  ]);

  assert.deepEqual(diffShaftSlotStates(new Map([[4, 'hover' as const]]), new Map()), [
    { id: 4, state: 'base' },
  ]);
  assert.deepEqual(diffShaftSlotStates(new Map(), new Map()), []);
});

test('applying a diff writes the changed slots and leaves the rest alone', () => {
  const index = buildShaftSlotIndex(groups());
  const batches = batchesFor(index);
  writeAllShaftSlots(index, batches);

  const straight = batches.get(SHAFT_STRAIGHT_BATCH_KEY)!;
  const untouched = { matrix: matrixOf(straight, 1), color: colorOf(straight, 1) };

  const hovered = computeShaftSlotStates(index, 'sup-1', []);
  applyShaftSlotStateChanges(index, diffShaftSlotStates(new Map(), hovered), batches);

  assert.ok(closeTo(radialScale(straight, 0), 1.4 * 1.02));
  assert.deepEqual(matrixOf(straight, 1), untouched.matrix);
  assert.deepEqual(colorOf(straight, 1), untouched.color);

  // Hover ends: the changed slots go back to base, not to their lifted state.
  applyShaftSlotStateChanges(
    index,
    diffShaftSlotStates(hovered, computeShaftSlotStates(index, null, [])),
    batches,
  );
  assert.ok(closeTo(radialScale(straight, 0), 1.4));
});

test('growth preserves the live instances and drops three’s cached instance cap', () => {
  const oneGroup = buildShaftSlotIndex([groups()[0]]);
  const index = buildShaftSlotIndex(groups());

  const batches = batchesFor(index, 1);
  const batch = batches.get(SHAFT_STRAIGHT_BATCH_KEY)!;
  const geometry = batch.geometry as THREE.InstancedBufferGeometry & { _maxInstanceCount?: number };
  writeAllShaftSlots(oneGroup, batches);

  assert.equal(batch.count, 1);
  const firstMatrix = matrixOf(batch, 0);
  const firstColor = colorOf(batch, 0);

  // What three caches on the first bind: the attribute capacity it saw then.
  geometry._maxInstanceCount = batch.capacity;

  writeAllShaftSlots(index, batches);
  assert.equal(batch.count, 2);
  assert.ok(batch.capacity >= 2);
  assert.equal(geometry._maxInstanceCount, undefined, 'the draw is not clamped to the old capacity');
  assert.equal(batch.geometry, geometry, 'growth replaces attributes, never the geometry');
  assert.deepEqual(matrixOf(batch, 0), firstMatrix);
  assert.deepEqual(colorOf(batch, 0), firstColor);

  // A shrink inside the current capacity rebinds nothing, so the cached cap stays.
  geometry._maxInstanceCount = batch.capacity;
  writeAllShaftSlots(oneGroup, batches);
  assert.equal(batch.count, 1);
  assert.equal(geometry._maxInstanceCount, batch.capacity);
});

test('a batch the index no longer names is emptied, never left drawing the old layout', () => {
  const index = buildShaftSlotIndex(groups());
  const batches = batchesFor(index);
  writeAllShaftSlots(index, batches);
  const bucketBatch = batches.get('0.5')!;
  assert.equal(bucketBatch.count, 1);

  // Only the first group's shafts remain: one straight, one tapered in 0.7.
  const smaller = buildShaftSlotIndex([groups()[0]]);
  writeAllShaftSlots(smaller, batches);

  assert.equal(batches.get('0.5')!.count, 0);
  assert.equal(batches.get('0.7')!.count, 1);
  assert.equal(batches.get(SHAFT_STRAIGHT_BATCH_KEY)!.count, 1);

  // A layout with no straight shaft at all empties the straight batch too.
  const taperedOnly = buildShaftSlotIndex([
    {
      color: '#888888',
      shafts: [
        { id: 'tp-only', supportId: 'sup-1', start: at(0, 0, 0), end: at(0, 4, 0), diameter: 1, diameterEnd: 0.5 },
      ],
    },
  ]);
  writeAllShaftSlots(taperedOnly, batches);
  assert.equal(batches.get(SHAFT_STRAIGHT_BATCH_KEY)!.count, 0);
  assert.equal(batches.get('0.5')!.count, 1);
});

test('a batch the index does not name is a loud failure, not a silent skip', () => {
  const index = buildShaftSlotIndex(groups());
  assert.throws(() => writeAllShaftSlots(index, new Map()), /no batch for "straight"/);

  const batches = batchesFor(index);
  const full = batches.get('0.7')!;
  batches.delete('0.7');
  assert.throws(() => writeAllShaftSlots(index, batches), /no batch for "0\.7"/);
  assert.equal(full.count, 0, 'the untouched batch was never resized');
});
