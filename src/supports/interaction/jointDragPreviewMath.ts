import { calculateKnotPositionOnSegmentFromT, getBranchSegmentEndpoints, getTrunkSegmentEndpoints } from '../SupportPrimitives/Knot/knotUtils';
import type { Branch, Knot, Roots, Trunk } from '../types';
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

export type JointDragPreviewCandidateKnots = Record<string, Knot>;

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

export function computeJointDragPreviewKnots(
  preview: JointDragPreviewSnapshot | null,
  context: JointDragPreviewContext,
  candidateKnots: JointDragPreviewCandidateKnots,
) {
  const support = preview?.support;
  if (!support) return {} as Record<string, Knot>;

  const nextKnots: Record<string, Knot> = {};
  const segmentIndexById = new Map<string, number>();
  support.segments.forEach((segment, index) => segmentIndexById.set(segment.id, index));

  if (preview.kind === 'trunk') {
    const trunk = support as Trunk;
    const root = context.root ?? null;
    if (!root) return nextKnots;

    for (const knot of Object.values(candidateKnots)) {
      const segIndex = segmentIndexById.get(knot.parentShaftId);
      if (segIndex === undefined) continue;

      const segment = support.segments[segIndex];
      const endpoints = getTrunkSegmentEndpoints(trunk, segment, segIndex, root);
      if (!endpoints || knot.t === undefined) continue;

      const nextPos = calculateKnotPositionOnSegmentFromT(endpoints.start, endpoints.end, segment, knot.t);
      nextKnots[knot.id] = {
        ...knot,
        pos: nextPos,
        diameter: segment.diameter + 0.1,
      };
    }

    return nextKnots;
  }

  if (preview.kind === 'kickstand') {
    const kickstand = support as Kickstand;
    const root = context.root ?? null;
    const hostKnot = context.hostKnot ?? null;
    if (!root || !hostKnot) return nextKnots;

    for (const knot of Object.values(candidateKnots)) {
      const segIndex = segmentIndexById.get(knot.parentShaftId);
      if (segIndex === undefined) continue;

      const endpoints = getKickstandSegmentEndpoints(kickstand, segIndex, root, hostKnot);
      if (!endpoints || knot.t === undefined) continue;

      nextKnots[knot.id] = {
        ...knot,
        pos: calculateKnotPositionOnSegmentFromT(endpoints.start, endpoints.end, endpoints.segment, knot.t),
      };
    }

    return nextKnots;
  }

  const branch = support as Branch;
  const parentKnot = context.parentKnot ?? null;
  if (!parentKnot) return nextKnots;

  for (const knot of Object.values(candidateKnots)) {
    const segIndex = segmentIndexById.get(knot.parentShaftId);
    if (segIndex === undefined) continue;

    const segment = support.segments[segIndex];
    const endpoints = getBranchSegmentEndpoints(branch, segment, segIndex, parentKnot);
    if (!endpoints || knot.t === undefined) continue;

    nextKnots[knot.id] = {
      ...knot,
      pos: calculateKnotPositionOnSegmentFromT(endpoints.start, endpoints.end, segment, knot.t),
    };
  }

  return nextKnots;
}