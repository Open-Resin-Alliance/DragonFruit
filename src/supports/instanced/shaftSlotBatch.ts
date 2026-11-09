import * as THREE from 'three';

import { HIDDEN_INSTANCE_MATRIX } from '../SupportPrimitives/hiddenInstanceMatrix';
import {
  INSTANCE_SEG_KIND_STRAIGHT,
  INSTANCE_SEG_KIND_TAPERED,
  INSTANCE_TYPE_SHAFT,
  packInstanceFlags,
} from './instanceFlags';
import {
  resolveJointVisualColor as resolveInstancedVisualColor,
  type InstancedJointVisualState,
} from './instancedPalette';
import type { ShaftSlotIndex, ShaftSlotRecord } from './shaftSlots';
import type { SupportInstanceBatch } from './supportInstanceBatch';

/**
 * The writes that turn a `ShaftSlotIndex` into one batch per shape.
 *
 * Kept out of the component so the geometry/colour/state mapping is a pure
 * function of the slot list, and so the per-frame writer a later drag pass needs
 * (`writeShaftSlotMatrix`) exists before there is a drag to feed it.
 *
 * One batch is one base geometry (`SupportInstanceBatch` copies exactly one
 * shape), so the index's shape split is also the batch split: `straight` draws
 * the unit cylinder, each taper bucket draws its own `ratio`-topped cone. The
 * batch a record belongs to is `record.bucketKey ?? SHAFT_STRAIGHT_BATCH_KEY`.
 */

/** One scratch matrix and colour: a layout pass is synchronous and never re-enters. */
const scratchMatrix = new THREE.Matrix4();
const scratchPosition = new THREE.Vector3();
const scratchScale = new THREE.Vector3();
const scratchDirection = new THREE.Vector3();
const scratchQuaternion = new THREE.Quaternion();
const scratchColor = new THREE.Color();

/** The upward axis of the unit cylinder template, which `+y` maps to `end`. */
const UP = new THREE.Vector3(0, 1, 0);

/**
 * A shaft shorter than this is not drawn, exactly as `InstancedShaftGroup`
 * draws it: the instance keeps its slot and costs no pixels.
 */
const MIN_SHAFT_LENGTH = 0.001;

/** The batch key of the straight batch; a taper bucket is keyed by its ratio string. */
export const SHAFT_STRAIGHT_BATCH_KEY = 'straight';

/**
 * The hover/marquee overlays draw a shaft at `diameter * 1.02`, so a highlighted
 * shaft is measurably thicker, not just brighter.
 *
 * The length is untouched (`SupportRenderer` scales `diameter` only), so the
 * scale multiplies the two radial axes and leaves the axis along the segment
 * alone — and a tapered slot's end/start ratio therefore stays the bucket's.
 */
export const SHAFT_HOVER_DIAMETER_SCALE = 1.02;

/** The three states one shaft slot can be drawn in; the palette is the joint batch's. */
export type InstancedShaftVisualState = InstancedJointVisualState;

/** The diameter multiplier a state is drawn with. */
export function shaftVisualScale(state: InstancedShaftVisualState): number {
  return state === 'base' ? 1 : SHAFT_HOVER_DIAMETER_SCALE;
}

/**
 * The data word every straight shaft slot carries: drawn, a shaft, and a
 * straight segment.
 *
 * Nothing reads this yet — step 2 has no integer-attribute shader — but it keeps
 * the word truthful for the flag writer and the GPU pick pass that follow.
 * Hover/marquee state is *not* written here: it rides on the colour attribute
 * and the matrix scale, which one lit draw can read per instance.
 */
export const SHAFT_STRAIGHT_SLOT_DATA = packInstanceFlags({
  visible: true,
  type: INSTANCE_TYPE_SHAFT,
  segKind: INSTANCE_SEG_KIND_STRAIGHT,
});

/** The data word a tapered slot carries: the same bits, with the cone's segment kind. */
export const SHAFT_TAPERED_SLOT_DATA = packInstanceFlags({
  visible: true,
  type: INSTANCE_TYPE_SHAFT,
  segKind: INSTANCE_SEG_KIND_TAPERED,
});

/**
 * Write one shaft's transform: the unit shape stretched from `start` to `end`.
 *
 * The composition is `InstancedShaftGroup`'s verbatim — midpoint, `+y` rotated
 * onto the segment, scale `(diameter, length, diameter)` — so a straight shaft
 * lands exactly where the legacy instanced mesh drew it, and a tapered one lands
 * the way its bucket's `(ratio, 1)` cone template expects.
 *
 * `scale` widens the shaft radially (`1.02` for the hover/marquee lift) and never
 * lengthens it. Positions are already in scene space: the slot list is built
 * from groups that applied the model drop offset, so applying it again here
 * would double it.
 */
export function writeShaftSlotMatrix(
  batch: SupportInstanceBatch,
  instance: number,
  slot: { start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number }; diameter: number },
  scale = 1,
): void {
  scratchDirection.set(
    slot.end.x - slot.start.x,
    slot.end.y - slot.start.y,
    slot.end.z - slot.start.z,
  );
  const length = scratchDirection.length();
  if (length < MIN_SHAFT_LENGTH) {
    batch.setMatrix(instance, HIDDEN_INSTANCE_MATRIX);
    return;
  }
  scratchDirection.divideScalar(length);
  scratchPosition.set(
    (slot.start.x + slot.end.x) * 0.5,
    (slot.start.y + slot.end.y) * 0.5,
    (slot.start.z + slot.end.z) * 0.5,
  );
  scratchQuaternion.setFromUnitVectors(UP, scratchDirection);
  scratchScale.set(slot.diameter * scale, length, slot.diameter * scale);
  scratchMatrix.compose(scratchPosition, scratchQuaternion, scratchScale);
  batch.setMatrix(instance, scratchMatrix);
}

