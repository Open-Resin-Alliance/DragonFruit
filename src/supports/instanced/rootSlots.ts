import {
  ROOT_SHAPE_RATIO_BUCKETS_PER_UNIT,
  rootShapeRatio,
  type InstancedRoot,
} from '../SupportPrimitives/Roots/InstancedRootsGroup';
import type { Vec3 } from '../types';
import { quantizeToScale } from '@/utils/math';

/**
 * The plate roots SupportRenderer already resolved, flattened into the records a
 * capacity batch draws.
 *
 * The input is the producer's own output (`sceneBatchedRootGroupsByType`) in
 * registry order, so this module never filters for visibility, selected
 * supports, the hide-plate switch or the model drop offset: all of that has been
 * applied. Inline (stump) roots arrive as the same `InstancedRoot` shape.
 *
 * Three things the producer does *not* resolve, and this pass must:
 *
 * 1. **Degenerate roots are dropped.** `InstancedRootsGroup` filters
 *    `bottomRadius > 0 && effectiveDiskHeight > 0` (`validRoots`); the producer
 *    clamps both to `>= 0.001` so it never trips today. Keeping the filter makes
 *    a zero-scaled disk impossible rather than merely unlikely.
 * 2. **The cone ratio is a geometry, so it is a batch** — and unlike a contact
 *    cone, the ratio that geometry is built with is the *quantized* one
 *    (`rootShapeRatio` quantized at 0.05), because that is what the legacy root
 *    buckets hand to `CylinderGeometry(shapeRatio, 1, 1, 10)`.
 * 3. **A root with no cone draws no top ball.** `coneHeight === 0` is the
 *    disk-only shape: the slot stays in the disk batch and is absent from the
 *    cone and sphere arrays, so no hidden instance is needed.
 *
 * The 0.01 mm render lift is **not** applied here: it is a rendering offset the
 * legacy group adds at write time (`ROOT_RENDER_LIFT_MM`), so the writer adds it
 * and the producer's `basePos` stays truthful.
 */

/** One colour group of resolved roots, as the producer emits it. */
export type RootSlotGroup = {
  color: string;
  roots: readonly InstancedRoot[];
};

/**
 * One batch-drawn root, fully resolved.
 *
 * `basePos` is a copy — the producer's vectors must never alias a record the
 * batch already wrote — and is the plate contact point *without* the render
 * lift. Radii and heights are the produced values: the writer clamps a
 * dimension exactly where the legacy group clamps it in `rootInstanceScales`.
 */
export type RootBatchSlot = {
  id: string;
  supportId: string;
  modelId?: string;
  basePos: Vec3;
  /** Root footprint radius: half the root's diameter. */
  bottomRadius: number;
  /** Shaft-side radius the base cone narrows to. */
  topRadius: number;
  /** Rendered disk height (`effectiveDiskHeight`). */
  diskHeight: number;
  /** Base cone height; 0 draws no cone and no top ball. */
  coneHeight: number;
};

/**
 * A slot plus the instance each of its primitives is drawn at.
 *
 * `diskInstance` is dense across all roots; `coneInstance` and `sphereInstance`
 * are dense across the cone-bearing roots only. `ratio` is the quantized
 * top/bottom ratio the cone geometry is built with.
 */
export type RootSlotRecord = {
  id: number;
  slot: RootBatchSlot;
  /** The group colour the slot was produced under. */
  color: string;
  /** Cone batch key; absent when the root has no cone. */
  bucketKey?: string;
  /** Quantized geometry ratio; 1 when the root has no cone. */
  ratio: number;
  diskInstance: number;
  coneInstance?: number;
  sphereInstance?: number;
};

/**
 * A slot that owns a base cone and a top ball. `buckets[*].records` and
 * `spheres` hold only these, so their writers never need an optional check.
 */
export type RootConedSlotRecord = RootSlotRecord & {
  bucketKey: string;
  coneInstance: number;
  sphereInstance: number;
};

