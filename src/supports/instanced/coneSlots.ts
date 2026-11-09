import {
  CONE_RATIO_BUCKETS_PER_UNIT,
  coneShapeRatio,
  getDiskThicknessForCone,
  getProfileType,
  type InstancedContactCone,
} from '../SupportPrimitives/ContactCone/InstancedContactConeGroup';
import type { Vec3 } from '../types';
import { quantizeToScale } from '@/utils/math';

/**
 * The contact cones SupportRenderer already resolved, flattened into the records
 * a capacity batch draws.
 *
 * The input is the producer's own output (`sceneBatchedContactConeGroups`) in
 * registry order, so this module never filters for model visibility, selected
 * supports, scenery, or the model drop offset: all of that has been applied. A
 * second filter here would be a second answer to the same question.
 *
 * Two things the producer does *not* resolve, and this pass must:
 *
 * 1. **Degenerate normals are dropped.** `InstancedContactConeGroup` filters
 *    `|normal|² <= 1e-8` before it buckets (`validCones`), because the axis
 *    quaternion is `setFromUnitVectors` and a zero vector produces NaN. A slot
 *    list built without that filter writes NaN matrices.
 * 2. **The shape ratio is a geometry, so it is a batch.** A body frustum scaled
 *    by `(r, h, r)` keeps its end radii, so the body/contact ratio lives in the
 *    geometry and each quantized ratio is its own batch. The bucket's geometry
 *    ratio is the **first-seen raw** ratio, exactly as the legacy group stores
 *    it — not the quantized key value. Root cones are the opposite (quantized
 *    geometry ratio); see `rootSlots.ts`.
 *
 * Penetration is deliberately **not** in this index. It is a subscription to the
 * material profile (`calculateTipOffset`) rather than scene state, so the
 * *writer* takes a resolver: a rebuilt index and a changed material setting
 * cannot disagree about a nib's depth. Everything else a write needs is here.
 */

/** One colour group of resolved cones, as the producer emits it. */
export type ConeSlotGroup = {
  color: string;
  cones: readonly InstancedContactCone[];
};

/** The three contact-primitive shapes a cone can be. */
export type ConeProfileKind = 'disk' | 'sphere' | 'legacy';

/**
 * One batch-drawn cone, fully resolved.
 *
 * `pos`/`normal`/`surfaceNormal` are copies: the producer's vectors and the
 * scene's live drag previews must never alias a record the batch already wrote.
 * `surfaceNormal` is the *effective* one (`cone.surfaceNormal ?? cone.normal`),
 * so a writer never repeats the fallback. Positions are already in scene space —
 * the model drop offset is baked in by the producer, and nothing here re-applies
 * it.
 */
export type ConeBatchSlot = {
  id: string;
  supportId: string;
  modelId?: string;
  /** Contact point on the model surface. */
  pos: Vec3;
  /** Cone axis, pointing into the model. */
  normal: Vec3;
  /** Effective surface normal: the disk's alignment axis. */
  surfaceNormal: Vec3;
  /** Which contact primitive this cone draws. */
  kind: ConeProfileKind;
  /** Head length, excluding any primitive offset. */
  lengthMm: number;
  /** Drawn radius at the contact end: `max(0.001, contactDiameterMm / 2)`. */
  contactRadius: number;
  /** Nib thickness along `surfaceNormal`; 0 for non-disk profiles. */
  diskThickness: number;
  /**
   * The cone's authored embed depth, which is the fallback a nib is sunk by when
   * the active material does not compute one. The *computed* depth is a writer
   * input (`contactPenetration.ts`), never part of this record.
   */
  penetrationMm: number;
};

/**
 * A slot plus the instance each of its primitives is drawn at.
 *
 * `id` is the record's index in `ConeSlotIndex.slots`, and the key every state
 * map and diff is expressed in. `bodyInstance` is dense *within its bucket*,
 * `tipInstance` and `diskInstance` are dense across the whole index — each is
 * what a pointer event on that mesh reports and what the writer writes.
 *
 * `bodyRatio` is the bucket's geometry ratio (the first-seen raw ratio), not
 * this cone's own: the drawn socket radius is `bodyRatio * contactRadius`, so a
 * record that carried its own raw ratio would disagree with its mesh.
 */
export type ConeSlotRecord = {
  id: number;
  slot: ConeBatchSlot;
  /** The group colour the slot was produced under. */
  color: string;
  kind: ConeProfileKind;
  /** Body batch key: `String(quantizeToScale(coneShapeRatio(cone), 10))`. */
  bodyBucket: string;
  /** The bucket's geometry ratio, which is also this instance's `iRatio`. */
  bodyRatio: number;
  bodyInstance: number;
  tipInstance: number;
  /** Present only for a `disk` profile, which is the only kind with a nib. */
  diskInstance?: number;
};

/**
 * A slot with a nib. `disks` holds only these, so a disk write never needs an
 * optional-chain guard.
 */
export type ConeDiskSlotRecord = ConeSlotRecord & { diskInstance: number };

/**
 * Cones sharing one quantized body/contact ratio, which one frustum geometry
 * draws.
 *
 * All three profile kinds merge here: the profile changes *which* primitives are
 * mounted, never the body's geometry, so splitting the bucket by profile would
 * multiply draw calls for nothing.
 */
