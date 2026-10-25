import * as THREE from 'three';

import { ROOT_RENDER_LIFT_MM } from '../SupportPrimitives/Roots/InstancedRootsGroup';
import { INSTANCE_TYPE_ROOT, packInstanceFlags } from './instanceFlags';
import {
  resolveJointVisualColor as resolveInstancedVisualColor,
  type InstancedJointVisualState,
} from './instancedPalette';
import type { RootConedSlotRecord, RootSlotIndex, RootSlotRecord } from './rootSlots';
import type { SupportInstanceBatch } from './supportInstanceBatch';

/**
 * The writes that turn a `RootSlotIndex` into one batch per primitive shape.
 *
 * Kept out of the component so the geometry/colour/state mapping is a pure
 * function of the slot list. One batch is one base geometry, so the split is:
 * one cone batch per quantized ratio, one disk batch, one top-ball batch.
 *
 * Two offsets only exist here, never in the producer:
 *
 * - `ROOT_RENDER_LIFT_MM`: the whole stack rides the lift together, so its own
 *   faces keep their spacing and only the disk's bottom leaves the plate.
 * - `Rx(90°)`: the disk and cone cylinders are authored Y-up and stood up onto
 *   the plate's Z axis. The top ball is a sphere, so it keeps the identity
 *   rotation.
 *
 * Hover and marquee are **colour only**: the legacy overlays drew the same
 * geometry at the same transform, so there is no matrix scale to write.
 */

/** One scratch matrix, colour and vectors: a layout pass is synchronous and never re-enters. */
const scratchMatrix = new THREE.Matrix4();
const scratchPosition = new THREE.Vector3();
const scratchScale = new THREE.Vector3();
const scratchColor = new THREE.Color();

/**
 * `Rx(90°)`: the cylinder templates are Y-up and must stand on the plate's Z
 * axis. The same rotation `InstancedRootsGroup` builds once.
 */
const ROOT_ROTATION = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(1, 0, 0),
  Math.PI / 2,
);

/** The identity rotation the top ball is drawn with. */
const IDENTITY_ROTATION = new THREE.Quaternion();

/** The batch key of the disk batch, which every root contributes to. */
export const ROOT_DISK_BATCH_KEY = 'disk';

/** The batch key of the top-ball batch, which only cone-bearing roots contribute to. */
export const ROOT_SPHERE_BATCH_KEY = 'sphere';

/**
 * The state one root slot can be drawn in; the palette is the joint batch's.
 *
 * `base` is whatever colour the slot list resolved for the support. `hover`
 * lifts that colour by 0.12; `marquee` is the bulk colour lifted the same way.
 */
export type InstancedRootVisualState = InstancedJointVisualState;

/**
 * The data word every root instance carries: drawn, and typed as a root.
 *
 * Roots carry no profile or segment field: which primitives exist is the mount
 * decision (`record.coneInstance`), not a per-instance state. Hover/marquee is
 * carried by the colour attribute.
 */
export const ROOT_SLOT_DATA = packInstanceFlags({
  visible: true,
  type: INSTANCE_TYPE_ROOT,
});

/**
 * Write one root's disk transform: a `bottomRadius` cylinder of `diskHeight`,
 * lifted off the plate and stood on Z.
 *
 * The z offset is `lift + diskHeight / 2` from the plate contact point, which is
 * the legacy group's expression verbatim. The scale clamps the height at
 * 0.001 mm exactly where `rootInstanceScales` does; the position uses the
 * produced height, so a vanishingly thin disk still sits on the plate rather
 * than at half its authored depth.
 */
export function writeRootDiskMatrix(
  batch: SupportInstanceBatch,
  instance: number,
  slot: { basePos: { x: number; y: number; z: number }; bottomRadius: number; diskHeight: number },
  lift = ROOT_RENDER_LIFT_MM,
): void {
  scratchPosition.set(
    slot.basePos.x,
    slot.basePos.y,
    slot.basePos.z + lift + slot.diskHeight / 2,
  );
  const bottomRadius = Math.max(0.001, slot.bottomRadius);
  scratchScale.set(bottomRadius, Math.max(0.001, slot.diskHeight), bottomRadius);
  scratchMatrix.compose(scratchPosition, ROOT_ROTATION, scratchScale);
  batch.setMatrix(instance, scratchMatrix);
}

