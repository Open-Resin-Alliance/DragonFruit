import { JOINT_DIAMETER_OFFSET_MM } from '../constants';
import {
  CONE_RATIO_BUCKETS_PER_UNIT,
  coneShapeRatio,
  getDiskThicknessForCone,
  getProfileType,
} from '../SupportPrimitives/ContactCone/InstancedContactConeGroup';
import type { ContactCone } from '../SupportPrimitives/ContactCone/types';
import {
  resolveSegmentEndpoints,
  type EndpointHosts,
  type SegmentEndpoints,
  type ShaftEntity,
} from '../SupportPrimitives/Knot/segmentEndpoints';
import { resolveShaftSegments } from '../SupportTypes/useShaftSegments';
import {
  contactEndpointsFor,
  getSupportTypeDescriptor,
  resolveSupportTypeIdOf,
  type SupportTypeId,
} from '../supportTypeRegistry';
import type { Segment, Vec3 } from '../types';
import { quantizeToScale } from '@/utils/math';
import type { ConeBatchSlot, ConeProfileKind } from './coneSlots';
import { SHAFT_STRAIGHT_BATCH_KEY } from './shaftSlotBatch';
import { shaftTaperRatio } from './shaftSlots';

/**
 * The slot map one joint-drag gesture writes through an instanced batch.
 *
 * A drag cannot reuse the scene's slot indexes: those are producer-owned and
 * shared, so injecting the dragged support would renumber every instance,
 * rebuild every raycast index and re-apply the hover state map for a condition
 * that lasts one gesture. The drag instead reads the COMMITTED entity once, at
 * drag start, and keeps a private, order-stable list of exactly what it draws.
 * Per-frame writes update values only; no id, instance or bucket ever moves.
 *
 * Everything here is pure: no React, no batches, no scene lookups beyond what
 * the caller hands over. The vector copies follow `jointSlots.ts`: a preview
 * entity's vectors must never alias a record a batch already wrote.
 *
 * Positions are in ENTITY space, exactly what `resolveSegmentEndpoints` returns
 * for the detail renderers — the writer applies the model drop offset, because
 * the instanced batches draw in scene space.
 */

/** The two joint roles a segment can carry, spelled as the entity does. */
export type DragJointKey = 'topJoint' | 'bottomJoint';

/** Where the pointer grabbed the support, as `resolveJointBinding` reports it. */
export type JointDragBinding = {
  jointId: string;
  segmentIndex: number;
  jointKey: DragJointKey;
};

/** Any shafted entity a joint drag can move. */
export type JointDragSlotEntity = ShaftEntity & {
  id: string;
  typeId?: SupportTypeId;
  modelId?: string;
};

/** One joint the gesture redraws, at the instance its batch must draw it. */
export type DragJointSlot = {
  id: string;
  /** The segment/joint role the per-frame write follows. */
  segmentIndex: number;
  jointKey: DragJointKey;
  /** The entity's resolved diameter — never the scene's batched blend. */
  diameter: number;
  /** Committed position, copied. */
  pos: Vec3;
  /** Dense instance id inside the drag joint batch. */
  instance: number;
};

/**
 * One segment the gesture redraws.
 *
 * `batchKey` is the drag batch's own key: `straight`, or the quantized taper
 * ratio as a string — the same shape split `InstancedShaftGroup` uses, because
 * a taper is geometry and cannot ride an instance matrix.
 */
export type DragSegmentSlot = {
  id: string;
  segmentIndex: number;
  batchKey: string;
  /** End/start drawn-diameter ratio; 1 for a straight segment. */
  ratio: number;
  /** Drawn diameter at the segment's start, from the type's declared taper. */
  diameter: number;
  /** Drawn diameter at its end. Equal to `diameter` unless the type tapers. */
  diameterEnd: number;
  /** Committed endpoints, copied. Per-frame writes re-resolve them. */
  start: Vec3;
  end: Vec3;
  /** Dense instance id inside the batch `batchKey` names. */
  instance: number;
};

