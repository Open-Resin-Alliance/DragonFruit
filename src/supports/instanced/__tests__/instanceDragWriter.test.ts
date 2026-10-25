import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import * as THREE from 'three';

import { resolveSegmentEndpoints } from '../../SupportPrimitives/Knot/segmentEndpoints';
import type { ContactCone } from '../../SupportPrimitives/ContactCone/types';
import type { Roots } from '../../types';
import {
  buildJointDragSlotMap,
  coneBatchSlotFromContact,
  type JointDragSlotEntity,
} from '../dragSlots';
import {
  beginJointDrag,
  clearJointDragSession,
  clearJointDragSessionAfterFrame,
  dragBatchRegistrationCount,
  endJointDrag,
  getJointDragSession,
  getLastJointDragPreview,
  registerDragBatch,
  writeJointDragFrame,
} from '../instanceDragWriter';
import { resizeJointBatch, writeJointSlotMatrix } from '../jointSlotBatch';
import { writeConeBodyMatrix, writeConeDiskMatrix, writeConeTipMatrix } from '../coneSlotBatch';
import { writeShaftSlotMatrix } from '../shaftSlotBatch';
import { SupportInstanceBatch } from '../supportInstanceBatch';

const at = (x: number, y: number, z: number) => ({ x, y, z });

const BINDING = { jointId: 'j-1', segmentIndex: 0, jointKey: 'topJoint' as const };