export type ConeBodyBucket = {
  key: string;
  /** The first-seen raw ratio this bucket's geometry is built with. */
  ratio: number;
  /** Records in instance order: `records[i]` is drawn at body instance i. */
  records: ConeSlotRecord[];
};

export type ConeSlotIndex = {
  /** Every batch-drawn cone in producer order; `id` is the position in this list. */
  slots: ConeSlotRecord[];
  /** One entry per distinct quantized ratio, in first-seen order. */
  bodies: ConeBodyBucket[];
  /** Dense tip balls: `tips[i]` is drawn at tip instance i. Every slot has one. */
  tips: ConeSlotRecord[];
  /** Dense nibs: `disks[i]` is drawn at disk instance i. Disk profiles only. */
  disks: ConeDiskSlotRecord[];
  /** Support id to the global ids of its slots, ascending. A stick has two. */
  bySupport: Map<string, number[]>;
  /** Contact-disk id to the global id of the slot that draws it. */
  byPrimitive: Map<string, number>;
  /**
   * Instance totals, which is all a consumer needs to decide "nothing to draw"
   * and which optional meshes to mount. `bodies` is one per slot; the number of
   * body *batches* is `bodies.length`.
   */
  counts: { bodies: number; tips: number; disks: number };
};

export function buildConeSlotIndex(
  groups: ReadonlyArray<ConeSlotGroup>,
): ConeSlotIndex {
  const slots: ConeSlotRecord[] = [];
  const bodies: ConeBodyBucket[] = [];
  const bodyByKey = new Map<string, ConeBodyBucket>();
  const tips: ConeSlotRecord[] = [];
  const disks: ConeDiskSlotRecord[] = [];
  const bySupport = new Map<string, number[]>();
  const byPrimitive = new Map<string, number>();

  for (const group of groups) {
    const { color } = group;

    for (const cone of group.cones) {
      // `InstancedContactConeGroup`'s `validCones` verbatim. The comparison also
      // rejects a NaN component, which a plain `> 1e-8` would let through.
      const normalLenSq =
        cone.normal.x * cone.normal.x +
        cone.normal.y * cone.normal.y +
        cone.normal.z * cone.normal.z;
      if (!(normalLenSq > 1e-8)) continue;

      const kind = getProfileType(cone.profile);
      const surfaceNormal = cone.surfaceNormal ?? cone.normal;
      const rawRatio = coneShapeRatio(cone);
      // The legacy group's bucket key, minus its profile prefix: the body
      // geometry is profile-independent, so the profile does not split the batch.
      const key = String(quantizeToScale(rawRatio, CONE_RATIO_BUCKETS_PER_UNIT));

      let bucket = bodyByKey.get(key);
      if (!bucket) {
        bucket = { key, ratio: rawRatio, records: [] };
        bodyByKey.set(key, bucket);
        bodies.push(bucket);
      }

      // A cone with no owning support is grouped under its own id, as the joint
      // and shaft slot lists do: one support's worth of geometry, never an empty
      // shared key.
      const supportId = cone.supportId ?? cone.id;
      const slot: ConeBatchSlot = {
        id: cone.id,
        supportId,
        // Copied, not referenced: see the type's note on aliasing.
        pos: { x: cone.pos.x, y: cone.pos.y, z: cone.pos.z },
        normal: { x: cone.normal.x, y: cone.normal.y, z: cone.normal.z },
        surfaceNormal: {
          x: surfaceNormal.x,
          y: surfaceNormal.y,
          z: surfaceNormal.z,
        },
        kind,
        lengthMm: cone.profile.lengthMm,
        contactRadius: Math.max(0.001, cone.profile.contactDiameterMm / 2),
        // The same call the legacy group makes, so an override or an angled
        // standoff resolves to the identical thickness.
        diskThickness: getDiskThicknessForCone(cone),
        penetrationMm: cone.profile.penetrationMm ?? 0,
        ...(cone.modelId !== undefined ? { modelId: cone.modelId } : {}),
      };

      const id = slots.length;
      const base = {
        id,
        slot,
        color,
        kind,
        bodyBucket: key,
        // After the bucket exists, this is the first-seen raw ratio — including
        // for the cones that created it.
        bodyRatio: bucket.ratio,
        bodyInstance: bucket.records.length,
        tipInstance: tips.length,
      };
      let record: ConeSlotRecord;
      if (kind === 'disk') {
        const diskRecord: ConeDiskSlotRecord = { ...base, diskInstance: disks.length };
        record = diskRecord;
        disks.push(diskRecord);
      } else {
        record = base;
      }

      bucket.records.push(record);
      tips.push(record);
      slots.push(record);

      const supportSlots = bySupport.get(supportId);
      if (supportSlots) supportSlots.push(id);
      else bySupport.set(supportId, [id]);

      byPrimitive.set(cone.id, id);
    }
  }

  return {
    slots,
    bodies,
    tips,
    disks,
    bySupport,
    byPrimitive,
    counts: { bodies: slots.length, tips: tips.length, disks: disks.length },
  };
}