/** One contact cone the gesture redraws, with the instances of its primitives. */
export type DragConeSlot = {
  id: string;
  /** The declared contact field the per-frame write re-reads the cone from. */
  field: string;
  kind: ConeProfileKind;
  /** Body batch key: `String(quantizeToScale(coneShapeRatio, 10))`. */
  bodyKey: string;
  /** The bucket's geometry ratio, which the body batch's template carries. */
  bodyRatio: number;
  bodyInstance: number;
  tipInstance: number;
  /** Present only for a `disk` profile, the only kind with a nib. */
  diskInstance?: number;
};

/**
 * One leaf host-knot ball drawn by the SHARED joint batch.
 *
 * A knot ball is not the dragged support's geometry, but a leaf hanging on the
 * dragged support's own segment must follow the shaft live or the leaf detaches
 * from its host. The batch that draws it is scene-owned, so this record names
 * the instance rather than owning it.
 */
export type DragKnotBallSlot = {
  /** The knot id, which is also the shared joint slot's primitive id. */
  id: string;
  parentShaftId: string;
  /** The entity segment index the knot rides, resolved from `parentShaftId`. */
  segmentIndex: number;
  /** The committed ball diameter the shared batch drew. */
  diameter: number;
  /** Committed position, copied. Per-frame writes project its `t` again. */
  pos: Vec3;
  /** The knot's authored position along its segment, when it has one. */
  t?: number;
  /** The shared joint batch's instance for this ball, or null when it has none. */
  sharedInstance: number | null;
  /**
   * Whether the knot renders at the joint diameter of its host segment
   * (`SupportTypeDescriptor.knotTakesJointDiameter`), which the per-frame write
   * has to follow as the segment's diameter is fixed but the moving span is not.
   */
  takesJointDiameter: boolean;
};

/** One shape bucket the drag batch must mount a template for. */
export type DragBatchBucket = {
  key: string;
  /** The template's geometry ratio (end/start, or cone body/contact). */
  ratio: number;
  /** How many instances the bucket draws. */
  instances: number;
};

/** Everything one joint-drag gesture draws, in stable draw order. */
export type JointDragSlotMap = {
  typeId: SupportTypeId;
  supportId: string;
  /** The dragged support's model, for the detail palette the batch has to copy. */
  modelId?: string;
  jointId: string;
  binding: JointDragBinding;
  joints: DragJointSlot[];
  segments: DragSegmentSlot[];
  cones: DragConeSlot[];
  knotBalls: DragKnotBallSlot[];
  shaftBuckets: DragBatchBucket[];
  coneBodyBuckets: DragBatchBucket[];
  counts: {
    joints: number;
    segments: number;
    cones: number;
    knotBalls: number;
    coneNibs: number;
  };
};

/**
 * A scene knot the caller hands over so the ones on this support's segments can
 * follow the drag. `ballDiameter` is the diameter the shared batch's slot index
 * recorded; without it the committed bucket blend is reproduced from the knot's
 * own diameter.
 */
export type DragHostKnot = {
  id: string;
  parentShaftId?: string;
  pos: Vec3;
  t?: number;
  diameter?: number;
  ballDiameter?: number;
};

export type BuildJointDragSlotMapOptions = {
  entity: JointDragSlotEntity;
  binding: JointDragBinding;
  /** The root or host knot segment 0 hangs from, as the detail renderers get it. */
  hosts?: EndpointHosts;
  /** Scene knots, unfiltered: this returns the ones on the entity's segments. */
  hostKnots?: readonly DragHostKnot[];
  /** Joint id to shared joint-batch instance, from the scene's joint slot index. */
  sharedJointSlotById?: ReadonlyMap<string, number> | null;
};

/**
 * The knot ball's bump over its host segment's diameter, as
 * `jointDragPreviewMath` applies it (`segment.diameter + 0.125`).
 */
const KNOT_JOINT_DIAMETER_BUMP_MM = 0.125;

/** A knot with no recorded diameter renders at the default 1.2 mm. */
const DEFAULT_KNOT_DIAMETER_MM = 1.2;

/**
 * Whether a joint drag on `typeId` can be drawn as instances.
 *
 * Four conditions, each of which is a reason the detail path must keep the
 * gesture:
 *
 * 1. the type is shafted (`hasSegments`) — a leaf has no draggable joint, a
 *    brace has no segments of its own;
 * 2. the type batches its shafts (`batchesShaft`) — a stump's segments are its
 *    own renderer's, and the legacy instanced path never draws them;
 * 3. every segment is straight — a bezier needs a tube rebuild, and suppressing
 *    only the straight parts would freeze the curve mid-drag;
 * 4. a drag that moves the support's contacts must not move a contact disk:
 *    disks are `ContactDiskRenderer`s with their own solve and HUD, so a twig
 *    stays on the detail path. Cone contacts are instanced (stick).
 *
 * Deliberately derived from the registry and the entity, never from a list of
 * type names: a ninth draggable type is instanceable only if its declarations
 * say so.
 */