function joint(id: string, pos: { x: number; y: number; z: number }, diameter = 1.4) {
  return { id, pos, diameter };
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

function cone(): ContactCone {
  return {
    id: 'cone-1',
    pos: at(0, 0, 30),
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

function trunk(): JointDragSlotEntity {
  return {
    id: 'trunk-1',
    typeId: 'trunk',
    modelId: 'model-1',
    segments: [
      { id: 'seg-1', diameter: 1.5, topJoint: joint('j-1', at(0, 0, 10)) },
      { id: 'seg-2', diameter: 1.5, topJoint: joint('j-2', at(0, 0, 20)) },
    ],
    contactCone: cone(),
  } as JointDragSlotEntity;
}

/** The moved cone the preview frame carries, re-aimed at the still joint. */
function movedCone(): ContactCone {
  return {
    ...cone(),
    normal: at(0.1, 0, -0.99),
    profile: { ...cone().profile, lengthMm: 3.4 },
  };
}

/** One frame later: the pointer joint has moved, the terminal one has not. */
function preview(): JointDragSlotEntity {
  return {
    ...trunk(),
    segments: [
      { id: 'seg-1', diameter: 1.5, topJoint: joint('j-1', at(3, 0, 12)) },
      { id: 'seg-2', diameter: 1.5, topJoint: joint('j-2', at(0, 0, 20)) },
    ],
    contactCone: movedCone(),
  } as JointDragSlotEntity;
}

function jointBatch(count: number): SupportInstanceBatch {
  const batch = new SupportInstanceBatch(new THREE.SphereGeometry(1, 8, 6), Math.max(1, count));
  resizeJointBatch(batch, count);
  return batch;
}

function shaftBatch(count: number, ratio = 1): SupportInstanceBatch {
  const batch = new SupportInstanceBatch(
    new THREE.CylinderGeometry(ratio / 2, 0.5, 1, 8),
    Math.max(1, count),
  );
  batch.resizeTo(count, 0, ratio);
  return batch;
}

function coneBatch(count: number): SupportInstanceBatch {
  const batch = new SupportInstanceBatch(new THREE.CylinderGeometry(1, 3, 1, 8), Math.max(1, count));
  batch.resizeTo(count, 0, 3);
  return batch;
}

function matrixOf(batch: SupportInstanceBatch, instance: number): number[] {
  const array = (
    batch.geometry.getAttribute('instanceMatrix') as THREE.InstancedBufferAttribute
  ).array as Float32Array;
  return Array.from(array.subarray(instance * 16, instance * 16 + 16));
}

function radialScale(batch: SupportInstanceBatch, instance: number): number {
  const matrix = new THREE.Matrix4().fromArray(matrixOf(batch, instance));
  return new THREE.Vector3().setFromMatrixColumn(matrix, 0).length();
}

type Batches = {
  joint: SupportInstanceBatch;
  shaft: SupportInstanceBatch;
  body: SupportInstanceBatch;
  tip: SupportInstanceBatch;
  nib: SupportInstanceBatch;
  shared: SupportInstanceBatch;
  dispose: () => void;
};

/**
 * Begin a trunk drag and mount the batches exactly as the component would: a
 * joint batch, the straight shaft bucket, the cone's body bucket and its tip and
 * nib, plus the scene's shared joint batch for the host-knot ball.
 */
function startDrag(): { map: NonNullable<ReturnType<typeof beginJointDrag>>; batches: Batches } {
  clearJointDragSession();

  const hosts = { root: root() };
  const hostKnots = [{ id: 'knot-1', parentShaftId: 'seg-1', pos: at(0, 0, 5), t: 0.5, diameter: 1.6 }];
  const map = beginJointDrag({
    entity: trunk(),
    binding: BINDING,
    hosts,
    hostKnots,
    sharedJointSlotById: new Map([['knot-1', 4]]),
  });
  assert.ok(map);

  const jointB = jointBatch(map.counts.joints);
  const shaftB = shaftBatch(map.counts.segments);
  const bodyB = coneBatch(map.coneBodyBuckets[0].instances);
  const tipB = jointBatch(map.counts.cones);
  const nibB = coneBatch(Math.max(1, map.counts.coneNibs));
  const sharedB = jointBatch(5);

  const dispose = registerDragBatch({
    joint: jointB,
    shafts: new Map([['straight', shaftB]]),
    coneBodies: new Map([[map.coneBodyBuckets[0].key, bodyB]]),
    coneTips: tipB,
    coneDisks: nibB,
    sharedJoints: sharedB,
    resolvePenetration: () => 0.4,
  });

  return {
    map,
    batches: {
      joint: jointB,
      shaft: shaftB,
      body: bodyB,
      tip: tipB,
      nib: nibB,
      shared: sharedB,
      dispose: () => {
        dispose();
        for (const batch of [jointB, shaftB, bodyB, tipB, nibB, sharedB]) batch.dispose();
      },
    },
  };
}

afterEach(() => {
  clearJointDragSession();
  assert.equal(dragBatchRegistrationCount(), 0);
});

test('a joint frame writes the same transforms the detail writers do', () => {
  const { map, batches } = startDrag();
  try {
    writeJointDragFrame(preview());

    const reference = jointBatch(map.counts.joints);
    writeJointSlotMatrix(reference, 0, at(3, 0, 12), 1.4);
    writeJointSlotMatrix(reference, 1, at(0, 0, 20), 1.4);

    assert.deepEqual(matrixOf(batches.joint, 0), matrixOf(reference, 0));
    assert.deepEqual(matrixOf(batches.joint, 1), matrixOf(reference, 1));

    // The resolved entity diameter (radius 0.7), never the scene's
    // `diameter - 0.075` blend the unselected batch draws.
    assert.equal(map.joints[0].diameter, 1.4);
    assert.ok(Math.abs(radialScale(batches.joint, 0) - 0.7) < 1e-6);
    reference.dispose();
  } finally {
    batches.dispose();
  }
});

test('a segment frame re-resolves endpoints exactly as the detail renderer does', () => {
  const { map, batches } = startDrag();
  try {
    const frame = preview();
    writeJointDragFrame(frame);

    const reference = shaftBatch(map.counts.segments);
    const hosts = { root: root() };
    for (const slot of map.segments) {
      const endpoints = resolveSegmentEndpoints(
        frame,
        frame.segments[slot.segmentIndex],
        slot.segmentIndex,
        hosts,
      );
      assert.ok(endpoints);
      writeShaftSlotMatrix(reference, slot.instance, {
        start: endpoints.start,
        end: endpoints.end,
        diameter: slot.diameter,
      });
      assert.deepEqual(matrixOf(batches.shaft, slot.instance), matrixOf(reference, slot.instance));
    }
    reference.dispose();
  } finally {
    batches.dispose();
  }
});

test('a cone frame writes body, tip and nib through the shared cone writers', () => {
  const { map, batches } = startDrag();
  try {
    const frame = preview();
    writeJointDragFrame(frame);

    const slot = coneBatchSlotFromContact(movedCone(), map.supportId, frame.modelId);
    assert.ok(slot);
    const [dragCone] = map.cones;

    const referenceBody = coneBatch(1);
    const referenceTip = jointBatch(1);
    const referenceNib = coneBatch(1);
    writeConeBodyMatrix(referenceBody, 0, slot);
    writeConeTipMatrix(referenceTip, 0, slot);
    writeConeDiskMatrix(referenceNib, 0, slot, 0.4);

    assert.deepEqual(matrixOf(batches.body, dragCone.bodyInstance), matrixOf(referenceBody, 0));
    assert.deepEqual(matrixOf(batches.tip, dragCone.tipInstance), matrixOf(referenceTip, 0));
    assert.deepEqual(matrixOf(batches.nib, dragCone.diskInstance!), matrixOf(referenceNib, 0));

    referenceBody.dispose();
    referenceTip.dispose();
    referenceNib.dispose();
  } finally {
    batches.dispose();
  }
});

test('one frame flushes each batch exactly once', () => {
  const { batches } = startDrag();
  const originalFlush = SupportInstanceBatch.prototype.flush;
  const flushes = new Map<SupportInstanceBatch, number>();
  SupportInstanceBatch.prototype.flush = function flush(this: SupportInstanceBatch) {
    flushes.set(this, (flushes.get(this) ?? 0) + 1);
    originalFlush.call(this);
  };

  try {
    writeJointDragFrame(preview());
  } finally {
    SupportInstanceBatch.prototype.flush = originalFlush;
    batches.dispose();
  }

  for (const [name, batch] of Object.entries(batches)) {
    if (!(batch instanceof SupportInstanceBatch)) continue;
    assert.equal(flushes.get(batch), 1, `${name} flushed ${flushes.get(batch) ?? 0} times`);
  }
});

test('the shared joint batch moves its own knot slot and nothing else', () => {
  const { map, batches } = startDrag();
  try {
    // Mark every shared instance so a stray write is visible.
    for (let instance = 0; instance < 5; instance += 1) {
      writeJointSlotMatrix(batches.shared, instance, at(100 + instance, 0, 0), 1);
    }
    const before = [0, 1, 2, 3].map((instance) => matrixOf(batches.shared, instance));

    writeJointDragFrame(preview());

    for (let instance = 0; instance < 4; instance += 1) {
      assert.deepEqual(matrixOf(batches.shared, instance), before[instance]);
    }

    // The knot rides seg-1's new span at t = 0.5, at the joint-diameter rule.
    const ball = map.knotBalls[0];
    assert.equal(ball.sharedInstance, 4);
    const moved = new THREE.Matrix4().fromArray(matrixOf(batches.shared, 4));
    const position = new THREE.Vector3().setFromMatrixPosition(moved);
    assert.ok(Math.abs(position.x - 1.5) < 1e-6);
    assert.ok(Math.abs(position.z - 6.75) < 1e-6);
    assert.ok(Math.abs(radialScale(batches.shared, 4) - (1.5 + 0.125 - 0.1) / 2) < 1e-6);
  } finally {
    batches.dispose();
  }
});

test('a stale shared-batch instance is skipped, not a crash inside a frame', () => {
  clearJointDragSession();
  const map = beginJointDrag({
    entity: trunk(),
    binding: BINDING,
    hosts: { root: root() },
    hostKnots: [{ id: 'knot-1', parentShaftId: 'seg-1', pos: at(0, 0, 5), t: 0.5 }],
    sharedJointSlotById: new Map([['knot-1', 4]]),
  });
  assert.ok(map);

  const joints = jointBatch(map.counts.joints);
  const shared = jointBatch(2);
  const dispose = registerDragBatch({ joint: joints, sharedJoints: shared });
  try {
    // The scene's batch renumbered under the gesture: instance 4 no longer exists.
    assert.doesNotThrow(() => writeJointDragFrame(preview()));
    assert.equal(shared.count, 2);
  } finally {
    dispose();
    joints.dispose();
    shared.dispose();
  }
});

test('the drop offset shifts every written position and nothing else', () => {
  clearJointDragSession();
  const map = beginJointDrag({
    entity: trunk(),
    binding: BINDING,
    hosts: { root: root() },
    dropOffsetZ: 2,
  });
  assert.ok(map);

  const joints = jointBatch(map.counts.joints);
  const dispose = registerDragBatch({ joint: joints });
  try {
    writeJointDragFrame(preview());
    const position = new THREE.Vector3().setFromMatrixPosition(
      new THREE.Matrix4().fromArray(matrixOf(joints, 0)),
    );
    assert.deepEqual([position.x, position.y, position.z], [3, 0, 14]);
    assert.ok(Math.abs(radialScale(joints, 0) - 0.7) < 1e-6);
  } finally {
    dispose();
    joints.dispose();
  }
});

test('registering after the first frame draws that frame, not identity', () => {
  clearJointDragSession();
  const map = beginJointDrag({ entity: trunk(), binding: BINDING, hosts: { root: root() } });
  assert.ok(map);
  writeJointDragFrame(preview());

  const joints = jointBatch(map.counts.joints);
  const dispose = registerDragBatch({ joint: joints });
  try {
    const reference = jointBatch(map.counts.joints);
    writeJointSlotMatrix(reference, 0, at(3, 0, 12), 1.4);
    assert.deepEqual(matrixOf(joints, 0), matrixOf(reference, 0));
    reference.dispose();
  } finally {
    dispose();
    joints.dispose();
  }
});

test('begin, frame and end: the private batches end empty and the preview survives', () => {
  const { batches } = startDrag();
  try {
    writeJointDragFrame(preview());
    assert.equal(getJointDragSession()?.ended, false);

    endJointDrag();

    for (const batch of [batches.joint, batches.shaft, batches.body, batches.tip, batches.nib]) {
      assert.equal(batch.count, 0);
    }
    // The scene's batch is never resized by a drag.
    assert.equal(batches.shared.count, 5);

    const session = getJointDragSession();
    assert.equal(session?.ended, true);
    // Both commit sites read what the operator last saw, after the release.
    const last = getLastJointDragPreview<JointDragSlotEntity>();
    assert.equal(last?.id, 'trunk-1');
    assert.equal(last?.segments[0].topJoint?.pos.x, 3);

    assert.throws(() => writeJointDragFrame(preview()), /session has ended/);
  } finally {
    batches.dispose();
  }
});

test('the frame-later clear releases the session on the next frame', () => {
  const { batches } = startDrag();
  writeJointDragFrame(preview());
  endJointDrag();

  const original = globalThis.requestAnimationFrame;
  const frame: { run: (() => void) | null } = { run: null };
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
    frame.run = () => callback(0);
    return 1;
  };

  try {
    clearJointDragSessionAfterFrame();

    // The release commit still reads the preview: the session is not gone yet.
    assert.ok(getJointDragSession());
    assert.ok(frame.run);
    const runScheduled: () => void = frame.run;
    runScheduled();

    assert.equal(getJointDragSession(), null);
    assert.equal(getLastJointDragPreview(), null);
  } finally {
    if (original) globalThis.requestAnimationFrame = original;
    else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
    batches.dispose();
  }
});

test('a frame outside a session throws instead of silently drawing', () => {
  clearJointDragSession();
  assert.throws(() => writeJointDragFrame(preview()), /no joint drag session/);

  // A non-instanceable gesture opens no session at all.
  const twig = { ...trunk(), typeId: 'twig' } as JointDragSlotEntity;
  assert.equal(beginJointDrag({ entity: twig, binding: BINDING, hosts: { root: root() } }), null);
  assert.equal(getJointDragSession(), null);
});

test('an undersized batch fails loudly rather than leaving a stale transform', () => {
  clearJointDragSession();
  const map = beginJointDrag({ entity: trunk(), binding: BINDING, hosts: { root: root() } });
  assert.ok(map);

  const joints = jointBatch(1);
  try {
    // Registration writes the current frame, so the guard fires there first.
    assert.throws(() => registerDragBatch({ joint: joints }), RangeError);
    // The failed registration is not left behind for the next frame.
    assert.equal(dragBatchRegistrationCount(), 0);
  } finally {
    joints.dispose();
  }
});

test('the slot map used by the writer is the one beginJointDrag returns', () => {
  const { map, batches } = startDrag();
  try {
    assert.equal(getJointDragSession()?.slotMap, map);
    // The same builder the tests above read; no second answer.
    assert.deepEqual(
      buildJointDragSlotMap({ entity: trunk(), binding: BINDING, hosts: { root: root() } })?.joints
        .map((slot) => slot.id),
      map.joints.map((slot) => slot.id),
    );
  } finally {
    batches.dispose();
    clearJointDragSession();
  }
});