/**
 * Write one slot's transform, colour, ratio and data word for `state`.
 *
 * `batch` must be the batch that draws the slot (straight, or the slot's taper
 * bucket); `id` is the slot's index in `index.slots`, and the instance written is
 * the record's own instance index. Colours come from the group the slot was
 * produced under — the producer already resolved model colour, dimming, bulk
 * selection and origin debug colours into it — and the highlight states are the
 * instanced palette's approximation of the overlays: hover lifts that colour by
 * 0.12, marquee is the bulk colour lifted the same way.
 */
export function writeShaftSlot(
  batch: SupportInstanceBatch,
  index: ShaftSlotIndex,
  id: number,
  state: InstancedShaftVisualState,
): void {
  const record = slotRecordAt(index, id);
  writeShaftSlotMatrix(batch, record.instance, record.slot, shaftVisualScale(state));
  const color = resolveInstancedVisualColor(record.color, state, scratchColor);
  batch.setColor(record.instance, color.r, color.g, color.b);
  batch.setRatio(record.instance, record.ratio);
  batch.setData(
    record.instance,
    record.kind === 'tapered' ? SHAFT_TAPERED_SLOT_DATA : SHAFT_STRAIGHT_SLOT_DATA,
  );
}

/**
 * Rewrite every batch from the slot list, in base state.
 *
 * The caller owns the batch set: one straight batch under
 * `SHAFT_STRAIGHT_BATCH_KEY` plus one per `index.tapered` bucket. After the call
 * every batch in the map draws exactly what the index names — a batch for a
 * taper bucket the index no longer has is emptied rather than left drawing the
 * previous layout's instances.
 *
 * Resizing is the batch's own power-of-two reallocation, which replaces
 * attribute objects on a stable geometry — the mesh, its material and the GPU
 * pick registration never remount because a count changed.
 */
export function writeAllShaftSlots(
  index: ShaftSlotIndex,
  batches: ReadonlyMap<string, SupportInstanceBatch>,
): void {
  const straightBatch = index.straight.length > 0
    ? requireBatch(batches, SHAFT_STRAIGHT_BATCH_KEY)
    : batches.get(SHAFT_STRAIGHT_BATCH_KEY);
  if (straightBatch) {
    straightBatch.resizeTo(index.straight.length, SHAFT_STRAIGHT_SLOT_DATA, 1);
    for (const record of index.straight) writeShaftSlot(straightBatch, index, record.id, 'base');
  }

  for (const bucket of index.tapered) {
    const batch = requireBatch(batches, bucket.key);
    batch.resizeTo(bucket.slots.length, SHAFT_TAPERED_SLOT_DATA, bucket.ratio);
    for (const record of bucket.slots) writeShaftSlot(batch, index, record.id, 'base');
  }

  for (const [key, batch] of batches) {
    if (key === SHAFT_STRAIGHT_BATCH_KEY) continue;
    if (index.tapered.some((bucket) => bucket.key === key)) continue;
    batch.resizeTo(0, 0, 1);
  }
}

/**
 * The state every batch-drawn slot should be in, given the support under the
 * pointer and the supports past the first marquee hover.
 *
 * Only non-base slots are in the map: `diffShaftSlotStates` treats an absent
 * entry as `base`, so a hover that ends is one deletion rather than a write of
 * every unchanged slot.
 *
 * Marquee wins over hover, exactly as the legacy overlay order did (the marquee
 * overlay drew over the hover overlay).
 */
export function computeShaftSlotStates(
  index: ShaftSlotIndex,
  hoveredSupportId: string | null | undefined,
  marqueeSupportIds: readonly string[],
): Map<number, InstancedShaftVisualState> {
  const states = new Map<number, InstancedShaftVisualState>();

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
export type ShaftSlotStateChange = {
  id: number;
  state: InstancedShaftVisualState;
};

/**
 * The slots whose state differs between two maps, ascending by slot id.
 *
 * A hover writes the slots it changed and nothing else; this is the difference
 * that keeps a hovered support's shafts from costing a full-batch upload.
 */
export function diffShaftSlotStates(
  previous: ReadonlyMap<number, InstancedShaftVisualState>,
  next: ReadonlyMap<number, InstancedShaftVisualState>,
): ShaftSlotStateChange[] {
  const candidates: number[] = [];
  for (const id of previous.keys()) candidates.push(id);
  for (const id of next.keys()) {
    if (!previous.has(id)) candidates.push(id);
  }
  candidates.sort((a, b) => a - b);

  const changes: ShaftSlotStateChange[] = [];
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
export function applyShaftSlotStateChanges(
  index: ShaftSlotIndex,
  changes: readonly ShaftSlotStateChange[],
  batches: ReadonlyMap<string, SupportInstanceBatch>,
): void {
  for (const change of changes) {
    const record = slotRecordAt(index, change.id);
    const batch = requireBatch(batches, record.bucketKey ?? SHAFT_STRAIGHT_BATCH_KEY);
    writeShaftSlot(batch, index, change.id, change.state);
  }
}

function slotRecordAt(index: ShaftSlotIndex, id: number): ShaftSlotRecord {
  const record = index.slots[id];
  if (!record) {
    throw new RangeError(`shaftSlotBatch: slot ${id} is outside 0..${index.slots.length - 1}`);
  }
  return record;
}

/** The batch a key names, or a loud failure: the index is the batch set's source. */
function requireBatch(
  batches: ReadonlyMap<string, SupportInstanceBatch>,
  key: string,
): SupportInstanceBatch {
  const batch = batches.get(key);
  if (!batch) throw new Error(`shaftSlotBatch: no batch for "${key}"`);
  return batch;
}
