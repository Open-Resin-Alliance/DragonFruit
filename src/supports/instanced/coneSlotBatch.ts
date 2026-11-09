import * as THREE from 'three';

import { getConeQuaternionInto } from '../SupportPrimitives/ContactCone/contactConeUtils';
import { getDiskCenter, getDiskRotationInto } from '../SupportPrimitives/ContactDisk/contactDiskUtils';
import {
  INSTANCE_PROFILE_DISK,
  INSTANCE_PROFILE_LEGACY,
  INSTANCE_PROFILE_SPHERE,
  INSTANCE_TYPE_CONE,
  packInstanceFlags,
} from './instanceFlags';
import {
  resolveJointVisualColor as resolveInstancedVisualColor,
  type InstancedJointVisualState,
} from './instancedPalette';
import type {
  ConeBatchSlot,
  ConeDiskSlotRecord,
  ConeProfileKind,
  ConeSlotIndex,
  ConeSlotRecord,
} from './coneSlots';
import type { SupportInstanceBatch } from './supportInstanceBatch';

/**
 * The writes that turn a `ConeSlotIndex` into one batch per primitive shape.
 *
 * Kept out of the component so the geometry/colour/state mapping is a pure
 * function of the slot list — and so the hover/marquee state is a diff of
 * integers rather than a React render of overlay meshes.
 *
 * One batch is one base geometry (`SupportInstanceBatch` copies exactly one
 * shape), so the split is: one body batch per ratio bucket, one tip batch, one
 * nib batch. The batch a record belongs to is `record.bodyBucket` for the body,
 * and the two fixed keys for the contact primitives.
 *
 * Hover and marquee are **colour only**. The legacy overlays drew the same cone
 * geometry at the same transform, so unlike joints (×1.06) and shafts (×1.02)
 * there is no matrix scale to write.
 */

/** One scratch matrix, colour and vectors: a layout pass is synchronous and never re-enters. */
const scratchMatrix = new THREE.Matrix4();
const scratchPosition = new THREE.Vector3();
const scratchScale = new THREE.Vector3();
const scratchQuaternion = new THREE.Quaternion();
const scratchColor = new THREE.Color();

/** The batch key of the tip-ball batch, which every cone contributes to. */
export const CONE_TIP_BATCH_KEY = 'tip';

/** The batch key of the nib batch, which only disk profiles contribute to. */
export const CONE_DISK_BATCH_KEY = 'disk';

/**
 * The state one cone slot can be drawn in; the palette is the joint batch's.
 *
 * `base` is whatever colour the slot list resolved for the support (model
 * colour, dimmed colour, origin debug colour or bulk selection colour). `hover`
 * lifts that colour by 0.12; `marquee` is the bulk colour lifted the same way.
 */
export type InstancedConeVisualState = InstancedJointVisualState;

/**
 * The data word a body or tip instance carries: drawn, a contact cone, and the
 * profile code the shading pass reads.
 *
 * Hover/marquee state is *not* written here: it rides on the colour attribute,
 * which is the only thing a highlight changes.
 */
export const CONE_LEGACY_SLOT_DATA = packInstanceFlags({
  visible: true,
  type: INSTANCE_TYPE_CONE,
  profile: INSTANCE_PROFILE_LEGACY,
});

export const CONE_SPHERE_SLOT_DATA = packInstanceFlags({
  visible: true,
  type: INSTANCE_TYPE_CONE,
  profile: INSTANCE_PROFILE_SPHERE,
});

export const CONE_DISK_SLOT_DATA = packInstanceFlags({
  visible: true,
  type: INSTANCE_TYPE_CONE,
  profile: INSTANCE_PROFILE_DISK,
});

/**
 * The data word a nib instance carries: the disk profile's code plus the
 * `diskShade` bit, because the nib *is* the contact primitive's flat face.
 */
export const CONE_DISK_PRIMITIVE_DATA = packInstanceFlags({
  visible: true,
  type: INSTANCE_TYPE_CONE,
  profile: INSTANCE_PROFILE_DISK,
  diskShade: true,
});

const CONE_SLOT_DATA: Record<ConeProfileKind, number> = {
  legacy: CONE_LEGACY_SLOT_DATA,
  disk: CONE_DISK_SLOT_DATA,
  sphere: CONE_SPHERE_SLOT_DATA,
};

