import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import type { InstancedJoint } from '../../SupportPrimitives/Joint/InstancedJointGroup';
import { INSTANCE_TYPE_JOINT, packInstanceFlags } from '../instanceFlags';
import { buildJointSlotIndex } from '../jointSlots';
import type { JointSlotIndex } from '../jointSlots';
import {
  computeJointSlotStates,
  diffJointSlotStates,
  jointSlotRadius,
  resizeJointBatch,
  writeAllJointSlots,
  writeJointSlotMatrix,
} from '../jointSlotBatch';
import {
  JOINT_DIM_COLOR,
  JOINT_HOVER_DIAMETER_SCALE,
  JOINT_HOVER_EMISSIVE_INTENSITY,
  JOINT_MARQUEE_COLOR,
  jointVisualScale,
  resolveJointVisualColor,
} from '../instancedPalette';
import { SupportInstanceBatch } from '../supportInstanceBatch';

function joint(id: string, supportId: string, x: number, y: number, z: number, diameter: number): InstancedJoint {
  return { id, supportId, pos: { x, y, z }, diameter };
}

/** Two supports in one colour group, one in another, plus a detached joint. */
function slotIndex(): JointSlotIndex {
  return buildJointSlotIndex([
    {
      color: '#888888',
      joints: [
        joint('a:1', 'a', 1, 2, 3, 1.4),
        joint('a:2', 'a', 4, 5, 6, 0.9),
        joint('b:1', 'b', 7, 8, 9, 2.2),
      ],
    },
    {
      color: JOINT_MARQUEE_COLOR,
      joints: [joint('c:1', 'c', 10, 11, 12, 1)],
    },
  ]);
}

/** The instance attributes are Float32: compare through their precision. */
function closeTo(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) < 1e-5;
}

function batchFor(capacity: number): SupportInstanceBatch {
  return new SupportInstanceBatch(new THREE.BoxGeometry(1, 1, 1), capacity);
}

function matrixOf(batch: SupportInstanceBatch, index: number): number[] {
  const attribute = batch.geometry.getAttribute('instanceMatrix') as THREE.InstancedBufferAttribute;
  return Array.from((attribute.array as Float32Array).subarray(index * 16, index * 16 + 16));
}

function colorOf(batch: SupportInstanceBatch, index: number): THREE.Color {
  const attribute = batch.geometry.getAttribute('color') as THREE.InstancedBufferAttribute;
  const array = attribute.array as Float32Array;
  return new THREE.Color(array[index * 3], array[index * 3 + 1], array[index * 3 + 2]);
}

test('jointSlotRadius matches the legacy InstancedJointGroup formula, clamp included', () => {
  for (const diameter of [0.001, 0.002, 0.05, 0.325, 1.4, 9]) {
    assert.equal(jointSlotRadius(diameter), Math.max(0.001, diameter * 0.5));
  }
  // Below the clamp the legacy batch drew a 0.001 mm radius, not half of it.
  assert.equal(jointSlotRadius(0.0005), 0.001);
});

test('jointVisualScale lifts only the highlighted states', () => {
  assert.equal(jointVisualScale('base'), 1);
  assert.equal(jointVisualScale('hover'), JOINT_HOVER_DIAMETER_SCALE);
  assert.equal(jointVisualScale('marquee'), JOINT_HOVER_DIAMETER_SCALE);
});

test('resolveJointVisualColor keeps the base colour and lifts highlighted states', () => {
  const base = resolveJointVisualColor(JOINT_DIM_COLOR, 'base', new THREE.Color());
  assert.equal(base.getHexString(), '666666');

  const hover = resolveJointVisualColor(JOINT_DIM_COLOR, 'hover', new THREE.Color());
  assert.ok(Math.abs(hover.r - Math.min(1, base.r + JOINT_HOVER_EMISSIVE_INTENSITY)) < 1e-9);
  assert.ok(Math.abs(hover.g - Math.min(1, base.g + JOINT_HOVER_EMISSIVE_INTENSITY)) < 1e-9);
  assert.ok(hover.r > base.r);

  const marquee = resolveJointVisualColor(JOINT_DIM_COLOR, 'marquee', new THREE.Color());
  const marqueeBase = new THREE.Color(JOINT_MARQUEE_COLOR);
  assert.ok(Math.abs(marquee.r - Math.min(1, marqueeBase.r + JOINT_HOVER_EMISSIVE_INTENSITY)) < 1e-9);
});

test('computeJointSlotStates maps a hovered and a marquee support onto their slots', () => {
  const index = slotIndex();

  const hover = computeJointSlotStates(index, 'a', []);
  assert.deepEqual([...hover.entries()], [[0, 'hover'], [1, 'hover']]);

  const marquee = computeJointSlotStates(index, 'a', ['b']);
  assert.deepEqual([...marquee.entries()], [[0, 'hover'], [1, 'hover'], [2, 'marquee']]);

  // Marquee wins, as the overlay drew over the hover batch.
  const both = computeJointSlotStates(index, 'a', ['a']);
  assert.deepEqual([...both.entries()], [[0, 'marquee'], [1, 'marquee']]);

  assert.equal(computeJointSlotStates(index, null, []).size, 0);
  assert.equal(computeJointSlotStates(index, 'missing', ['missing']).size, 0);
});

