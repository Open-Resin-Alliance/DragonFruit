import * as THREE from 'three';

import { INSTANCE_TYPE_JOINT, packInstanceFlags } from './instanceFlags';
import {
  resolveJointVisualColor,
  jointVisualScale,
  type InstancedJointVisualState,
} from './instancedPalette';
import type { JointSlotIndex } from './jointSlots';
import type { SupportInstanceBatch } from './supportInstanceBatch';

/**
 * The writes that turn a `JointSlotIndex` into one instanced batch.
 *
 * Kept out of the component so the geometry/colour/state mapping is a pure
 * function of the slot list, and so the per-frame writer a later drag pass needs
 * (`writeJointSlotMatrix`) exists before there is a drag to feed it.
 */

/** One scratch matrix and colour: a layout pass is synchronous and never re-enters. */
const scratchMatrix = new THREE.Matrix4();
const scratchColor = new THREE.Color();

/**
 * The data word every joint slot carries: drawn, and typed as a joint.
 *
 * Step 1 has no integer-attribute shader, so nothing reads this yet; the pack
 * keeps the word truthful for the flag writer and the GPU pick pass that come
 * after it. Hover/marquee state is *not* written here — it is carried by the
 * colour attribute and the matrix scale, which one lit draw can read per
 * instance.
 */
const JOINT_SLOT_DATA = packInstanceFlags({ visible: true, type: INSTANCE_TYPE_JOINT });

/**
 * The radius a joint is drawn with, in millimetres.
 *
 * This is `InstancedJointGroup`'s formula verbatim (`Math.max(0.001,
 * diameter * 0.5)`), not `max(0.001, diameter) / 2`: at the 0.001 mm clamp the
 * two differ by a factor of two, and a joint at that clamp must stay the size
 * the legacy batch drew.
 */
export function jointSlotRadius(diameter: number): number {
  return Math.max(0.001, diameter * 0.5);
}

/**
 * Write one slot's transform: a sphere of `diameter` centred on `pos`, scaled by
 * `scale` for the hover/marquee lift.
 *
 * Positions are already in scene space — the slot list is built from
 * `sceneBatchedJointGroups`, which applies the model drop offset before the
 * batch ever sees them. Do not apply it again here.
 *
 * This is the helper a later drag writer calls (joint only, per frame); step 1
 * writes it from the slot list and from the hover/marquee diff.
 */
export function writeJointSlotMatrix(
  batch: SupportInstanceBatch,
  slotIndex: number,
  pos: { x: number; y: number; z: number },
  diameter: number,
  scale = 1,
): void {
  const radius = jointSlotRadius(diameter) * scale;
  scratchMatrix.makeScale(radius, radius, radius);
  scratchMatrix.setPosition(pos.x, pos.y, pos.z);
  batch.setMatrix(slotIndex, scratchMatrix);
}

/** Write one slot's transform and colour for `state`. */
export function writeJointSlot(
  batch: SupportInstanceBatch,
  index: JointSlotIndex,
  slotIndex: number,
  state: InstancedJointVisualState,
): void {
  const slot = index.slots[slotIndex];
  writeJointSlotMatrix(batch, slotIndex, slot.pos, slot.diameter, jointVisualScale(state));
  const color = resolveJointVisualColor(index.colorBySlot[slotIndex], state, scratchColor);
  batch.setColor(slotIndex, color.r, color.g, color.b);
}

/**
 * Move the batch's live count to `count`, growing by append and shrinking from
 * the end.
 *
 * A joint's `iRatio` and data word are the same for every slot, so they are
 * written here (once, by `append`) and never again: a hover or a rebuild only
 * has to touch the matrix and colour attributes. Growth is the batch's own
 * power-of-two reallocation, which replaces attribute objects on a stable
 * geometry — the mesh, its material and the GPU pick registration never remount
 * because the count changed — and the batch drops three's cached instanced-draw
 * cap for it.
 */
export function resizeJointBatch(batch: SupportInstanceBatch, count: number): void {
  batch.resizeTo(count, JOINT_SLOT_DATA, 1);
}

/**
 * Rewrite every slot from the slot list, in base state.
 *
 * Slots are dense and in the producer's draw order, so instance id and slot
 * index are the same number.
 */
export function writeAllJointSlots(batch: SupportInstanceBatch, index: JointSlotIndex): void {
  const count = index.slots.length;
  resizeJointBatch(batch, count);
  for (let slotIndex = 0; slotIndex < count; slotIndex += 1) {
    writeJointSlot(batch, index, slotIndex, 'base');
  }
}

/**
 * The state every slot should be drawn in, given the support under the pointer
 * and the supports past the first marquee hover.
 *
 * Only non-base slots are in the map: `diffJointSlotStates` treats an absent
 * entry as `base`, so a hover that ends is one deletion rather than a write of
 * every unchanged slot.
 *
 * Marquee wins over hover, exactly as the legacy overlay order did (the marquee
 * overlay drew over the hover overlay).
 */
export function computeJointSlotStates(
  index: JointSlotIndex,
  hoveredSupportId: string | null | undefined,
  marqueeSupportIds: readonly string[],
): Map<number, InstancedJointVisualState> {
  const states = new Map<number, InstancedJointVisualState>();

  if (hoveredSupportId) {
    const joints = index.bySupport.get(hoveredSupportId);
    if (joints) {
      for (const slotIndex of joints) states.set(slotIndex, 'hover');
    }
  }

  for (const supportId of marqueeSupportIds) {
    const joints = index.bySupport.get(supportId);
    if (!joints) continue;
    for (const slotIndex of joints) states.set(slotIndex, 'marquee');
  }

  return states;
}

/** One slot whose state changed, in ascending slot order. */
export type JointSlotStateChange = {
  index: number;
  state: InstancedJointVisualState;
};

/**
 * The slots whose state differs between two maps, ascending by slot index.
 *
 * A hover writes the slots it changed and nothing else; this is the difference
 * that keeps a hovered support's joints from costing a full-batch upload.
 */
export function diffJointSlotStates(
  previous: ReadonlyMap<number, InstancedJointVisualState>,
  next: ReadonlyMap<number, InstancedJointVisualState>,
): JointSlotStateChange[] {
  const candidates: number[] = [];
  for (const slotIndex of previous.keys()) candidates.push(slotIndex);
  for (const slotIndex of next.keys()) {
    if (!previous.has(slotIndex)) candidates.push(slotIndex);
  }
  candidates.sort((a, b) => a - b);

  const changes: JointSlotStateChange[] = [];
  for (const slotIndex of candidates) {
    const before = previous.get(slotIndex) ?? 'base';
    const after = next.get(slotIndex) ?? 'base';
    if (before === after) continue;
    changes.push({ index: slotIndex, state: after });
  }
  return changes;
}
