import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import * as THREE from 'three';

import type { ContactCone } from '../../SupportPrimitives/ContactCone/types';
import { CONE_DISK_PRIMITIVE_DATA, coneSlotData, writeConeBodyMatrix, writeConeDiskMatrix, writeConeTipMatrix } from '../coneSlotBatch';
import { coneBatchSlotFromContact } from '../dragSlots';
import type { ConeBatchSlot } from '../coneSlots';
import {
  beginConeDrag,
  clearConeDragSession,
  clearConeDragSessionAfterFrame,
  coneDragBatchRegistrationCount,
  endConeDrag,
  getConeDragSession,
  getLastConeDragPreview,
  registerConeDragBatch,
  writeConeDragFrame,
} from '../coneDragWriter';
import { SupportInstanceBatch } from '../supportInstanceBatch';

const at = (x: number, y: number, z: number) => ({ x, y, z });

function diskCone(): ContactCone {
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

function sphereCone(): ContactCone {
  return {
    id: 'cone-1',
    pos: at(0, 0, 30),
    normal: at(0, 0, 1),
    surfaceNormal: at(0, 0, 1),
    socketJointId: 'j-2',
    profile: {
      type: 'sphere',
      contactDiameterMm: 0.4,
      bodyDiameterMm: 1.2,
      lengthMm: 2,
      penetrationMm: 0.05,
      sphereRadiusRatio: 1.5,
    },
  };
}

/** One hit later: the cone has been re-aimed and re-measured, not reshaped. */
function movedCone(): ContactCone {
  return {
    ...diskCone(),
    pos: at(4, 2, 28),
    normal: at(0.2, 0, -0.98),
    surfaceNormal: at(0.1, 0, -0.99),
    profile: { ...diskCone().profile, lengthMm: 3.4 },
  };
}

function bodyBatch(ratio = 3): SupportInstanceBatch {
  const batch = new SupportInstanceBatch(new THREE.CylinderGeometry(1, ratio, 1, 8), 1);
  batch.resizeTo(1, coneSlotData('disk'), ratio);
  return batch;
}

function tipBatch(): SupportInstanceBatch {
  const batch = new SupportInstanceBatch(new THREE.SphereGeometry(1, 8, 6), 1);
  batch.resizeTo(1, coneSlotData('disk'), 1);
  return batch;
}

function nibBatch(): SupportInstanceBatch {
  const batch = new SupportInstanceBatch(new THREE.CylinderGeometry(1, 1, 1, 8), 1);
  batch.resizeTo(1, CONE_DISK_PRIMITIVE_DATA, 1);
  return batch;
}

function matrixOf(batch: SupportInstanceBatch, instance: number): number[] {
  const array = (
    batch.geometry.getAttribute('instanceMatrix') as THREE.InstancedBufferAttribute
  ).array as Float32Array;
  return Array.from(array.subarray(instance * 16, instance * 16 + 16));
}

function slotFor(cone: ContactCone): ConeBatchSlot {
  const slot = coneBatchSlotFromContact(cone, 'trunk-1', 'model-1');
  assert.ok(slot);
  return slot;
}

type Batches = {
  body: SupportInstanceBatch;
  tip: SupportInstanceBatch;
  nib: SupportInstanceBatch;
  dispose: () => void;
};

/**
 * Begin a trunk tip drag and mount the batches exactly as the component would:
 * the cone's body bucket, its tip ball and its nib.
 */
function startDrag(cone: ContactCone = diskCone()): {
  map: NonNullable<ReturnType<typeof beginConeDrag>>;
  batches: Batches;
} {
  clearConeDragSession();

  const map = beginConeDrag({
    typeId: 'trunk',
    field: 'contactCone',
    cone,
    supportId: 'trunk-1',
    modelId: 'model-1',
  });
  assert.ok(map);

  const body = bodyBatch();
  const tip = tipBatch();
  const nib = nibBatch();
  const dispose = registerConeDragBatch({
    coneBodies: new Map([[map.coneBodyBuckets[0].key, body]]),
    coneTips: tip,
    coneDisks: nib,
    resolvePenetration: () => 0.4,
  });

  return {
    map,
    batches: {
      body,
      tip,
      nib,
      dispose: () => {
        dispose();
        for (const batch of [body, tip, nib]) batch.dispose();
      },
    },
  };
}

afterEach(() => {
  clearConeDragSession();
  assert.equal(coneDragBatchRegistrationCount(), 0);
});

test('a frame writes the same transforms the shared cone writers do', () => {
  const { map, batches } = startDrag();
  try {
    writeConeDragFrame(movedCone());

    const slot = slotFor(movedCone());
    const [dragSlot] = map.cones;

    const referenceBody = bodyBatch();
    const referenceTip = tipBatch();
    const referenceNib = nibBatch();
    writeConeBodyMatrix(referenceBody, 0, slot);
    writeConeTipMatrix(referenceTip, 0, slot);
    writeConeDiskMatrix(referenceNib, 0, slot, 0.4);

    assert.deepEqual(matrixOf(batches.body, dragSlot.bodyInstance), matrixOf(referenceBody, 0));
    assert.deepEqual(matrixOf(batches.tip, dragSlot.tipInstance), matrixOf(referenceTip, 0));
    assert.deepEqual(matrixOf(batches.nib, dragSlot.diskInstance!), matrixOf(referenceNib, 0));

    referenceBody.dispose();
    referenceTip.dispose();
    referenceNib.dispose();
  } finally {
    batches.dispose();
  }
});

test('no drop offset is applied: the tip lands exactly on the preview point', () => {
  const cone = sphereCone();
  const { batches } = startDrag(cone);
  try {
    const moved = { ...sphereCone(), pos: at(4, 2, 28) };
    writeConeDragFrame(moved);

    const position = new THREE.Vector3().setFromMatrixPosition(
      new THREE.Matrix4().fromArray(matrixOf(batches.tip, 0)),
    );
    // A sphere-profile cone has no nib offset, so the tip ball sits on `pos`.
    assert.deepEqual([position.x, position.y, position.z], [4, 2, 28]);
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
    writeConeDragFrame(movedCone());
  } finally {
    SupportInstanceBatch.prototype.flush = originalFlush;
    batches.dispose();
  }

  for (const [name, batch] of Object.entries(batches)) {
    if (!(batch instanceof SupportInstanceBatch)) continue;
    assert.equal(flushes.get(batch), 1, `${name} flushed ${flushes.get(batch) ?? 0} times`);
  }
});

test('registering after the first frame draws that frame, not identity', () => {
  clearConeDragSession();
  const map = beginConeDrag({
    typeId: 'trunk',
    field: 'contactCone',
    cone: diskCone(),
    supportId: 'trunk-1',
    modelId: 'model-1',
  });
  assert.ok(map);
  writeConeDragFrame(movedCone());

  const body = bodyBatch();
  const dispose = registerConeDragBatch({ coneBodies: new Map([['3', body]]) });
  try {
    const reference = bodyBatch();
    writeConeBodyMatrix(reference, 0, slotFor(movedCone()));
    assert.deepEqual(matrixOf(body, 0), matrixOf(reference, 0));
    reference.dispose();
  } finally {
    dispose();
    body.dispose();
  }
});

test('begin, frame and end: the private batches end empty and the preview survives', () => {
  const { batches } = startDrag();
  try {
    writeConeDragFrame(movedCone());
    assert.equal(getConeDragSession()?.ended, false);

    endConeDrag();

    for (const batch of [batches.body, batches.tip, batches.nib]) {
      assert.equal(batch.count, 0);
    }

    const session = getConeDragSession();
    assert.equal(session?.ended, true);
    // The commit reads what the operator last saw, after the release.
    assert.equal(getLastConeDragPreview()?.pos.x, 4);

    assert.throws(() => writeConeDragFrame(movedCone()), /session has ended/);
  } finally {
    batches.dispose();
  }
});

test('the frame-later clear releases the session on the next frame', () => {
  const { batches } = startDrag();
  writeConeDragFrame(movedCone());
  endConeDrag();

  const original = globalThis.requestAnimationFrame;
  const frame: { run: (() => void) | null } = { run: null };
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
    frame.run = () => callback(0);
    return 1;
  };

  try {
    clearConeDragSessionAfterFrame();

    // The release commit still reads the preview: the session is not gone yet.
    assert.ok(getConeDragSession());
    assert.ok(frame.run);
    const runScheduled: () => void = frame.run;
    runScheduled();

    assert.equal(getConeDragSession(), null);
    assert.equal(getLastConeDragPreview(), null);
  } finally {
    if (original) globalThis.requestAnimationFrame = original;
    else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
    batches.dispose();
  }
});