test('diffJointSlotStates reports only changed slots, ascending, ending as base', () => {
  const changes = diffJointSlotStates(
    new Map<number, 'hover' | 'marquee'>([[0, 'hover'], [2, 'marquee']]),
    new Map<number, 'hover' | 'marquee'>([[0, 'hover'], [2, 'hover'], [1, 'marquee']]),
  );
  assert.deepEqual(changes, [
    { index: 1, state: 'marquee' },
    { index: 2, state: 'hover' },
  ]);

  assert.deepEqual(
    diffJointSlotStates(new Map([[4, 'hover' as const]]), new Map()),
    [{ index: 4, state: 'base' }],
  );
  assert.deepEqual(diffJointSlotStates(new Map(), new Map()), []);
});

test('writeAllJointSlots writes one instance per slot with its own radius and colour', () => {
  const index = slotIndex();
  const batch = batchFor(1);

  writeAllJointSlots(batch, index);

  assert.equal(batch.count, index.slots.length);
  assert.equal(batch.geometry.instanceCount, index.slots.length);

  // The data word and ratio are constant per joint slot, so they are written by
  // the append that creates the slot and never re-uploaded.
  const dataAttribute = batch.geometry.getAttribute('iData') as THREE.InstancedBufferAttribute;
  const data = dataAttribute.array as Uint32Array;
  const ratioAttribute = batch.geometry.getAttribute('iRatio') as THREE.InstancedBufferAttribute;
  const ratio = ratioAttribute.array as Float32Array;
  const expectedData = packInstanceFlags({ visible: true, type: INSTANCE_TYPE_JOINT });
  for (let slot = 0; slot < index.slots.length; slot += 1) {
    assert.equal(data[slot], expectedData);
    assert.equal(ratio[slot], 1);
  }

  for (let slot = 0; slot < index.slots.length; slot += 1) {
    const slotRecord = index.slots[slot];
    const radius = jointSlotRadius(slotRecord.diameter);
    const matrix = matrixOf(batch, slot);
    assert.deepEqual(matrix.slice(12, 15), [
      slotRecord.pos.x,
      slotRecord.pos.y,
      slotRecord.pos.z,
    ]);
    assert.ok(closeTo(matrix[0], radius));
    assert.ok(closeTo(matrix[5], radius));
    assert.ok(closeTo(matrix[10], radius));

    // The instance colour is the group colour in linear space, which is what a
    // vertex colour attribute is read as.
    const expected = new THREE.Color(index.colorBySlot[slot]);
    const actual = colorOf(batch, slot);
    for (const channel of ['r', 'g', 'b'] as const) {
      assert.ok(Math.abs(actual[channel] - expected[channel]) < 1e-6);
    }
  }
});

test('count changes reallocate attributes but never the geometry or the batch', () => {
  const index = slotIndex();
  const batch = batchFor(1);
  const geometry = batch.geometry;

  writeAllJointSlots(batch, index);
  assert.equal(batch.count, 4);
  assert.ok(batch.capacity >= 4);

  resizeJointBatch(batch, 2);
  assert.equal(batch.count, 2);
  assert.equal(batch.geometry.instanceCount, 2);
  assert.equal(batch.geometry, geometry);

  writeAllJointSlots(batch, index);
  assert.equal(batch.count, 4);
  assert.equal(batch.geometry, geometry);

  // Growth replaces attribute objects on the stable geometry.
  const grown = batchFor(1);
  const grownGeometry = grown.geometry;
  const before = grown.geometry.getAttribute('instanceMatrix');
  writeAllJointSlots(grown, index);
  assert.equal(grown.geometry, grownGeometry);
  assert.notEqual(grown.geometry.getAttribute('instanceMatrix'), before);
});

test('growth drops three’s cached instance cap, shrink keeps it', () => {
  const index = slotIndex();
  const batch = batchFor(1);
  const geometry = batch.geometry as THREE.InstancedBufferGeometry & { _maxInstanceCount?: number };

  // What three caches on the first bind: the attribute capacity it saw then.
  geometry._maxInstanceCount = batch.capacity;
  writeAllJointSlots(batch, index);
  assert.equal(geometry._maxInstanceCount, undefined);

  // A shrink inside the current capacity rebinds nothing.
  writeAllJointSlots(batch, index);
  geometry._maxInstanceCount = batch.capacity;
  resizeJointBatch(batch, 2);
  assert.equal(geometry._maxInstanceCount, batch.capacity);
});

test('writeJointSlotMatrix places and scales one slot without touching the others', () => {
  const index = slotIndex();
  const batch = batchFor(4);
  writeAllJointSlots(batch, index);

  const untouched = matrixOf(batch, 1);
  writeJointSlotMatrix(batch, 0, { x: -3, y: -4, z: -5 }, 2, JOINT_HOVER_DIAMETER_SCALE);

  const matrix = matrixOf(batch, 0);
  assert.deepEqual(matrix.slice(12, 15), [-3, -4, -5]);
  assert.ok(closeTo(matrix[0], jointSlotRadius(2) * JOINT_HOVER_DIAMETER_SCALE));
  assert.deepEqual(matrixOf(batch, 1), untouched);
});

test('slots are fully resolved records: the batch never re-applies a drop offset', () => {
  const index = slotIndex();
  const batch = batchFor(4);
  writeAllJointSlots(batch, index);

  // The producer put the drop offset (and the diameter blend) into these
  // positions and diameters; the written transform is exactly that value.
  const matrix = matrixOf(batch, 2);
  assert.deepEqual(matrix.slice(12, 15), [7, 8, 9]);
  assert.ok(closeTo(matrix[0], jointSlotRadius(2.2)));
});