/**
 * Write one root's base-cone transform: the frustum from the disk's top face to
 * the top ball's centre.
 *
 * The template's small radius is on `+y` (`CylinderGeometry(ratio, 1, 1, 10)`
 * stood up by `Rx(90°)`), so the footprint is at the bottom and the shaft-side
 * radius at the top — the opposite sense from a contact cone.
 */
export function writeRootConeMatrix(
  batch: SupportInstanceBatch,
  instance: number,
  slot: { basePos: { x: number; y: number; z: number }; bottomRadius: number; diskHeight: number; coneHeight: number },
  lift = ROOT_RENDER_LIFT_MM,
): void {
  scratchPosition.set(
    slot.basePos.x,
    slot.basePos.y,
    slot.basePos.z + lift + slot.diskHeight + slot.coneHeight / 2,
  );
  const bottomRadius = Math.max(0.001, slot.bottomRadius);
  scratchScale.set(bottomRadius, Math.max(0.001, slot.coneHeight), bottomRadius);
  scratchMatrix.compose(scratchPosition, ROOT_ROTATION, scratchScale);
  batch.setMatrix(instance, scratchMatrix);
}

/**
 * Write one root's top-ball transform: a `topRadius` sphere centred on the base
 * cone's small end, unrotated.
 */
export function writeRootSphereMatrix(
  batch: SupportInstanceBatch,
  instance: number,
  slot: { basePos: { x: number; y: number; z: number }; topRadius: number; diskHeight: number; coneHeight: number },
  lift = ROOT_RENDER_LIFT_MM,
): void {
  scratchPosition.set(
    slot.basePos.x,
    slot.basePos.y,
    slot.basePos.z + lift + slot.diskHeight + slot.coneHeight,
  );
  const topRadius = Math.max(0.001, slot.topRadius);
  scratchScale.set(topRadius, topRadius, topRadius);
  scratchMatrix.compose(scratchPosition, IDENTITY_ROTATION, scratchScale);
  batch.setMatrix(instance, scratchMatrix);
}

function writeDiskInstance(
  batch: SupportInstanceBatch,
  record: RootSlotRecord,
  state: InstancedRootVisualState,
): void {
  writeRootDiskMatrix(batch, record.diskInstance, record.slot);
  const color = resolveInstancedVisualColor(record.color, state, scratchColor);
  batch.setColor(record.diskInstance, color.r, color.g, color.b);
  batch.setRatio(record.diskInstance, 1);
  batch.setData(record.diskInstance, ROOT_SLOT_DATA);
}

function writeConeInstance(
  batch: SupportInstanceBatch,
  record: RootConedSlotRecord,
  state: InstancedRootVisualState,
): void {
  const instance = record.coneInstance;
  writeRootConeMatrix(batch, instance, record.slot);
  const color = resolveInstancedVisualColor(record.color, state, scratchColor);
  batch.setColor(instance, color.r, color.g, color.b);
  batch.setRatio(instance, record.ratio);
  batch.setData(instance, ROOT_SLOT_DATA);
}

function writeSphereInstance(
  batch: SupportInstanceBatch,
  record: RootConedSlotRecord,
  state: InstancedRootVisualState,
): void {
  const instance = record.sphereInstance;
  writeRootSphereMatrix(batch, instance, record.slot);
  const color = resolveInstancedVisualColor(record.color, state, scratchColor);
  batch.setColor(instance, color.r, color.g, color.b);
  batch.setRatio(instance, 1);
  batch.setData(instance, ROOT_SLOT_DATA);
}

/** Narrow a slot to one that owns a base cone and a top ball. */
function isConed(record: RootSlotRecord): record is RootConedSlotRecord {
  return (
    record.coneInstance !== undefined &&
    record.sphereInstance !== undefined &&
    record.bucketKey !== undefined
  );
}

/**
 * Write one slot's primitives for `state`.
 *
 * `batches` must be the mounted batch set: the disk batch, the top-ball batch
 * and — for a cone-bearing root — the record's cone bucket.
 */