/** The data word a slot's body and tip instances carry for its profile. */
export function coneSlotData(kind: ConeProfileKind): number {
  return CONE_SLOT_DATA[kind];
}

/**
 * The point the cone body grows from: the contact point pushed out by the nib.
 *
 * Exported because the pointer index has to agree with the drawn geometry: a
 * disk-profile cone's body, tip ball and nib all sit off the contact point by
 * the nib thickness, and an index built from `pos` alone would sit inside the
 * model.
 */
export function coneStartPoint(
  slot: ConeBatchSlot,
): { x: number; y: number; z: number } {
  const offset = slot.kind === 'disk' ? slot.diskThickness : 0;
  return {
    x: slot.pos.x + slot.surfaceNormal.x * offset,
    y: slot.pos.y + slot.surfaceNormal.y * offset,
    z: slot.pos.z + slot.surfaceNormal.z * offset,
  };
}

/**
 * Write one cone's body transform: the frustum stretched from `start` to the
 * socket along `normal`.
 *
 * The composition is `InstancedContactConeGroup`'s verbatim — centre at
 * `start + normal · length / 2`, `+y` rotated onto `-normal`, scale
 * `(contactRadius, length, contactRadius)` — so the batch's `+y` cap is the
 * contact end and its `-y` cap the socket, whose radius the bucket's geometry
 * already carries. Positions are already in scene space: the producer applied
 * the model drop offset, so applying it again would double it.
 */
export function writeConeBodyMatrix(
  batch: SupportInstanceBatch,
  instance: number,
  slot: ConeBatchSlot,
): void {
  const start = coneStartPoint(slot);
  const halfLength = slot.lengthMm / 2;
  scratchPosition.set(
    start.x + slot.normal.x * halfLength,
    start.y + slot.normal.y * halfLength,
    start.z + slot.normal.z * halfLength,
  );
  getConeQuaternionInto(slot.normal, scratchQuaternion);
  scratchScale.set(slot.contactRadius, Math.max(0.001, slot.lengthMm), slot.contactRadius);
  scratchMatrix.compose(scratchPosition, scratchQuaternion, scratchScale);
  batch.setMatrix(instance, scratchMatrix);
}

/**
 * Write one cone's tip ball: the contact point itself, unrotated, radius
 * `contactRadius`.
 *
 * The ball is centred on the nib's top face for a disk profile and on the
 * contact point otherwise — the same `start` the body grows from.
 */
export function writeConeTipMatrix(
  batch: SupportInstanceBatch,
  instance: number,
  slot: ConeBatchSlot,
): void {
  const start = coneStartPoint(slot);
  scratchPosition.set(start.x, start.y, start.z);
  scratchQuaternion.identity();
  scratchScale.set(slot.contactRadius, slot.contactRadius, slot.contactRadius);
  scratchMatrix.compose(scratchPosition, scratchQuaternion, scratchScale);
  batch.setMatrix(instance, scratchMatrix);
}

/**
 * Write one cone's nib: the disk centred on `getDiskCenter`, pulled back by half
 * the penetration so its face sits the authored depth into the model.
 *
 * `penetration` is a writer argument because it follows the active material
 * profile (`calculateTipOffset`), not scene state: it is never part of the slot
 * index. It is clamped at zero exactly as the legacy group clamps it.
 */
export function writeConeDiskMatrix(
  batch: SupportInstanceBatch,
  instance: number,
  slot: ConeBatchSlot,
  penetration: number,
): void {
  // Clamped at zero as the legacy group clamps it; `|| 0` also turns a NaN
  // resolver result back into the authored thickness instead of poisoning it.
  const pen = Math.max(0, penetration) || 0;
  const centre = getDiskCenter(slot.pos, slot.surfaceNormal, slot.diskThickness);
  scratchPosition.set(
    centre.x - slot.surfaceNormal.x * (pen / 2),
    centre.y - slot.surfaceNormal.y * (pen / 2),
    centre.z - slot.surfaceNormal.z * (pen / 2),
  );
  getDiskRotationInto(slot.surfaceNormal, scratchQuaternion);
  scratchScale.set(
    slot.contactRadius,
    Math.max(0.001, slot.diskThickness + pen),
    slot.contactRadius,
  );
  scratchMatrix.compose(scratchPosition, scratchQuaternion, scratchScale);
  batch.setMatrix(instance, scratchMatrix);
}

