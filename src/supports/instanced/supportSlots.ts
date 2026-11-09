import type { InstancedShaft } from '../SupportPrimitives/Shaft/InstancedShaftGroup';
import type { ProxyModelGeometry } from '../SupportProxyMeshLayer';
import type {
  ConeSlot,
  JointSlot,
  RootSlot,
  ShaftSlot,
  ShaftSlotKind,
  SupportPrimitiveRef,
  SupportSlotIndex,
  SupportSlotKind,
} from './types';
import type { SupportTipProfile } from '../SupportPrimitives/ContactCone/types';

/**
 * The proxy primitive arrays, flattened into the slot records the instanced
 * renderer batches.
 *
 * `collectProxyPrimitives` is the one walk of the support anatomy; this pass
 * only re-shapes its output. Nothing is filtered and nothing is reordered: a
 * slot's index in its list is the same primitive's index in the proxy array of
 * that kind, so a batch built from these lists answers the proxy's own instance
 * indices. Deciding that a primitive is not worth drawing (a zero-length shaft,
 * say) stays with the drawing groups, exactly as it is today.
 */

/** Shaft ends closer than this are the same width: not a taper. */
const TAPER_EPSILON = 1e-6;

function shaftKindOf(shaft: InstancedShaft): ShaftSlotKind {
  if (shaft.controlPoint1 != null && shaft.controlPoint2 != null) return 'curved';
  if (shaft.diameterEnd != null && Math.abs(shaft.diameterEnd - shaft.diameter) > TAPER_EPSILON) {
    return 'tapered';
  }
  return 'straight';
}

/**
 * The cone body's end-to-end ratio, which the cone batch keys its meshes on.
 *
 * A profile with no contact footprint has no ratio to speak of; the divisor is
 * guarded so the slot carries a finite, positive ratio rather than infinity.
 */
function coneShapeRatio(profile: SupportTipProfile): number {
  return profile.contactDiameterMm > 0 ? profile.bodyDiameterMm / profile.contactDiameterMm : 1;
}

const LIST_KEY: Record<SupportSlotKind, 'shafts' | 'joints' | 'roots' | 'cones'> = {
  shaft: 'shafts',
  joint: 'joints',
  root: 'roots',
  cone: 'cones',
};

/**
 * A primitive with no owning support is grouped under its own id: it is one
 * support's worth of geometry in every later resolution step, and sharing an
 * empty key would put unrelated primitives in one group.
 */
function supportIdOf(primitive: { id: string; supportId?: string }): string {
  return primitive.supportId ?? primitive.id;
}

function vec3(v: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  return { x: v.x, y: v.y, z: v.z };
}

export function buildSupportSlots(model: ProxyModelGeometry): SupportSlotIndex {
  const shafts: ShaftSlot[] = [];
  const joints: JointSlot[] = [];
  const roots: RootSlot[] = [];
  const cones: ConeSlot[] = [];

  const bySupport: SupportSlotIndex['bySupport'] = new Map();
  const byPrimitive: Map<string, SupportPrimitiveRef> = new Map();

  const track = (id: string, supportId: string, kind: SupportSlotKind, index: number): void => {
    let lists = bySupport.get(supportId);
    if (!lists) {
      lists = { shafts: [], joints: [], roots: [], cones: [] };
      bySupport.set(supportId, lists);
    }
    lists[LIST_KEY[kind]].push(index);
    // One id names one primitive: a repeated id can only be a caller mistake,
    // and the last push is the one still in the array.
    byPrimitive.set(id, { kind, index });
  };

  for (const shaft of model.shafts) {
    const modelId = shaft.modelId ?? model.modelId;
    const slot: ShaftSlot = {
      id: shaft.id,
      supportId: supportIdOf(shaft),
      kind: shaftKindOf(shaft),
      start: vec3(shaft.start),
      end: vec3(shaft.end),
      diameterStart: shaft.diameter,
      diameterEnd: shaft.diameterEnd ?? shaft.diameter,
      ...(modelId !== undefined ? { modelId } : {}),
      ...(shaft.controlPoint1 != null ? { controlPoint1: vec3(shaft.controlPoint1) } : {}),
      ...(shaft.controlPoint2 != null ? { controlPoint2: vec3(shaft.controlPoint2) } : {}),
      ...(shaft.resolution != null ? { resolution: shaft.resolution } : {}),
    };
    const index = shafts.push(slot) - 1;
    track(slot.id, slot.supportId, 'shaft', index);
  }

  for (const joint of model.joints) {
    const modelId = joint.modelId ?? model.modelId;
    const slot: JointSlot = {
      id: joint.id,
      supportId: supportIdOf(joint),
      pos: vec3(joint.pos),
      diameter: joint.diameter,
      ...(modelId !== undefined ? { modelId } : {}),
    };
    const index = joints.push(slot) - 1;
    track(slot.id, slot.supportId, 'joint', index);
  }

  for (const root of model.roots) {
    const modelId = root.modelId ?? model.modelId;
    const slot: RootSlot = {
      id: root.id,
      supportId: supportIdOf(root),
      basePos: vec3(root.basePos),
      bottomRadius: root.bottomRadius,
      topRadius: root.topRadius,
      effectiveDiskHeight: root.effectiveDiskHeight,
      coneHeight: root.coneHeight,
      ...(modelId !== undefined ? { modelId } : {}),
    };
    const index = roots.push(slot) - 1;
    track(slot.id, slot.supportId, 'root', index);
  }

  for (const cone of model.cones) {
    const modelId = cone.modelId ?? model.modelId;
    const slot: ConeSlot = {
      id: cone.id,
      supportId: supportIdOf(cone),
      pos: vec3(cone.pos),
      normal: vec3(cone.normal),
      profile: cone.profile,
      shapeRatio: coneShapeRatio(cone.profile),
      ...(modelId !== undefined ? { modelId } : {}),
      ...(cone.surfaceNormal != null ? { surfaceNormal: vec3(cone.surfaceNormal) } : {}),
    };
    const index = cones.push(slot) - 1;
    track(slot.id, slot.supportId, 'cone', index);
  }

  return { shafts, joints, roots, cones, bySupport, byPrimitive };
}
