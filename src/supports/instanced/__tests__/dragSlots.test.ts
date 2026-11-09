import assert from 'node:assert/strict';
import test from 'node:test';

import type { ContactCone } from '../../SupportPrimitives/ContactCone/types';
import { JOINT_DIAMETER_OFFSET_MM } from '../../constants';
import { resolveSegmentEndpoints } from '../../SupportPrimitives/Knot/segmentEndpoints';
import type { Roots } from '../../types';
import {
  buildJointDragSlotMap,
  dragAdjacentSegmentIndices,
  dragKnotBallDiameter,
  isInstanceableJointDrag,
  type DragHostKnot,
  type JointDragBinding,
  type JointDragSlotEntity,
} from '../dragSlots';

const at = (x: number, y: number, z: number) => ({ x, y, z });

function joint(id: string, pos: { x: number; y: number; z: number }, diameter = 1.4) {
  return { id, pos, diameter };
}

function diskCone(id: string, pos: { x: number; y: number; z: number }, socketJointId: string): ContactCone {
  return {
    id,
    pos,
    normal: at(0, 0, -1),
    surfaceNormal: at(0, 0, -1),
    socketJointId,
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

function sphereCone(id: string, pos: { x: number; y: number; z: number }, socketJointId: string): ContactCone {
  return {
    id,
    pos,
    normal: at(0, 0, 1),
    surfaceNormal: at(0, 0, 1),
    socketJointId,
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

function root(): Roots {
  return {
    id: 'root-1',
    modelId: 'model-1',
    transform: { pos: at(0, 0, 0), rot: { x: 0, y: 0, z: 0, w: 1 } },
    diameter: 3,
    diskHeight: 0.5,
    coneHeight: 1,
  };
}

/**
 * A real trunk shape: two segments, `segmentsCarryBothJoints` false, so only the
 * top joints exist and the second segment chains off the first's top joint.
 */
function trunk(): JointDragSlotEntity {
  return {
    id: 'trunk-1',
    typeId: 'trunk',
    modelId: 'model-1',
    segments: [
      { id: 'seg-1', diameter: 1.5, topJoint: joint('j-1', at(0, 0, 10)) },
      { id: 'seg-2', diameter: 1.5, topJoint: joint('j-2', at(0, 0, 20)) },
    ],
    contactCone: diskCone('cone-1', at(0, 0, 30), 'j-2'),
  } as JointDragSlotEntity;
}

/** The same trunk one frame later: the lower joint has moved sideways. */
function trunkPreview(): JointDragSlotEntity {
  return {
    ...trunk(),
    segments: [
      { id: 'seg-1', diameter: 1.5, topJoint: joint('j-1', at(3, 0, 12)) },
      { id: 'seg-2', diameter: 1.5, topJoint: joint('j-2', at(0, 0, 20)) },
    ],
  } as JointDragSlotEntity;
}

/** A stick: one segment carrying both joints, two cone contacts. */
function stick(): JointDragSlotEntity {
  return {
    id: 'stick-1',
    typeId: 'stick',
    modelId: 'model-1',
    segments: [{
      id: 'seg-s',
      diameter: 1.2,
      bottomJoint: joint('js-a', at(0, 0, 5), 1.3),
      topJoint: joint('js-b', at(0, 0, 9), 1.3),
    }],
    contactConeA: diskCone('cone-a', at(0, 0, 0), 'js-a'),
    contactConeB: sphereCone('cone-b', at(0, 0, 14), 'js-b'),
  } as unknown as JointDragSlotEntity;
}

function kickstand(): JointDragSlotEntity {
  return {
    id: 'kickstand-1',
    typeId: 'kickstand',
    modelId: 'model-1',
    segments: [{ id: 'seg-k', diameter: 1.2, topJoint: joint('jk-1', at(2, 0, 6)) }],
    profile: {
      bodyDiameterMm: 1.2,
      terminalStartDiameterMm: 1.2,
      terminalEndDiameterMm: 0.6,
    },
  } as unknown as JointDragSlotEntity;
}

test('the instanceable predicate accepts the straight shafted types', () => {
  assert.equal(isInstanceableJointDrag('trunk', trunk()), true);
  assert.equal(isInstanceableJointDrag('branch', trunk()), true);
  assert.equal(isInstanceableJointDrag('kickstand', kickstand()), true);
  assert.equal(isInstanceableJointDrag('stick', stick()), true);
});

test('the instanceable predicate falls back for curves, disks and unshafted types', () => {
  const curved = {
    ...trunk(),
    segments: [
      {
        id: 'seg-1',
        diameter: 1.5,
        type: 'bezier' as const,
        controlPoint1: at(1, 0, 4),
        controlPoint2: at(2, 0, 8),
        startTangent: at(0, 0, 1),
        endTangent: at(0, 0, 1),
        tension: 0,
        bias: 0.5,
        resolution: 12,
        topJoint: joint('j-1', at(0, 0, 10)),
      },
    ],
  } as JointDragSlotEntity;
  assert.equal(isInstanceableJointDrag('trunk', curved), false);

  // A twig moves two contact disks, which are their own renderers.
  assert.equal(isInstanceableJointDrag('twig', stick()), false);
  // No segments of its own.
  assert.equal(isInstanceableJointDrag('leaf', trunk()), false);
  assert.equal(isInstanceableJointDrag('brace', trunk()), false);
  // Segments, but the instanced shaft path never draws a stump.
  assert.equal(isInstanceableJointDrag('stump', trunk()), false);
  assert.equal(isInstanceableJointDrag(null, trunk()), false);
  assert.equal(isInstanceableJointDrag('trunk', { segments: [] }), false);
});

test('a joint drag reaches the named segment and the one that chains from it', () => {
  const entity = trunk();
  assert.deepEqual(
    dragAdjacentSegmentIndices(
      { jointId: 'j-1', segmentIndex: 0, jointKey: 'topJoint' },
      entity.segments,
    ),
    [0, 1],
  );
  // A joint on the last segment has no successor.
  assert.deepEqual(
    dragAdjacentSegmentIndices(
      { jointId: 'j-2', segmentIndex: 1, jointKey: 'topJoint' },
      entity.segments,
    ),
    [1],
  );
  // A stick's single segment is the whole reach of either joint.
  assert.deepEqual(
    dragAdjacentSegmentIndices(
      { jointId: 'js-a', segmentIndex: 0, jointKey: 'bottomJoint' },
      stick().segments,
    ),
    [0],
  );
});

test('the slot map draws every dragged joint at the entity’s resolved diameter', () => {
  const entity = trunk();
  const map = buildJointDragSlotMap({
    entity,
    binding: { jointId: 'j-1', segmentIndex: 0, jointKey: 'topJoint' },
    hosts: { root: root() },
  });
  assert.ok(map);

  assert.deepEqual(map.joints.map((slot) => slot.id), ['j-1', 'j-2']);
  assert.deepEqual(map.joints.map((slot) => slot.instance), [0, 1]);
  // The entity's own diameter, not the scene's `- 0.075` blend.
  assert.equal(map.joints[0].diameter, 1.4);
  assert.deepEqual(map.joints[0].pos, at(0, 0, 10));

  assert.equal(map.supportId, 'trunk-1');
  assert.equal(map.jointId, 'j-1');
  assert.equal(map.counts.joints, 2);
});

test('the slot map covers the dragged segment and its neighbour, endpoints and all', () => {
  const entity = trunk();
  const hosts = { root: root() };
  const map = buildJointDragSlotMap({
    entity,
    binding: { jointId: 'j-1', segmentIndex: 0, jointKey: 'topJoint' },
    hosts,
  });
  assert.ok(map);

  assert.deepEqual(map.segments.map((slot) => slot.id), ['seg-1', 'seg-2']);
  assert.deepEqual(map.segments.map((slot) => slot.instance), [0, 1]);
  assert.deepEqual(map.shaftBuckets, [{ key: 'straight', ratio: 1, instances: 2 }]);

  for (const slot of map.segments) {
    const segment = entity.segments[slot.segmentIndex];
    const endpoints = resolveSegmentEndpoints(entity, segment, slot.segmentIndex, hosts);
    assert.ok(endpoints);
    // The same helper the detail renderers resolve through.
    assert.deepEqual(slot.start, endpoints.start);
    assert.deepEqual(slot.end, endpoints.end);
    assert.equal(slot.diameter, 1.5);
    assert.equal(slot.diameterEnd, 1.5);
  }
});

test('a declared taper becomes its own bucket with the quantized ratio', () => {
  const entity = kickstand();
  const map = buildJointDragSlotMap({
    entity,
    binding: { jointId: 'jk-1', segmentIndex: 0, jointKey: 'topJoint' },
    hosts: { root: root() },
  });
  assert.ok(map);

  assert.equal(map.segments.length, 1);
  const [slot] = map.segments;
  assert.equal(slot.diameter, 1.2);
  assert.equal(slot.diameterEnd, 0.6);
  assert.equal(slot.ratio, 0.5);
  assert.equal(slot.batchKey, '0.5');
  assert.deepEqual(map.shaftBuckets, [{ key: '0.5', ratio: 0.5, instances: 1 }]);
});

test('a trunk cone is one body, one tip and one nib in its ratio bucket', () => {
  const map = buildJointDragSlotMap({
    entity: trunk(),
    binding: { jointId: 'j-1', segmentIndex: 0, jointKey: 'topJoint' },
    hosts: { root: root() },
  });
  assert.ok(map);

  assert.equal(map.cones.length, 1);
  const [cone] = map.cones;
  // bodyDiameter / contactDiameter = 1.2 / 0.4 = 3.
  assert.equal(cone.bodyKey, '3');
  assert.equal(cone.kind, 'disk');
  assert.equal(cone.bodyInstance, 0);
  assert.equal(cone.tipInstance, 0);
  assert.equal(cone.diskInstance, 0);
  assert.equal(map.coneBodyBuckets.length, 1);
  assert.equal(map.coneBodyBuckets[0].key, '3');
  assert.equal(map.coneBodyBuckets[0].instances, 1);
  assert.ok(Math.abs(map.coneBodyBuckets[0].ratio - 3) < 1e-9);
  assert.equal(map.counts.coneNibs, 1);
});

test('a stick draws both cones, and only the disk profile owns a nib', () => {
  const map = buildJointDragSlotMap({
    entity: stick(),
    binding: { jointId: 'js-a', segmentIndex: 0, jointKey: 'bottomJoint' },
  });
  assert.ok(map);

  assert.deepEqual(map.cones.map((cone) => cone.field), ['contactConeA', 'contactConeB']);
  assert.deepEqual(map.cones.map((cone) => cone.kind), ['disk', 'sphere']);
  assert.deepEqual(map.cones.map((cone) => cone.tipInstance), [0, 1]);
  assert.equal(map.cones[0].diskInstance, 0);
  assert.equal(map.cones[1].diskInstance, undefined);
  assert.equal(map.counts.coneNibs, 1);
  // Both profiles share the 3:1 body/contact ratio, so one body bucket.
  assert.equal(map.coneBodyBuckets.length, 1);
  assert.equal(map.coneBodyBuckets[0].key, '3');
  assert.equal(map.coneBodyBuckets[0].instances, 2);
  assert.ok(Math.abs(map.coneBodyBuckets[0].ratio - 3) < 1e-9);
});

test('the slot map is stable across a preview entity', () => {
  const binding: JointDragBinding = { jointId: 'j-1', segmentIndex: 0, jointKey: 'topJoint' };
  const hosts = { root: root() };
  const committed = buildJointDragSlotMap({ entity: trunk(), binding, hosts });
  const preview = buildJointDragSlotMap({ entity: trunkPreview(), binding, hosts });
  assert.ok(committed);
  assert.ok(preview);

  assert.deepEqual(
    preview.joints.map((slot) => [slot.id, slot.instance, slot.diameter]),
    committed.joints.map((slot) => [slot.id, slot.instance, slot.diameter]),
  );
  assert.deepEqual(
    preview.segments.map((slot) => [slot.id, slot.segmentIndex, slot.instance, slot.batchKey]),
    committed.segments.map((slot) => [slot.id, slot.segmentIndex, slot.instance, slot.batchKey]),
  );
  assert.deepEqual(preview.shaftBuckets, committed.shaftBuckets);
  assert.deepEqual(preview.coneBodyBuckets, committed.coneBodyBuckets);
  assert.deepEqual(
    preview.cones.map((cone) => [cone.id, cone.bodyInstance, cone.tipInstance, cone.diskInstance]),
    committed.cones.map((cone) => [cone.id, cone.bodyInstance, cone.tipInstance, cone.diskInstance]),
  );

  // Only the values move.
  assert.notDeepEqual(preview.joints[0].pos, committed.joints[0].pos);
  assert.notDeepEqual(preview.segments[0].end, committed.segments[0].end);
});

test('leaf host knots on the support’s own segments join the map', () => {
  const knots: DragHostKnot[] = [
    { id: 'knot-1', parentShaftId: 'seg-1', pos: at(0, 0, 5), t: 0.5, diameter: 1.6 },
    { id: 'knot-2', parentShaftId: 'seg-2', pos: at(0, 0, 15), diameter: 1.6 },
    { id: 'knot-3', parentShaftId: 'someone-else-seg', pos: at(9, 0, 0) },
  ];
  const map = buildJointDragSlotMap({
    entity: trunk(),
    binding: { jointId: 'j-1', segmentIndex: 0, jointKey: 'topJoint' },
    hosts: { root: root() },
    hostKnots: knots,
    sharedJointSlotById: new Map([['knot-1', 4], ['knot-2', 5]]),
  });
  assert.ok(map);

  assert.deepEqual(map.knotBalls.map((ball) => ball.id), ['knot-1', 'knot-2']);
  assert.deepEqual(map.knotBalls.map((ball) => ball.sharedInstance), [4, 5]);
  assert.deepEqual(map.knotBalls.map((ball) => ball.segmentIndex), [0, 1]);
  assert.equal(map.knotBalls[0].t, 0.5);
  assert.equal(map.knotBalls[1].t, undefined);
  // The shared batch draws a knot ball at its host diameter.
  assert.equal(map.knotBalls[0].diameter, 1.6 - JOINT_DIAMETER_OFFSET_MM);
  assert.equal(map.knotBalls[0].takesJointDiameter, true);
  assert.equal(
    dragKnotBallDiameter(map.knotBalls[0], 1.5),
    1.5 + 0.125 - JOINT_DIAMETER_OFFSET_MM,
  );
});

test('a missing shared instance leaves the ball out of range rather than misplaced', () => {
  const map = buildJointDragSlotMap({
    entity: trunk(),
    binding: { jointId: 'j-1', segmentIndex: 0, jointKey: 'topJoint' },
    hosts: { root: root() },
    hostKnots: [{ id: 'knot-1', parentShaftId: 'seg-1', pos: at(0, 0, 5) }],
  });
  assert.ok(map);
  assert.equal(map.knotBalls[0].sharedInstance, null);
});

test('the map refuses a gesture it cannot draw, instead of a partial one', () => {
  // A twig: contact disks are the reason the predicate excludes it.
  assert.equal(
    buildJointDragSlotMap({
      entity: { ...stick(), typeId: 'twig' } as JointDragSlotEntity,
      binding: { jointId: 'js-a', segmentIndex: 0, jointKey: 'bottomJoint' },
    }),
    null,
  );

  // A trunk whose root was not handed over cannot resolve its first segment.
  assert.equal(
    buildJointDragSlotMap({
      entity: trunk(),
      binding: { jointId: 'j-1', segmentIndex: 0, jointKey: 'topJoint' },
    }),
    null,
  );

  // A binding that does not match the committed entity.
  assert.equal(
    buildJointDragSlotMap({
      entity: trunk(),
      binding: { jointId: 'nope', segmentIndex: 0, jointKey: 'topJoint' },
      hosts: { root: root() },
    }),
    null,
  );
  assert.equal(
    buildJointDragSlotMap({
      entity: trunk(),
      binding: { jointId: 'j-2', segmentIndex: 0, jointKey: 'topJoint' },
      hosts: { root: root() },
    }),
    null,
  );
});
