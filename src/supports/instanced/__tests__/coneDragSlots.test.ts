import assert from 'node:assert/strict';
import test from 'node:test';

import type { ContactCone } from '../../SupportPrimitives/ContactCone/types';
import {
  buildConeDragSlotMap,
  isConeOnlyTipDrag,
  type BuildConeDragSlotMapOptions,
} from '../coneDragSlots';

const at = (x: number, y: number, z: number) => ({ x, y, z });

function diskCone(id: string, pos = at(0, 0, 30)): ContactCone {
  return {
    id,
    pos,
    normal: at(0, 0, -1),
    surfaceNormal: at(0, 0, -1),
    socketJointId: 'j-2',
    profile: {
      type: 'disk',
      contactDiameterMm: 0.4,
      bodyDiameterMm: 1.2,
      lengthMm: 3,
      penetrationMm: 0.05,
      diskThicknessMm: 0.1,
      maxStandoffMm: 0.25,
      standoffAngleThreshold: Math.PI / 4,
    },
  };
}

function sphereCone(id: string, pos = at(0, 0, 12)): ContactCone {
  return {
    id,
    pos,
    normal: at(0, 0, 1),
    surfaceNormal: at(0, 0, 1),
    socketJointId: 'j-1',
    profile: {
      type: 'sphere',
      contactDiameterMm: 0.4,
      bodyDiameterMm: 1.2,
      lengthMm: 2,
      penetrationMm: 0,
      sphereRadiusRatio: 1.5,
    },
  };
}

function options(overrides: Partial<BuildConeDragSlotMapOptions> = {}): BuildConeDragSlotMapOptions {
  return {
    typeId: 'trunk',
    field: 'contactCone',
    cone: diskCone('cone-1'),
    supportId: 'trunk-1',
    modelId: 'model-1',
    ...overrides,
  };
}

test('the predicate accepts exactly the types that declare a cone-only tip drag', () => {
  // Cone-only: one declared cone, nothing else in the entity moves.
  assert.equal(isConeOnlyTipDrag('trunk', 'contactCone', diskCone('c')), true);
  assert.equal(isConeOnlyTipDrag('leaf', 'contactCone', diskCone('c')), true);
  assert.equal(isConeOnlyTipDrag('stump', 'contactCone', diskCone('c')), true);
  assert.equal(isConeOnlyTipDrag('stick', 'contactConeA', diskCone('a')), true);
  assert.equal(isConeOnlyTipDrag('stick', 'contactConeB', sphereCone('b')), true);
});

test('the predicate refuses the types that rebuild geometry around the cone', () => {
  // A branch re-searches its socket and rebuilds its shaft.
  assert.equal(isConeOnlyTipDrag('branch', 'contactCone', diskCone('c')), false);
  // A twig moves its disk-end joint and re-aims both disks.
  assert.equal(isConeOnlyTipDrag('twig', 'contactDiskA', diskCone('a')), false);
  assert.equal(isConeOnlyTipDrag('twig', 'contactDiskB', diskCone('b')), false);
  // No declared cone: a brace has no contacts, a kickstand has none of its own.
  assert.equal(isConeOnlyTipDrag('brace', 'contactCone', diskCone('c')), false);
  assert.equal(isConeOnlyTipDrag('kickstand', 'contactCone', diskCone('c')), false);
});

test('the predicate gates on a DECLARED cone field, not on a field that holds one', () => {
  // A trunk declares only `contactCone`.
  assert.equal(isConeOnlyTipDrag('trunk', 'contactConeB', diskCone('b')), false);
  assert.equal(isConeOnlyTipDrag('trunk', 'rootPos', diskCone('b')), false);
  // A stick declares both fields; a field name it does not declare is refused.
  assert.equal(isConeOnlyTipDrag('stick', 'contactCone', diskCone('c')), false);
  // An empty field or a missing cone is never a gesture.
  assert.equal(isConeOnlyTipDrag('trunk', '', diskCone('c')), false);
  assert.equal(isConeOnlyTipDrag('trunk', 'contactCone', null), false);
  assert.equal(isConeOnlyTipDrag(null, 'contactCone', diskCone('c')), false);
});

test('a disk cone is one body, one tip and one nib in its ratio bucket', () => {
  const map = buildConeDragSlotMap(options());
  assert.ok(map);

  assert.equal(map.typeId, 'trunk');
  assert.equal(map.supportId, 'trunk-1');
  assert.equal(map.modelId, 'model-1');
  assert.equal(map.field, 'contactCone');
  assert.equal(map.coneId, 'cone-1');
  assert.equal(map.cones.length, 1);
  assert.equal(map.counts.cones, 1);
  assert.equal(map.counts.coneNibs, 1);

  const [slot] = map.cones;
  // bodyDiameter / contactDiameter = 1.2 / 0.4 = 3.
  assert.equal(slot.bodyKey, '3');
  assert.equal(slot.kind, 'disk');
  assert.equal(slot.field, 'contactCone');
  assert.equal(slot.bodyInstance, 0);
  assert.equal(slot.tipInstance, 0);
  assert.equal(slot.diskInstance, 0);
  assert.equal(slot.isDisk, true);

  assert.equal(map.coneBodyBuckets.length, 1);
  assert.equal(map.coneBodyBuckets[0].key, '3');
  assert.equal(map.coneBodyBuckets[0].instances, 1);
  assert.ok(Math.abs(map.coneBodyBuckets[0].ratio - 3) < 1e-9);
});

test('a sphere cone draws no nib', () => {
  const map = buildConeDragSlotMap(options({
    typeId: 'stick',
    field: 'contactConeB',
    cone: sphereCone('cone-b'),
  }));
  assert.ok(map);

  const [slot] = map.cones;
  assert.equal(slot.kind, 'sphere');
  assert.equal(slot.isDisk, false);
  assert.equal(slot.diskInstance, undefined);
  assert.equal(map.counts.coneNibs, 0);
  // Both profiles of this fixture share the 3:1 body/contact ratio.
  assert.equal(slot.bodyKey, '3');
});

test('the map is the same for the committed cone and a moved preview', () => {
  const committed = buildConeDragSlotMap(options());
  const moved = buildConeDragSlotMap(options({
    cone: {
      ...diskCone('cone-1'),
      pos: at(4, 2, 28),
      normal: at(0.2, 0, -0.98),
      profile: { ...diskCone('cone-1').profile, lengthMm: 3.4 },
    },
  }));
  assert.ok(committed);
  assert.ok(moved);
  // Only values move during the gesture: the bucket, instances and nib are fixed.
  assert.deepEqual(moved.cones, committed.cones);
  assert.deepEqual(moved.coneBodyBuckets, committed.coneBodyBuckets);
  assert.deepEqual(moved.counts, committed.counts);
});

test('a degenerate normal refuses the gesture rather than writing a NaN axis', () => {
  const cone = { ...diskCone('cone-1'), normal: at(0, 0, 0) };
  assert.equal(buildConeDragSlotMap(options({ cone })), null);
});

test('a type that rebuilds geometry gets no slot map at all', () => {
  assert.equal(
    buildConeDragSlotMap(options({ typeId: 'branch' })),
    null,
  );
  assert.equal(buildConeDragSlotMap(options({ field: 'contactDiskA' })), null);
});

test('the model id is optional and left off when the entity has none', () => {
  const map = buildConeDragSlotMap({
    typeId: 'leaf',
    field: 'contactCone',
    cone: diskCone('cone-1'),
    supportId: 'leaf-1',
  });
  assert.ok(map);
  assert.equal(map.modelId, undefined);
  assert.equal(map.supportId, 'leaf-1');
});
