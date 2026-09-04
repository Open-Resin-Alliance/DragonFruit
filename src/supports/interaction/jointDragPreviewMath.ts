import { calculateKnotPositionOnSegmentFromT, getBranchSegmentEndpoints, getTrunkSegmentEndpoints } from '../SupportPrimitives/Knot/knotUtils';
import type { Branch, Knot, Roots, Trunk, Vec3 } from '../types';
import type { Kickstand } from '../SupportTypes/Kickstand/types';

export type JointDragPreviewKind = 'trunk' | 'branch' | 'kickstand';

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

function getKickstandSegmentEndpoints(
  kickstand: Kickstand,
  segmentIndex: number,
  root: Roots,
  hostKnot: Knot,
) {
  const segment = kickstand.segments[segmentIndex];
  if (!segment) return null;

  const rootTop = {
    x: root.transform.pos.x,
    y: root.transform.pos.y,
    z: root.transform.pos.z + root.diskHeight + root.coneHeight,
  };

  const start = segment.bottomJoint?.pos
    ?? (segmentIndex > 0 ? kickstand.segments[segmentIndex - 1]?.topJoint?.pos ?? rootTop : rootTop);
  const end = segment.topJoint?.pos ?? hostKnot.pos;

  if (!start || !end) return null;

  return { start, end, segment };
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
  if (!support) return {} as Record<string, Knot>;

  const nextKnots: Record<string, Knot> = {};
  const candidateKnotIdsByParentShaftId = buildCandidateKnotIdsByParentShaftId(candidateKnots);
  if (candidateKnotIdsByParentShaftId.size === 0) return nextKnots;

  if (preview.kind === 'trunk') {
    const trunk = support as Trunk;
    const root = context.root ?? null;
    if (!root) return nextKnots;

    for (let segIndex = 0; segIndex < support.segments.length; segIndex += 1) {
      if (shouldAbort?.()) return nextKnots;
      const segment = support.segments[segIndex];
      const segmentKnotIds = candidateKnotIdsByParentShaftId.get(segment.id);
      if (!segmentKnotIds || segmentKnotIds.length === 0) continue;

      const endpoints = getTrunkSegmentEndpoints(trunk, segment, segIndex, root);
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
          diameter: segment.diameter + 0.125,
        };
      }
    }

    return nextKnots;
  }

  if (preview.kind === 'kickstand') {
    const kickstand = support as Kickstand;
    const root = context.root ?? null;
    const hostKnot = context.hostKnot ?? null;
    if (!root || !hostKnot) return nextKnots;

    for (let segIndex = 0; segIndex < support.segments.length; segIndex += 1) {
      if (shouldAbort?.()) return nextKnots;
      const segment = support.segments[segIndex];
      const segmentKnotIds = candidateKnotIdsByParentShaftId.get(segment.id);
      if (!segmentKnotIds || segmentKnotIds.length === 0) continue;

      const endpoints = getKickstandSegmentEndpoints(kickstand, segIndex, root, hostKnot);
      if (!endpoints) continue;

      for (const knotId of segmentKnotIds) {
        if (shouldAbort?.()) return nextKnots;
        const knot = candidateKnots[knotId];
        if (!knot) continue;

        const tForKnot = knot.t !== undefined
          ? knot.t
          : closestTToPoint(knot.pos, endpoints.start, endpoints.end);
        nextKnots[knot.id] = {
          ...knot,
          pos: calculateKnotPositionOnSegmentFromT(endpoints.start, endpoints.end, endpoints.segment, tForKnot),
        };
      }
    }

    return nextKnots;
  }

  const branch = support as Branch;
  const parentKnot = context.parentKnot ?? null;
  if (!parentKnot) return nextKnots;

  for (let segIndex = 0; segIndex < support.segments.length; segIndex += 1) {
    if (shouldAbort?.()) return nextKnots;
    const segment = support.segments[segIndex];
    const segmentKnotIds = candidateKnotIdsByParentShaftId.get(segment.id);
    if (!segmentKnotIds || segmentKnotIds.length === 0) continue;

    const endpoints = getBranchSegmentEndpoints(branch, segment, segIndex, parentKnot);
    if (!endpoints) continue;

    for (const knotId of segmentKnotIds) {
      if (shouldAbort?.()) return nextKnots;
      const knot = candidateKnots[knotId];
      if (!knot) continue;

      const tForKnot = knot.t !== undefined
        ? knot.t
        : closestTToPoint(knot.pos, endpoints.start, endpoints.end);
      nextKnots[knot.id] = {
        ...knot,
        pos: calculateKnotPositionOnSegmentFromT(endpoints.start, endpoints.end, segment, tForKnot),
      };
    }
  }

  return nextKnots;
}