function writeBodyInstance(
  batch: SupportInstanceBatch,
  record: ConeSlotRecord,
  state: InstancedConeVisualState,
): void {
  writeConeBodyMatrix(batch, record.bodyInstance, record.slot);
  const color = resolveInstancedVisualColor(record.color, state, scratchColor);
  batch.setColor(record.bodyInstance, color.r, color.g, color.b);
  batch.setRatio(record.bodyInstance, record.bodyRatio);
  batch.setData(record.bodyInstance, coneSlotData(record.kind));
}

function writeTipInstance(
  batch: SupportInstanceBatch,
  record: ConeSlotRecord,
  state: InstancedConeVisualState,
): void {
  writeConeTipMatrix(batch, record.tipInstance, record.slot);
  const color = resolveInstancedVisualColor(record.color, state, scratchColor);
  batch.setColor(record.tipInstance, color.r, color.g, color.b);
  batch.setRatio(record.tipInstance, 1);
  batch.setData(record.tipInstance, coneSlotData(record.kind));
}

function writeDiskInstance(
  batch: SupportInstanceBatch,
  record: ConeDiskSlotRecord,
  state: InstancedConeVisualState,
  penetration: number,
): void {
  const instance = record.diskInstance;
  writeConeDiskMatrix(batch, instance, record.slot, penetration);
  const color = resolveInstancedVisualColor(record.color, state, scratchColor);
  batch.setColor(instance, color.r, color.g, color.b);
  batch.setRatio(instance, 1);
  batch.setData(instance, CONE_DISK_PRIMITIVE_DATA);
}

/** Narrow a slot to one that owns a nib; only a disk profile does. */
function hasNib(record: ConeSlotRecord): record is ConeDiskSlotRecord {
  return record.diskInstance !== undefined;
}

/**
 * Write one slot's three primitives for `state`.
 *
 * `batches` must be the mounted batch set: the record's body bucket, the tip
 * batch and — for a disk profile — the nib batch. `resolvePenetration` is the
 * caller's material-profile subscription; see the module note in `coneSlots.ts`.
 */
export function writeConeSlot(
  batches: ReadonlyMap<string, SupportInstanceBatch>,
  index: ConeSlotIndex,
  id: number,
  state: InstancedConeVisualState,
  resolvePenetration: (slot: ConeBatchSlot) => number,
): void {
  const record = coneRecordAt(index, id);
  writeBodyInstance(requireBatch(batches, record.bodyBucket), record, state);
  writeTipInstance(requireBatch(batches, CONE_TIP_BATCH_KEY), record, state);
  if (hasNib(record)) {
    writeDiskInstance(
      requireBatch(batches, CONE_DISK_BATCH_KEY),
      record,
      state,
      resolvePenetration(record.slot),
    );
  }
}

/**
 * Rewrite every batch from the slot list, in base state.
 *
 * The caller owns the batch set: one body batch per `index.bodies` bucket, plus
 * the tip and nib batches. After the call every batch in the map draws exactly
 * what the index names — a bucket the index no longer has is emptied rather than
 * left drawing the previous layout's instances.
 *
 * Resizing is the batch's own power-of-two reallocation, which replaces
 * attribute objects on a stable geometry — the mesh, its material and the GPU
 * pick registration never remount because a count changed.
 */
