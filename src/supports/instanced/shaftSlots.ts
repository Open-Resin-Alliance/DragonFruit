import { splitBatchedShafts } from '../Curves/batchedBezierTubeGeometry';
import {
  isTaperedShaft,
  TAPER_RATIO_BUCKETS_PER_UNIT,
  type InstancedShaft,
} from '../SupportPrimitives/Shaft/InstancedShaftGroup';
import type { Vec3 } from '../types';
import { quantizeToScale } from '@/utils/math';

/**
 * The shaft batches SupportRenderer already resolved, flattened into the records
 * a capacity batch draws — and the curves it does not.
 *
 * The input is the producer's own output (`sceneBatchedShaftGroupsByType` and
 * `sceneBatchedBraceShaftGroups`) in registry order, so this module never
 * filters: model visibility, selected/ghosted exclusion, the model drop offset
 * and the per-support colour have all been applied. A second filter here would
 * be a second answer to the same question.
 *
 * Two things the producer does *not* resolve, and this pass must:
 *
 * 1. **Zero-length entries are not drawn.** `splitBatchedShafts` drops them (a
 *    leaf has no shaft at all), and the instance id has to be the drawn
 *    instance: a slot list built before that split resolves every later hit to a
 *    neighbouring support. So the split runs here, first, and its output is the
 *    only thing converted.
 * 2. **Straight and tapered shapes cannot share one batch.** `SupportInstanceBatch`
 *    draws one base geometry, so a taper is a second geometry — one bucket per
 *    quantized end-to-end ratio, exactly as `InstancedShaftGroup` already keys
 *    them. The ratio itself rides on `iRatio` as well, so a later shader taper is
 *    a material swap rather than a re-layout.
 *
 * Curved shafts are *not* converted to instances: they are merged into one tube
 * per colour. `curvedByColor` keeps the producer's shaft objects themselves,
 * because the tube builder caches a shaft's geometry by object identity and
 * because a merged tube has no per-instance transform to write.
 */

/** One colour group of resolved shafts, as the producer emits it. */
export type ShaftSlotGroup = {
  color: string;
  shafts: readonly InstancedShaft[];
};

/** Which batch draws a slot. */
export type ShaftBatchKind = 'straight' | 'tapered';

/**
 * One batch-drawn shaft, fully resolved.
 *
 * `start`/`end` are copies: the producer's vectors and the scene's live drag
 * previews must never alias a record the batch already wrote. Positions are
 * already in scene space (the model drop offset is baked in by the producer) —
 * nothing here re-applies it.
 */
export type ShaftBatchSlot = {
  id: string;
  supportId: string;
  modelId?: string;
  start: Vec3;
  end: Vec3;
  /** Width at `start`, in millimetres — the drawn diameter. */
  diameter: number;
  /** Width at `end`; equal to `diameter` for a straight slot. */
  diameterEnd: number;
};

/**
 * A slot plus where it is drawn.
 *
 * `id` is the record's index in `ShaftSlotIndex.slots`, and the key every state
 * map and diff is expressed in. `instance` is the index inside the one batch
 * that draws it — dense within that batch, so `instance` is what a pointer event
 * reports and what the writer writes.
 */
export type ShaftSlotRecord = {
  id: number;
  kind: ShaftBatchKind;
  instance: number;
  /** Taper bucket key; absent for a straight slot. */
  bucketKey?: string;
  /** End/start diameter ratio the instance is drawn with; 1 for a straight slot. */
  ratio: number;
  slot: ShaftBatchSlot;
  /** The group colour the slot was produced under. */
  color: string;
};

/**
 * Tapered slots sharing one quantized end-to-end ratio, which one instanced cone
 * draws.
 *
 * A cone of radius `ratio` over radius 1 scales to any width and length, so a
 * ratio is all a bucket needs — the same shape-keyed batching the roots use.
 */
export type ShaftTaperBucket = {
  /** `String(ratio)`, so it matches `InstancedShaftGroup`'s own bucket key. */
  key: string;
  ratio: number;
  /** Records in instance order: `slots[i]` is the record drawn at instance i. */
  slots: ShaftSlotRecord[];
};

/** Which batch and instance draws a primitive. */
export type ShaftSlotRef =
  | { kind: 'straight'; id: number; instance: number }
  | { kind: 'tapered'; id: number; instance: number; bucket: string }
  /** Index into the merged tube of `curvedByColor.get(color)`. */
  | { kind: 'curved'; color: string; instance: number };