/** Roots sharing one quantized cone ratio, which one frustum geometry draws. */
export type RootConeBucket = {
  key: string;
  ratio: number;
  /** Records in instance order: `records[i]` is drawn at cone instance i. */
  records: RootConedSlotRecord[];
};

export type RootSlotIndex = {
  /** Every batch-drawn root in producer order; `id` is the position in this list. */
  slots: RootSlotRecord[];
  /** One entry per distinct quantized ratio, in first-seen order. */
  buckets: RootConeBucket[];
  /** Dense disks: `disks[i]` is drawn at disk instance i. Every slot has one. */
  disks: RootSlotRecord[];
  /** Dense top balls: roots with a cone only. */
  spheres: RootConedSlotRecord[];
  /** Support id to the global ids of its slots, ascending. */
  bySupport: Map<string, number[]>;
  /** Root id to the global id of the slot that draws it. */
  byPrimitive: Map<string, number>;
  /** Instance totals. `buckets` is the number of cone batches. */
  counts: { disks: number; cones: number; spheres: number; buckets: number };
};

export function buildRootSlotIndex(
  groups: ReadonlyArray<RootSlotGroup>,
): RootSlotIndex {
  const slots: RootSlotRecord[] = [];
  const buckets: RootConeBucket[] = [];
  const bucketByKey = new Map<string, RootConeBucket>();
  const disks: RootSlotRecord[] = [];
  const spheres: RootConedSlotRecord[] = [];
  const bySupport = new Map<string, number[]>();
  const byPrimitive = new Map<string, number>();

  for (const group of groups) {
    const { color } = group;

    for (const root of group.roots) {
      // `InstancedRootsGroup`'s `validRoots` verbatim; see the module note.
      if (!(root.bottomRadius > 0 && root.effectiveDiskHeight > 0)) continue;

      const supportId = root.supportId ?? root.id;
      const coneHeight = Math.max(0, root.coneHeight);
      const hasCone = coneHeight > 0;
      const ratio = quantizeToScale(
        rootShapeRatio(root),
        ROOT_SHAPE_RATIO_BUCKETS_PER_UNIT,
      );
      const key = String(ratio);

      const slot: RootBatchSlot = {
        id: root.id,
        supportId,
        // Copied, not referenced: see the type's note on aliasing.
        basePos: { x: root.basePos.x, y: root.basePos.y, z: root.basePos.z },
        bottomRadius: root.bottomRadius,
        topRadius: root.topRadius,
        diskHeight: root.effectiveDiskHeight,
        coneHeight,
        ...(root.modelId !== undefined ? { modelId: root.modelId } : {}),
      };

      let bucket: RootConeBucket | undefined;
      if (hasCone) {
        bucket = bucketByKey.get(key);
        if (!bucket) {
          bucket = { key, ratio, records: [] };
          bucketByKey.set(key, bucket);
          buckets.push(bucket);
        }
      }

      const id = slots.length;
      const base = { id, slot, color, diskInstance: disks.length };
      let record: RootSlotRecord;
      if (bucket) {
        const coned: RootConedSlotRecord = {
          ...base,
          bucketKey: bucket.key,
          ratio: bucket.ratio,
          coneInstance: bucket.records.length,
          sphereInstance: spheres.length,
        };
        record = coned;
        bucket.records.push(coned);
        spheres.push(coned);
      } else {
        record = { ...base, ratio: 1 };
      }
      disks.push(record);
      slots.push(record);

      const supportSlots = bySupport.get(supportId);
      if (supportSlots) supportSlots.push(id);
      else bySupport.set(supportId, [id]);

      byPrimitive.set(root.id, id);
    }
  }

  return {
    slots,
    buckets,
    disks,
    spheres,
    bySupport,
    byPrimitive,
    counts: {
      disks: disks.length,
      cones: buckets.reduce((total, bucket) => total + bucket.records.length, 0),
      spheres: spheres.length,
      buckets: buckets.length,
    },
  };
}