export function isInstanceableJointDrag(
  typeId: SupportTypeId | null | undefined,
  entity: { segments?: readonly Segment[] } | null | undefined,
): boolean {
  if (!typeId) return false;
  if (!entity?.segments || entity.segments.length === 0) return false;

  const descriptor = getSupportTypeDescriptor(typeId);
  if (!descriptor.hasSegments || !descriptor.batchesShaft) return false;

  for (const segment of entity.segments) {
    if (segment.type === 'bezier') return false;
  }

  if (descriptor.jointDragMovesContacts) {
    for (const contact of contactEndpointsFor(typeId)) {
      if (contact.kind === 'disk') return false;
    }
  }

  return true;
}

/**
 * The segment and joint role a joint id belongs to, or null when no segment
 * carries it.
 *
 * `useJointInteraction` has the same walk inline because it also caches the
 * result for its per-frame clamp; the gizmo has no such cache and needs the
 * same answer in one call.
 */
export function findJointDragBinding(
  segments: readonly {
    topJoint?: { id: string };
    bottomJoint?: { id: string };
  }[],
  jointId: string,
): JointDragBinding | null {
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.topJoint?.id === jointId) {
      return { jointId, segmentIndex: index, jointKey: 'topJoint' };
    }
    if (segment.bottomJoint?.id === jointId) {
      return { jointId, segmentIndex: index, jointKey: 'bottomJoint' };
    }
  }
  return null;
}

/**
 * The segment indexes the dragged joint's geometry reaches.
 *
 * Moving a joint edits every segment that resolves an endpoint from it:
 *
 * - the segment the binding names;
 * - the next segment when the joint is that segment's top joint, because a
 *   later segment starts at the previous top joint (the type that carries both
 *   joints references the same joint on both sides, which is the same rule);
 * - any other segment that carries the same joint id on its opposite end, which
 *   is how a both-joints type shares one joint between two segments.
 *
 * Ascending, so the slot map (and therefore every per-frame write) is in the
 * producer's draw order.
 */
export function dragAdjacentSegmentIndices(
  binding: JointDragBinding,
  segments: readonly Segment[],
): number[] {
  const indices = new Set<number>();
  if (binding.segmentIndex >= 0 && binding.segmentIndex < segments.length) {
    indices.add(binding.segmentIndex);
  }

  if (binding.jointKey === 'topJoint') {
    if (binding.segmentIndex + 1 < segments.length) indices.add(binding.segmentIndex + 1);
    for (let index = 0; index < segments.length; index += 1) {
      if (segments[index].bottomJoint?.id === binding.jointId) indices.add(index);
    }
  } else {
    for (let index = 0; index < segments.length; index += 1) {
      if (segments[index].topJoint?.id === binding.jointId) indices.add(index);
    }
  }

  return [...indices].sort((a, b) => a - b);
}

/**
 * Fill a cone slot from a contact cone, copying every vector.
 *
 * Mirrors `buildConeSlotIndex`'s slot construction field for field, so a drag
 * draws the identical primitives the scene batch draws for the same cone. A
 * degenerate normal returns false: `InstancedContactConeGroup` drops those
 * before bucketing because the axis quaternion would be NaN, and a drag must
 * not be the one pass that writes one.
 *
 * The target is filled in place, so the per-frame writer can reuse one scratch
 * slot instead of allocating one per cone per frame.
 */
