import type { Branch, Roots, SupportEntity, SupportFieldsByType, Trunk, Vec3 } from '../../types';
import { getSupportTypeDescriptor, SUPPORT_TYPES, updateSupportEntity, type SupportTypeId } from '../../supportTypeRegistry';
import { moveJoint } from './jointUtils';
import { clearSupportDragPreview, emitSupportDragPreview } from './jointDragRuntime';

export type JointDragSupportKind = SupportTypeId;

/** Squared mm below which a pointer has not moved far enough to be a drag. */
export const MIN_COMMIT_DELTA_SQ = 1e-6;

/**
 * Whether a finished pointer interaction was a drag rather than a click.
 *
 * The commit re-solves the contact cone, which the drag preview skips, so a
 * click that moved nothing would still reposition the tip.
 */
export function shouldCommitJointDrag(
  pressPos: Vec3 | null | undefined,
  releasePos: Vec3 | null | undefined,
): boolean {
  if (!pressPos || !releasePos) return false;

  const dx = releasePos.x - pressPos.x;
  const dy = releasePos.y - pressPos.y;
  const dz = releasePos.z - pressPos.z;

  return dx * dx + dy * dy + dz * dz >= MIN_COMMIT_DELTA_SQ;
}

/**
 * The types whose joint drag commits through `commitJointDragSupport`: every
 * shafted type, since the commit is not type-specific.
 */
export const JOINT_DRAG_COMMIT_TYPES: ReadonlySet<SupportTypeId> = new Set(
  SUPPORT_TYPES.filter((descriptor) => descriptor.hasSegments).map((descriptor) => descriptor.id),
);

/**
 * The types whose drag-end recompute moves the shaft against a host.
 *
 * A shaft running between hosts re-solves from its declared lower endpoint; a
 * type contacting the model at both ends re-solves its contacts instead, which
 * is a different computation and not this one. Distinct from
 * JOINT_DRAG_COMMIT_TYPES, which is only about how the result is written.
 */
export const JOINT_DRAG_HOSTED_SHAFT_TYPES: ReadonlySet<SupportTypeId> = new Set(
  SUPPORT_TYPES
    .filter((descriptor) => descriptor.hasSegments && !descriptor.jointDragMovesContacts)
    .filter((descriptor) => descriptor.lower.kind === 'plateRoot' || descriptor.lower.kind === 'knot')
    .map((descriptor) => descriptor.id),
);

/** Each type's entity, derived from the one place types are named. */
export type JointDragSupportByKind = {
  [K in SupportTypeId]: SupportEntity & SupportFieldsByType[K];
};

export type JointDragSupport = JointDragSupportByKind[keyof JointDragSupportByKind];

interface ComputeJointDragSupportPreviewOptions<K extends JointDragSupportKind> {
  kind: K;
  support: JointDragSupportByKind[K];
  jointId: string;
  newPos: Vec3;
  isCurveMode: boolean;
  root?: Roots;
  contextStart?: Vec3;
  skipContactConeSolve?: boolean;
}

interface CommitJointDragSupportOptions {
  clearPreview?: boolean;
  stripDiskLengthOverride?: boolean;
}

export function computeJointDragSupportPreview<K extends JointDragSupportKind>({
  kind,
  support,
  jointId,
  newPos,
  isCurveMode,
  root,
  contextStart,
  skipContactConeSolve,
}: ComputeJointDragSupportPreviewOptions<K>): JointDragSupportByKind[K] {
  // Only a plate-rooted type constrains its drag against a root; a knot-hosted
  // one is clamped from its host instead, so passing a root would move it.
  const rooted = getSupportTypeDescriptor(kind).lower.kind === 'plateRoot';

  return moveJoint(
    support as unknown as Trunk,
    jointId,
    newPos,
    undefined,
    isCurveMode,
    rooted ? root : undefined,
    contextStart,
    { skipContactConeSolve },
  ) as unknown as JointDragSupportByKind[K];
}

export function publishJointDragSupportPreview<K extends JointDragSupportKind>(
  kind: K,
  support: JointDragSupportByKind[K],
) {
  emitSupportDragPreview(kind, support.id, support);
}

export function clearJointDragSupportPreview(kind: JointDragSupportKind, supportId: string) {
  clearSupportDragPreview(kind, supportId);
}

function normalizeCommittedSupport<K extends JointDragSupportKind>(
  kind: K,
  support: JointDragSupportByKind[K],
  stripDiskLengthOverride: boolean,
): JointDragSupportByKind[K] {
  if (!stripDiskLengthOverride) return support;
  if (!getSupportTypeDescriptor(kind).hasContactDiskLengthOverride) return support;

  const typed = support as Trunk | Branch;
  if (!typed.contactCone) return support;

  return {
    ...typed,
    contactCone: {
      ...typed.contactCone,
      diskLengthOverride: undefined,
    },
  } as JointDragSupportByKind[K];
}

export function commitJointDragSupport<K extends JointDragSupportKind>(
  kind: K,
  support: JointDragSupportByKind[K],
  options: CommitJointDragSupportOptions = {},
): JointDragSupportByKind[K] {
  const { clearPreview = true, stripDiskLengthOverride = false } = options;
  const committed = normalizeCommittedSupport(kind, support, stripDiskLengthOverride);

  // Dispatched by the registry: a fourth draggable type is written to its own
  // collection without touching this file.
  if (!updateSupportEntity(kind, committed)) {
    throw new Error(`No updater registered for support type ${kind}`);
  }

  if (clearPreview) {
    clearJointDragSupportPreview(kind, (committed as JointDragSupport).id);
  }

  return committed;
}