export function writeAllConeSlots(
  index: ConeSlotIndex,
  batches: ReadonlyMap<string, SupportInstanceBatch>,
  resolvePenetration: (slot: ConeBatchSlot) => number,
): void {
  const used = new Set<string>();

  for (const bucket of index.bodies) {
    const batch = requireBatch(batches, bucket.key);
    used.add(bucket.key);
    // The placeholder word is immediately overwritten per record: the profiles
    // in one bucket differ, so there is no single word for the batch.
    batch.resizeTo(bucket.records.length, CONE_LEGACY_SLOT_DATA, bucket.ratio);
    for (const record of bucket.records) writeBodyInstance(batch, record, 'base');
  }

  if (index.tips.length > 0) {
    const batch = requireBatch(batches, CONE_TIP_BATCH_KEY);
    used.add(CONE_TIP_BATCH_KEY);
    batch.resizeTo(index.tips.length, CONE_LEGACY_SLOT_DATA, 1);
    for (const record of index.tips) writeTipInstance(batch, record, 'base');
  }

  if (index.disks.length > 0) {
    const batch = requireBatch(batches, CONE_DISK_BATCH_KEY);
    used.add(CONE_DISK_BATCH_KEY);
    batch.resizeTo(index.disks.length, CONE_DISK_PRIMITIVE_DATA, 1);
    for (const record of index.disks) {
      writeDiskInstance(batch, record, 'base', resolvePenetration(record.slot));
    }
  }

  for (const [key, batch] of batches) {
    if (used.has(key)) continue;
    batch.resizeTo(0, 0, 1);
  }
}

/**
 * The state every batch-drawn slot should be in, given the support under the
 * pointer and the supports past the first marquee hover.
 *
 * Only non-base slots are in the map: `diffConeSlotStates` treats an absent entry
 * as `base`, so a hover that ends is one deletion rather than a write of every
 * unchanged slot.
 *
 * Marquee wins over hover, exactly as the legacy overlay order did (the marquee
 * overlay drew over the hover overlay).
 */
export function computeConeSlotStates(
  index: ConeSlotIndex,
  hoveredSupportId: string | null | undefined,
  marqueeSupportIds: readonly string[],
): Map<number, InstancedConeVisualState> {
  const states = new Map<number, InstancedConeVisualState>();

  if (hoveredSupportId) {
    const ids = index.bySupport.get(hoveredSupportId);
    if (ids) {
      for (const id of ids) states.set(id, 'hover');
    }
  }

  for (const supportId of marqueeSupportIds) {
    const ids = index.bySupport.get(supportId);
    if (!ids) continue;
    for (const id of ids) states.set(id, 'marquee');
  }

  return states;
}

/** One slot whose state changed, identified by its id in `index.slots`. */
export type ConeSlotStateChange = {
  id: number;
  state: InstancedConeVisualState;
};

/**
 * The slots whose state differs between two maps, ascending by slot id.
 *
 * A hover writes the slots it changed and nothing else; this is the difference
 * that keeps a hovered support's cones from costing a full-batch upload.
 */
export function diffConeSlotStates(
  previous: ReadonlyMap<number, InstancedConeVisualState>,
  next: ReadonlyMap<number, InstancedConeVisualState>,
): ConeSlotStateChange[] {
  const candidates: number[] = [];
  for (const id of previous.keys()) candidates.push(id);
  for (const id of next.keys()) {
    if (!previous.has(id)) candidates.push(id);
  }
  candidates.sort((a, b) => a - b);

  const changes: ConeSlotStateChange[] = [];
  for (const id of candidates) {
    const before = previous.get(id) ?? 'base';
    const after = next.get(id) ?? 'base';
    if (before === after) continue;
    changes.push({ id, state: after });
  }
  return changes;
}

/**
 * Apply a diff to the batch set, writing only the slots that changed.
 *
 * The changes must come from the same `index` that is mounted: an id the index
 * does not hold is a stale diff, not a slot to draw, and is reported rather than
 * written into a neighbouring instance.
 */
export function applyConeSlotStateChanges(
  index: ConeSlotIndex,
  changes: readonly ConeSlotStateChange[],
  batches: ReadonlyMap<string, SupportInstanceBatch>,
  resolvePenetration: (slot: ConeBatchSlot) => number,
): void {
  for (const change of changes) {
    writeConeSlot(batches, index, change.id, change.state, resolvePenetration);
  }
}

function coneRecordAt(index: ConeSlotIndex, id: number): ConeSlotRecord {
  const record = index.slots[id];
  if (!record) {
    throw new RangeError(`coneSlotBatch: slot ${id} is outside 0..${index.slots.length - 1}`);
  }
  return record;
}

/** The batch a key names, or a loud failure: the index is the batch set's source. */
function requireBatch(
  batches: ReadonlyMap<string, SupportInstanceBatch>,
  key: string,
): SupportInstanceBatch {
  const batch = batches.get(key);
  if (!batch) throw new Error(`coneSlotBatch: no batch for "${key}"`);
  return batch;
}
