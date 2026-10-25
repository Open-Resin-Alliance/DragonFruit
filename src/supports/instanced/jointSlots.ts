import type { InstancedJoint } from '../SupportPrimitives/Joint/InstancedJointGroup';
import type { JointSlot } from './types';

/**
 * The joint batches SupportRenderer already resolved, flattened into the slot
 * records a single instanced joint batch draws.
 *
 * The input is `sceneBatchedJointGroups`, so this module never filters: model
 * visibility, selected-support exclusion, the leaf host-knot set, the model drop
 * offset and the scene diameter blend have all been applied by the producer. A
 * second filter here would be a second answer to the same question.
 *
 * The slot index is the batch instance id. Group order then joint order are the
 * producer's order, and every index-bearing map points back into `slots`.
 */
export type JointSlotGroup = {
  color: string;
  joints: InstancedJoint[];
};

export type JointSlotIndex = {
  slots: JointSlot[];
  /** Support id to its joint slot indices, ascending in `slots` order. */
  bySupport: Map<string, number[]>;
  /** Joint id to its slot index; a repeated id keeps the last one. */
  byPrimitive: Map<string, number>;
  /** Base colour per slot, mirroring the group the joint came from. */
  colorBySlot: string[];
};

export function buildJointSlotIndex(groups: ReadonlyArray<JointSlotGroup>): JointSlotIndex {
  const slots: JointSlot[] = [];
  const bySupport: Map<string, number[]> = new Map();
  const byPrimitive: Map<string, number> = new Map();
  const colorBySlot: string[] = [];

  for (const group of groups) {
    const { color, joints } = group;

    for (const joint of joints) {
      // A joint with no owning support is grouped under its own id: it is one
      // support's worth of geometry in every later resolution step, and sharing
      // an empty key would put unrelated joints in one group.
      const supportId = joint.supportId ?? joint.id;
      const slot: JointSlot = {
        id: joint.id,
        supportId,
        // Copied, not referenced: the producer's vectors and the scene's live
        // drag previews must never alias a slot the batch already wrote.
        pos: { x: joint.pos.x, y: joint.pos.y, z: joint.pos.z },
        diameter: joint.diameter,
        ...(joint.modelId !== undefined ? { modelId: joint.modelId } : {}),
      };

      const index = slots.push(slot) - 1;
      colorBySlot.push(color);

      const supportSlots = bySupport.get(supportId);
      if (supportSlots) {
        supportSlots.push(index);
      } else {
        bySupport.set(supportId, [index]);
      }

      byPrimitive.set(joint.id, index);
    }
  }

  return { slots, bySupport, byPrimitive, colorBySlot };
}