export function fillConeBatchSlot(
  target: ConeBatchSlot,
  cone: ContactCone,
  supportId: string,
  modelId?: string,
): boolean {
  const normalLenSq =
    cone.normal.x * cone.normal.x
    + cone.normal.y * cone.normal.y
    + cone.normal.z * cone.normal.z;
  if (!(normalLenSq > 1e-8)) return false;

  const surfaceNormal = cone.surfaceNormal ?? cone.normal;
  target.id = cone.id;
  target.supportId = supportId;
  target.pos.x = cone.pos.x;
  target.pos.y = cone.pos.y;
  target.pos.z = cone.pos.z;
  target.normal.x = cone.normal.x;
  target.normal.y = cone.normal.y;
  target.normal.z = cone.normal.z;
  target.surfaceNormal.x = surfaceNormal.x;
  target.surfaceNormal.y = surfaceNormal.y;
  target.surfaceNormal.z = surfaceNormal.z;
  target.kind = getProfileType(cone.profile);
  target.lengthMm = cone.profile.lengthMm;
  target.contactRadius = Math.max(0.001, cone.profile.contactDiameterMm / 2);
  target.diskThickness = getDiskThicknessForCone(cone);
  target.penetrationMm = cone.profile.penetrationMm ?? 0;
  if (modelId !== undefined) target.modelId = modelId;
  else delete target.modelId;
  return true;
}

/** The same fill, allocating one slot — for the once-per-gesture build. */
export function coneBatchSlotFromContact(
  cone: ContactCone,
  supportId: string,
  modelId?: string,
): ConeBatchSlot | null {
  const slot: ConeBatchSlot = {
    id: '',
    supportId,
    pos: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 0 },
    surfaceNormal: { x: 0, y: 0, z: 0 },
    kind: 'legacy',
    lengthMm: 0,
    contactRadius: 0,
    diskThickness: 0,
    penetrationMm: 0,
  };
  return fillConeBatchSlot(slot, cone, supportId, modelId) ? slot : null;
}

/**
 * Build the private slot map for one gesture, or null when the gesture must stay
 * on the detail path.
 *
 * Null is the fallback signal, not an error: a type the predicate excludes, an
 * entity whose dragged segment has no resolvable endpoints (a missing root or
 * host knot), or a binding that does not match the committed entity all mean the
 * detail renderers must keep drawing this drag.
 */
export function buildJointDragSlotMap(
  options: BuildJointDragSlotMapOptions,
): JointDragSlotMap | null {
  const { entity, binding } = options;
  const typeId = resolveSupportTypeIdOf(entity);
  if (!typeId) return null;
  if (!isInstanceableJointDrag(typeId, entity)) return null;

  const segments = entity.segments;
  if (binding.segmentIndex < 0 || binding.segmentIndex >= segments.length) return null;

  const boundSegment = segments[binding.segmentIndex];
  const boundJoint = boundSegment[binding.jointKey];
  if (!boundJoint || boundJoint.id !== binding.jointId) return null;

  const descriptor = getSupportTypeDescriptor(typeId);
  const hosts = options.hosts ?? {};

  // The dragged segment must resolve, or the suppression would hide a shaft the
  // drag batch cannot draw. A later segment that fails is simply not written;
  // the legacy chain would not have drawn it either.
  if (!resolveSegmentEndpoints(entity, boundSegment, binding.segmentIndex, hosts)) return null;

  const joints = buildJointSlots(entity, binding, descriptor.segmentsCarryBothJoints);
  if (joints.length === 0) return null;

  // Every segment of the support goes into the private batch, not only the
  // adjacent ones that move. Suppressing only the moving segments left the rest
  // of the support drawn by its detail renderer at the committed position while
  // the batch drew the moving part at the preview — one support, two
  // representations, and the old shaft stayed visible beside the new one. The
  // batch writes the unmoved segments at their committed endpoints, so the whole
  // support is one coherent draw.
  const draggedSegments = buildSegmentSlots(
    entity,
    typeId,
    hosts,
    segments.map((_, index) => index),
  );
  const { cones, coneBodyBuckets, coneNibCount } = buildConeSlots(entity, typeId);
  const knotBalls = buildKnotBallSlots(
    entity,
    descriptor.knotTakesJointDiameter,
    options.hostKnots ?? [],
    options.sharedJointSlotById ?? null,
  );

  const shaftBuckets = new Map<string, DragBatchBucket>();
  for (const slot of draggedSegments) {
    const bucket = shaftBuckets.get(slot.batchKey);
    if (bucket) bucket.instances += 1;
    else shaftBuckets.set(slot.batchKey, {
      key: slot.batchKey,
      ratio: slot.ratio,
      instances: 1,
    });
  }

  return {
    typeId,
    supportId: entity.id,
    ...(entity.modelId !== undefined ? { modelId: entity.modelId } : {}),
    jointId: binding.jointId,
    binding: { ...binding },
    joints,
    segments: draggedSegments,
    cones,
    knotBalls,
    shaftBuckets: [...shaftBuckets.values()],
    coneBodyBuckets,
    counts: {
      joints: joints.length,
      segments: draggedSegments.length,
      cones: cones.length,
      knotBalls: knotBalls.length,
      coneNibs: coneNibCount,
    },
  };
}