test('a frame outside a session throws instead of silently drawing', () => {
  clearConeDragSession();
  assert.throws(() => writeConeDragFrame(movedCone()), /no cone drag session/);

  // A gesture the predicate refuses opens no session at all.
  assert.equal(
    beginConeDrag({
      typeId: 'branch',
      field: 'contactCone',
      cone: diskCone(),
      supportId: 'branch-1',
    }),
    null,
  );
  assert.equal(getConeDragSession(), null);
});

test('a degenerate preview frame keeps the last drawn cone instead of collapsing it', () => {
  const { batches } = startDrag();
  try {
    writeConeDragFrame(movedCone());
    const before = matrixOf(batches.tip, 0);

    assert.doesNotThrow(() => writeConeDragFrame({ ...movedCone(), normal: at(0, 0, 0) }));

    assert.deepEqual(matrixOf(batches.tip, 0), before);
    // The session still remembers the refused frame, so the commit writes it.
    assert.equal(getLastConeDragPreview()?.normal.x, 0);
  } finally {
    batches.dispose();
  }
});

test('an undersized batch fails loudly rather than leaving a stale transform', () => {
  clearConeDragSession();
  beginConeDrag({
    typeId: 'trunk',
    field: 'contactCone',
    cone: diskCone(),
    supportId: 'trunk-1',
  });

  const empty = new SupportInstanceBatch(new THREE.SphereGeometry(1, 8, 6), 1);
  try {
    // Registration writes the begin frame, so the guard fires there first.
    assert.throws(() => registerConeDragBatch({ coneTips: empty }), RangeError);
    // The failed registration is not left behind for the next frame.
    assert.equal(coneDragBatchRegistrationCount(), 0);
  } finally {
    empty.dispose();
  }
});

test('the session is a singleton: the store the hook writes is the one the batch reads', () => {
  const { map, batches } = startDrag();
  try {
    assert.equal(getConeDragSession()?.slotMap, map);
    const generation = getConeDragSession()?.generation;
    assert.ok(generation !== undefined);

    // A second gesture replaces it and bumps the generation, so the batch
    // remounts against buffers sized for the new cone.
    const next = beginConeDrag({
      typeId: 'stick',
      field: 'contactConeB',
      cone: sphereCone(),
      supportId: 'stick-1',
    });
    assert.ok(next);
    assert.equal(getConeDragSession()?.slotMap, next);
    assert.equal(getConeDragSession()?.generation, generation + 1);
    assert.equal(getLastConeDragPreview()?.id, 'cone-1');
  } finally {
    batches.dispose();
  }
});