export type ShaftSlotIndex = {
  /** Every batch-drawn slot in producer order; `id` is the position in this list. */
  slots: ShaftSlotRecord[];
  /** Dense straight slots: `straight[i]` is instance i of the straight batch. */
  straight: ShaftSlotRecord[];
  /** One entry per distinct quantized taper ratio, in first-seen order. */
  tapered: ShaftTaperBucket[];
  /** The producer's curved shafts by group colour, in producer order. */
  curvedByColor: Map<string, InstancedShaft[]>;
  /**
   * Support id to the global ids of its batch-drawn slots, ascending.
   *
   * Curves are absent on purpose: a merged tube has one material, so its
   * highlight stays with the legacy curved overlay rather than an instance
   * write.
   */
  bySupport: Map<string, number[]>;
  /** Primitive id to the batch and instance that draws it; a repeated id keeps the last. */
  byPrimitive: Map<string, ShaftSlotRef>;
  /** Instance totals, which is all a consumer needs to decide "nothing to draw". */
  counts: { straight: number; tapered: number; curved: number };
};

/**
 * A tapered shaft's end-to-start ratio, quantized the way the legacy bucket
 * groups it.
 *
 * This is `InstancedShaftGroup`'s expression verbatim (its `TAPER_RATIO_STEP`
 * of 0.05, i.e. 20 buckets per ratio unit): 0.05 is a 2.5 % end-radius error —
 * microns at print scale — and it is what keeps the bucket count a handful
 * instead of one per shaft. Bundles that rendered at the same ratio must keep
 * landing in the same bucket, so the constant is imported, not repeated.
 *
 * A diameter of zero has no ratio to speak of; the divisor is guarded so the
 * record carries a finite, positive ratio rather than infinity.
 */
export function shaftTaperRatio(shaft: { diameter: number; diameterEnd?: number }): number {
  if (!(shaft.diameter > 0)) return 1;
  return quantizeToScale(
    (shaft.diameterEnd ?? shaft.diameter) / shaft.diameter,
    TAPER_RATIO_BUCKETS_PER_UNIT,
  );
}

export function buildShaftSlotIndex(
  groups: ReadonlyArray<ShaftSlotGroup>,
): ShaftSlotIndex {
  const slots: ShaftSlotRecord[] = [];
  const straight: ShaftSlotRecord[] = [];
  const tapered: ShaftTaperBucket[] = [];
  const bucketByKey = new Map<string, ShaftTaperBucket>();
  const curvedByColor = new Map<string, InstancedShaft[]>();
  const bySupport = new Map<string, number[]>();
  const byPrimitive = new Map<string, ShaftSlotRef>();

  let taperedCount = 0;
  let curvedCount = 0;

  for (const group of groups) {
    const { color } = group;
    const { straightShafts, curvedShafts } = splitBatchedShafts(group.shafts);

    if (curvedShafts.length > 0) {
      // Same colour, several groups: the tube mesh is one per colour, so the
      // lists merge and the instance index keeps counting across them.
      let merged = curvedByColor.get(color);
      if (!merged) {
        merged = [];
        curvedByColor.set(color, merged);
      }
      for (const shaft of curvedShafts) {
        byPrimitive.set(shaft.id, { kind: 'curved', color, instance: merged.length });
        merged.push(shaft);
        curvedCount += 1;
      }
    }

    for (const shaft of straightShafts) {
      // A shaft with no owning support is grouped under its own id, as the joint
      // slot list does: one support's worth of geometry, never an empty shared key.
      const supportId = shaft.supportId ?? shaft.id;
      const slot: ShaftBatchSlot = {
        id: shaft.id,
        supportId,
        // Copied, not referenced: the producer's vectors and the scene's live
        // drag previews must never alias a record the batch already wrote.
        start: { x: shaft.start.x, y: shaft.start.y, z: shaft.start.z },
        end: { x: shaft.end.x, y: shaft.end.y, z: shaft.end.z },
        diameter: shaft.diameter,
        diameterEnd: shaft.diameterEnd ?? shaft.diameter,
        ...(shaft.modelId !== undefined ? { modelId: shaft.modelId } : {}),
      };
      const id = slots.length;

      let record: ShaftSlotRecord;
      if (isTaperedShaft(shaft)) {
        const ratio = shaftTaperRatio(shaft);
        // The same string `InstancedShaftGroup` keys its own taper buckets on.
        const key = String(ratio);
        let bucket = bucketByKey.get(key);
        if (!bucket) {
          bucket = { key, ratio, slots: [] };
          bucketByKey.set(key, bucket);
          tapered.push(bucket);
        }
        record = { id, kind: 'tapered', instance: bucket.slots.length, bucketKey: key, ratio, slot, color };
        bucket.slots.push(record);
        taperedCount += 1;
        byPrimitive.set(shaft.id, { kind: 'tapered', id, instance: record.instance, bucket: key });
      } else {
        record = { id, kind: 'straight', instance: straight.length, ratio: 1, slot, color };
        straight.push(record);
        byPrimitive.set(shaft.id, { kind: 'straight', id, instance: record.instance });
      }

      slots.push(record);

      const supportSlots = bySupport.get(supportId);
      if (supportSlots) supportSlots.push(id);
      else bySupport.set(supportId, [id]);
    }
  }

  return {
    slots,
    straight,
    tapered,
    curvedByColor,
    bySupport,
    byPrimitive,
    counts: { straight: straight.length, tapered: taperedCount, curved: curvedCount },
  };
}