/** Every joint of the dragged support, in the producer's draw order. */
function buildJointSlots(
  entity: JointDragSlotEntity,
  binding: JointDragBinding,
  includeBottomJoints: boolean,
): DragJointSlot[] {
  const slots: DragJointSlot[] = [];
  const seen = new Set<string>();

  const take = (
    segmentIndex: number,
    jointKey: DragJointKey,
    joint: { id: string; pos: Vec3; diameter: number } | undefined,
  ) => {
    if (!joint || seen.has(joint.id)) return;
    seen.add(joint.id);
    slots.push({
      id: joint.id,
      segmentIndex,
      jointKey,
      diameter: joint.diameter,
      pos: { x: joint.pos.x, y: joint.pos.y, z: joint.pos.z },
      instance: slots.length,
    });
  };

  for (let index = 0; index < entity.segments.length; index += 1) {
    const segment = entity.segments[index];
    if (includeBottomJoints) take(index, 'bottomJoint', segment.bottomJoint);
    take(index, 'topJoint', segment.topJoint);
  }

  // The binding is the drag's own truth; a joint list without it cannot write.
  return slots.some((slot) => slot.id === binding.jointId) ? slots : [];
}

/** The dragged segments, endpoints resolved exactly as the detail renderers do. */
function buildSegmentSlots(
  entity: JointDragSlotEntity,
  typeId: SupportTypeId,
  hosts: EndpointHosts,
  segmentIndices: readonly number[],
): DragSegmentSlot[] {
  const resolved = resolveShaftSegments(entity, hosts);
  const byIndex = new Map(resolved.map((shaft) => [shaft.index, shaft]));
  const slots: DragSegmentSlot[] = [];
  const bucketCounts = new Map<string, number>();

  for (const index of segmentIndices) {
    const shaft = byIndex.get(index);
    if (!shaft) continue;

    const segment = entity.segments[index];
    const diameter = shaft.diameterStart ?? segment.diameter;
    const diameterEnd = shaft.diameterEnd ?? segment.diameter;
    const tapered = !shaft.isUniformDiameter && Math.abs(diameterEnd - diameter) > 1e-6;
    const ratio = tapered ? shaftTaperRatio({ diameter, diameterEnd }) : 1;
    const batchKey = tapered ? String(ratio) : SHAFT_STRAIGHT_BATCH_KEY;
    const instance = bucketCounts.get(batchKey) ?? 0;
    bucketCounts.set(batchKey, instance + 1);

    slots.push({
      id: segment.id,
      segmentIndex: index,
      batchKey,
      ratio,
      diameter,
      diameterEnd,
      start: { x: shaft.start.x, y: shaft.start.y, z: shaft.start.z },
      end: { x: shaft.end.x, y: shaft.end.y, z: shaft.end.z },
      instance,
    });
  }

  return slots;
}

