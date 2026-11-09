import { calculateKnotPositionOnSegmentFromT } from '../SupportPrimitives/Knot/knotUtils';
import { resolveSegmentEndpoints, type EndpointHosts } from '../SupportPrimitives/Knot/segmentEndpoints';
import type { Branch, Knot, Roots, Trunk, Vec3 } from '../types';
import type { Kickstand } from '../SupportTypes/Kickstand/types';
import { getSupportTypeDescriptor, type JointDragPreviewTypeId } from '../supportTypeRegistry';

/** Types whose joint drags publish a preview, from `JOINT_DRAG_PREVIEW_BY_TYPE`. */
export type JointDragPreviewKind = JointDragPreviewTypeId;

export interface JointDragPreviewPayload<TSupport = unknown> {
  kind: JointDragPreviewKind;
  supportId: string;
  support: TSupport | null;
}

export type JointDragPreviewSnapshot = JointDragPreviewPayload<Trunk | Branch | Kickstand>;

export interface JointDragPreviewContext {
  root?: Roots | null;
  parentKnot?: Knot | null;
  hostKnot?: Knot | null;
}

export interface JointDragPreviewComputeOptions {
  shouldAbort?: () => boolean;
}

export type JointDragPreviewCandidateKnots = Record<string, Knot>;

function buildCandidateKnotIdsByParentShaftId(candidateKnots: JointDragPreviewCandidateKnots) {
  const map = new Map<string, string[]>();

  for (const knotId in candidateKnots) {
    const knot = candidateKnots[knotId];
    const parentShaftId = knot.parentShaftId;
    if (!parentShaftId) continue;

    const list = map.get(parentShaftId);
    if (list) {
      list.push(knotId);
    } else {
      map.set(parentShaftId, [knotId]);
    }
  }

  return map;
}


/** Closest t on the straight segment [start, end] to a point. Auto
 *  merge/fan knots carry no `t` — project their position so leaves follow
 *  the shaft live during a joint drag. */
function closestTToPoint(pos: Vec3, start: Vec3, end: Vec3): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dz = end.z - start.z;
  const lenSq = dx * dx + dy * dy + dz * dz;
  if (lenSq < 1e-8) return 0;
  const t = ((pos.x - start.x) * dx + (pos.y - start.y) * dy + (pos.z - start.z) * dz) / lenSq;
  return Math.min(1, Math.max(0, t));
}

export function computeJointDragPreviewKnots(
  preview: JointDragPreviewSnapshot | null,
  context: JointDragPreviewContext,
  candidateKnots: JointDragPreviewCandidateKnots,
  options?: JointDragPreviewComputeOptions,
) {
  const shouldAbort = options?.shouldAbort;
  const support = preview?.support;
  if (!preview || !support) return {} as Record<string, Knot>;

  const nextKnots: Record<string, Knot> = {};
  const candidateKnotIdsByParentShaftId = buildCandidateKnotIdsByParentShaftId(candidateKnots);
  if (candidateKnotIdsByParentShaftId.size === 0) return nextKnots;

  // Every preview type resolves the same way: its declared hosts (a root when
  // it owns one, a hosted knot when it hangs from one) feed `resolveSegmentEndpoints`,
  // and a knot on the default host renders at the joint diameter so it is not
  // hidden inside the joint sphere (`knotTakesJointDiameter`).
  const descriptor = getSupportTypeDescriptor(preview.kind);
  const hosts: EndpointHosts = {
    root: context.root ?? undefined,
    hostKnot: (context.parentKnot ?? context.hostKnot) ?? undefined,
  };

  for (let segIndex = 0; segIndex < support.segments.length; segIndex += 1) {
    if (shouldAbort?.()) return nextKnots;
    const segment = support.segments[segIndex];
    const segmentKnotIds = candidateKnotIdsByParentShaftId.get(segment.id);
    if (!segmentKnotIds || segmentKnotIds.length === 0) continue;

    const endpoints = resolveSegmentEndpoints(support, segment, segIndex, hosts);
    if (!endpoints) continue;

    for (const knotId of segmentKnotIds) {
      if (shouldAbort?.()) return nextKnots;
      const knot = candidateKnots[knotId];
      if (!knot) continue;

      // t-less auto knots project their position onto the moved segment so
      // the preview leaf follows live during the drag.
      const tForKnot = knot.t !== undefined
        ? knot.t
        : closestTToPoint(knot.pos, endpoints.start, endpoints.end);
      const nextPos = calculateKnotPositionOnSegmentFromT(endpoints.start, endpoints.end, segment, tForKnot);
      nextKnots[knot.id] = {
        ...knot,
        pos: nextPos,
        ...(descriptor.knotTakesJointDiameter ? { diameter: segment.diameter + 0.125 } : {}),
      };
    }
  }

  return nextKnots;
}