export function writeRootSlot(
  batches: ReadonlyMap<string, SupportInstanceBatch>,
  index: RootSlotIndex,
  id: number,
  state: InstancedRootVisualState,
): void {
  const record = rootRecordAt(index, id);
  writeDiskInstance(requireBatch(batches, ROOT_DISK_BATCH_KEY), record, state);
  if (isConed(record)) {
    writeConeInstance(requireBatch(batches, record.bucketKey), record, state);
    writeSphereInstance(requireBatch(batches, ROOT_SPHERE_BATCH_KEY), record, state);
  }
}

/**
 * Rewrite every batch from the slot list, in base state.
 *
 * The caller owns the batch set: one cone batch per `index.buckets` bucket, plus
 * the disk and top-ball batches. After the call every batch in the map draws
 * exactly what the index names — a bucket the index no longer has is emptied
 * rather than left drawing the previous layout's instances.
 *
 * Resizing is the batch's own power-of-two reallocation, which replaces
 * attribute objects on a stable geometry — the mesh, its material and the GPU
 * pick registration never remount because a count changed.
 */
export function writeAllRootSlots(
  index: RootSlotIndex,
  batches: ReadonlyMap<string, SupportInstanceBatch>,
): void {
  const used = new Set<string>();

  if (index.disks.length > 0) {
    const batch = requireBatch(batches, ROOT_DISK_BATCH_KEY);
    used.add(ROOT_DISK_BATCH_KEY);
    batch.resizeTo(index.disks.length, ROOT_SLOT_DATA, 1);
    for (const record of index.disks) writeDiskInstance(batch, record, 'base');
  }

  if (index.spheres.length > 0) {
    const batch = requireBatch(batches, ROOT_SPHERE_BATCH_KEY);
    used.add(ROOT_SPHERE_BATCH_KEY);
    batch.resizeTo(index.spheres.length, ROOT_SLOT_DATA, 1);
    for (const record of index.spheres) writeSphereInstance(batch, record, 'base');
  }

  for (const bucket of index.buckets) {
    const batch = requireBatch(batches, bucket.key);
    used.add(bucket.key);
    batch.resizeTo(bucket.records.length, ROOT_SLOT_DATA, bucket.ratio);
    for (const record of bucket.records) writeConeInstance(batch, record, 'base');
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
 * Only non-base slots are in the map: `diffRootSlotStates` treats an absent
 * entry as `base`, so a hover that ends is one deletion rather than a write of
 * every unchanged slot.
 *
 * Marquee wins over hover, exactly as the legacy overlay order did.
 */
export function computeRootSlotStates(
  index: RootSlotIndex,
  hoveredSupportId: string | null | undefined,
  marqueeSupportIds: readonly string[],
): Map<number, InstancedRootVisualState> {
  const states = new Map<number, InstancedRootVisualState>();

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
export type RootSlotStateChange = {
  id: number;
  state: InstancedRootVisualState;
};

/**
 * The slots whose state differs between two maps, ascending by slot id.
 *
 * A hover writes the slots it changed and nothing else; this is the difference
 * that keeps a hovered support's root from costing a full-batch upload.
 */
export function diffRootSlotStates(
  previous: ReadonlyMap<number, InstancedRootVisualState>,
  next: ReadonlyMap<number, InstancedRootVisualState>,
): RootSlotStateChange[] {
  const candidates: number[] = [];
  for (const id of previous.keys()) candidates.push(id);
  for (const id of next.keys()) {
    if (!previous.has(id)) candidates.push(id);
  }
  candidates.sort((a, b) => a - b);

  const changes: RootSlotStateChange[] = [];
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
export function applyRootSlotStateChanges(
  index: RootSlotIndex,
  changes: readonly RootSlotStateChange[],
  batches: ReadonlyMap<string, SupportInstanceBatch>,
): void {
  for (const change of changes) {
    writeRootSlot(batches, index, change.id, change.state);
  }
}

function rootRecordAt(index: RootSlotIndex, id: number): RootSlotRecord {
  const record = index.slots[id];
  if (!record) {
    throw new RangeError(`rootSlotBatch: slot ${id} is outside 0..${index.slots.length - 1}`);
  }
  return record;
}

/** The batch a key names, or a loud failure: the index is the batch set's source. */
function requireBatch(
  batches: ReadonlyMap<string, SupportInstanceBatch>,
  key: string,
): SupportInstanceBatch {
  const batch = batches.get(key);
  if (!batch) throw new Error(`rootSlotBatch: no batch for "${key}"`);
  return batch;
}