/** The type's declared cone contacts, bucketed by body/contact ratio. */
function buildConeSlots(
  entity: JointDragSlotEntity,
  typeId: SupportTypeId,
): { cones: DragConeSlot[]; coneBodyBuckets: DragBatchBucket[]; coneNibCount: number } {
  const record = entity as unknown as Record<string, ContactCone | undefined>;
  const cones: DragConeSlot[] = [];
  const buckets = new Map<string, DragBatchBucket>();
  let tipCount = 0;
  let nibCount = 0;

  for (const contact of contactEndpointsFor(typeId)) {
    if (contact.kind !== 'cone') continue;
    const cone = record[contact.field];
    if (!cone) continue;

    const slot = coneBatchSlotFromContact(cone, entity.id, entity.modelId);
    if (!slot) continue;

    const rawRatio = coneShapeRatio(cone);
    const bodyKey = String(quantizeToScale(rawRatio, CONE_RATIO_BUCKETS_PER_UNIT));
    let bucket = buckets.get(bodyKey);
    if (!bucket) {
      bucket = { key: bodyKey, ratio: rawRatio, instances: 0 };
      buckets.set(bodyKey, bucket);
    }

    const bodyInstance = bucket.instances;
    bucket.instances += 1;

    const tipInstance = tipCount;
    tipCount += 1;

    const dragSlot: DragConeSlot = {
      id: cone.id,
      field: contact.field,
      kind: slot.kind,
      bodyKey,
      bodyRatio: bucket.ratio,
      bodyInstance,
      tipInstance,
    };
    if (slot.kind === 'disk') {
      dragSlot.diskInstance = nibCount;
      nibCount += 1;
    }
    cones.push(dragSlot);
  }

  return { cones, coneBodyBuckets: [...buckets.values()], coneNibCount: nibCount };
}

/**
 * The leaf host-knot balls that ride this support's own segments.
 *
 * Filtering is by `parentShaftId`, which the scene stores as the host segment's
 * id — the same key `previewCandidateKnots` filters on during a joint drag.
 */
function buildKnotBallSlots(
  entity: JointDragSlotEntity,
  takesJointDiameter: boolean,
  hostKnots: readonly DragHostKnot[],
  sharedJointSlotById: ReadonlyMap<string, number> | null,
): DragKnotBallSlot[] {
  if (hostKnots.length === 0) return [];

  const segmentIndexById = new Map<string, number>();
  for (let index = 0; index < entity.segments.length; index += 1) {
    segmentIndexById.set(entity.segments[index].id, index);
  }

  const slots: DragKnotBallSlot[] = [];
  for (const knot of hostKnots) {
    if (!knot.parentShaftId) continue;
    const segmentIndex = segmentIndexById.get(knot.parentShaftId);
    if (segmentIndex === undefined) continue;

    const committedDiameter = knot.ballDiameter
      ?? Math.max(
        0.001,
        (knot.diameter ?? DEFAULT_KNOT_DIAMETER_MM) - JOINT_DIAMETER_OFFSET_MM,
      );

    slots.push({
      id: knot.id,
      parentShaftId: knot.parentShaftId,
      segmentIndex,
      diameter: committedDiameter,
      pos: { x: knot.pos.x, y: knot.pos.y, z: knot.pos.z },
      ...(knot.t !== undefined ? { t: knot.t } : {}),
      sharedInstance: sharedJointSlotById?.get(knot.id) ?? null,
      takesJointDiameter,
    });
  }

  return slots;
}

/**
 * The diameter a moving knot ball is drawn with.
 *
 * The shared batch draws a knot ball at its host diameter (the knot's own
 * diameter less the joint offset), and the drag's knot override sets the knot's
 * diameter to `segment.diameter + 0.125` when the type renders knots at joint
 * size. Both adjustments are reproduced here so the ball the drag writes is the
 * ball the scene batch would have drawn.
 */
export function dragKnotBallDiameter(
  slot: DragKnotBallSlot,
  hostSegmentDiameter: number,
): number {
  if (!slot.takesJointDiameter) return slot.diameter;
  return Math.max(
    0.001,
    hostSegmentDiameter + KNOT_JOINT_DIAMETER_BUMP_MM - JOINT_DIAMETER_OFFSET_MM,
  );
}

/** The t a knot rides at, projected from its committed position when it has none. */
export function projectKnotT(pos: Vec3, start: Vec3, end: Vec3): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dz = end.z - start.z;
  const lengthSq = dx * dx + dy * dy + dz * dz;
  if (lengthSq < 1e-8) return 0;
  const t = ((pos.x - start.x) * dx + (pos.y - start.y) * dy + (pos.z - start.z) * dz) / lengthSq;
  return Math.min(1, Math.max(0, t));
}

/** The resolved endpoints a knot's host segment has for this entity, or null. */
export function segmentEndpointsForIndex(
  entity: JointDragSlotEntity,
  segmentIndex: number,
  hosts: EndpointHosts,
): SegmentEndpoints | null {
  const segment = entity.segments[segmentIndex];
  if (!segment) return null;
  return resolveSegmentEndpoints(entity, segment, segmentIndex, hosts);
}
