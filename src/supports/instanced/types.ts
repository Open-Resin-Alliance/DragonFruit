import type { Vec3 } from '@/supports/types';
import type { SupportTipProfile } from '@/supports/SupportPrimitives/ContactCone/types';

/**
 * CPU-side slot records for the instanced support renderer.
 *
 * Derived from the proxy primitive arrays so there is one anatomy walk, not two.
 * Every record keeps the primitive id and owning support id: the instance index
 * is an implementation detail of the batch, while these ids are what hover,
 * selection and drags resolve against.
 */

export type ShaftSlotKind = 'straight' | 'tapered' | 'curved';

export type ShaftSlot = {
  id: string;
  supportId: string;
  modelId?: string;
  kind: ShaftSlotKind;
  start: Vec3;
  end: Vec3;
  /** Diameter at start/end, in millimetres. */
  diameterStart: number;
  diameterEnd: number;
  controlPoint1?: Vec3;
  controlPoint2?: Vec3;
  resolution?: number;
};

export type JointSlot = {
  id: string;
  supportId: string;
  modelId?: string;
  pos: Vec3;
  diameter: number;
};

export type RootSlot = {
  id: string;
  supportId: string;
  modelId?: string;
  basePos: Vec3;
  bottomRadius: number;
  topRadius: number;
  effectiveDiskHeight: number;
  coneHeight: number;
};

export type ConeSlot = {
  id: string;
  supportId: string;
  modelId?: string;
  pos: Vec3;
  normal: Vec3;
  surfaceNormal?: Vec3;
  profile: SupportTipProfile;
  /** Mirror of the proxy's per-cone shape ratio (body diameter / contact diameter). */
  shapeRatio: number;
};

export type SupportSlotKind = 'shaft' | 'joint' | 'root' | 'cone';

export type SupportSlotLists = {
  shafts: ShaftSlot[];
  joints: JointSlot[];
  roots: RootSlot[];
  cones: ConeSlot[];
};

export type SupportPrimitiveRef = {
  kind: SupportSlotKind;
  /** Index into the matching slot list. */
  index: number;
};

export type SupportSlotIndex = SupportSlotLists & {
  /** Every primitive that belongs to one support, as indices into the lists. */
  bySupport: Map<string, {
    shafts: number[];
    joints: number[];
    roots: number[];
    cones: number[];
  }>;
  /** Resolve a primitive id (what a pick or a ray reports) to its slot. */
  byPrimitive: Map<string, SupportPrimitiveRef>;
};
