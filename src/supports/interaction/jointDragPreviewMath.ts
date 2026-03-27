import { calculateKnotPositionOnSegmentFromT, getBranchSegmentEndpoints, getTrunkSegmentEndpoints } from '../SupportPrimitives/Knot/knotUtils';
import type { Branch, Knot, Roots, Trunk } from '../types';

export type JointDragPreviewKind = 'trunk' | 'branch';

export interface JointDragPreviewPayload<TSupport = unknown> {
  kind: JointDragPreviewKind;
  supportId: string;
  support: TSupport | null;
}

export type JointDragPreviewSnapshot = JointDragPreviewPayload<Trunk | Branch>;

export interface JointDragPreviewContext {
  root?: Roots | null;
  parentKnot?: Knot | null;
}

export type JointDragPreviewCandidateKnots = Record<string, Knot>;

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
    const root = context.root ?? null;
    if (!root) return nextKnots;

    for (const knot of Object.values(candidateKnots)) {
      const segIndex = segmentIndexById.get(knot.parentShaftId);
      if (segIndex === undefined) continue;

      const segment = support.segments[segIndex];
      const endpoints = getTrunkSegmentEndpoints(support, segment, segIndex, root);
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

  const parentKnot = context.parentKnot ?? null;
  if (!parentKnot) return nextKnots;

  for (const knot of Object.values(candidateKnots)) {
    const segIndex = segmentIndexById.get(knot.parentShaftId);
    if (segIndex === undefined) continue;

    const segment = support.segments[segIndex];
    const endpoints = getBranchSegmentEndpoints(support, segment, segIndex, parentKnot);
    if (!endpoints || knot.t === undefined) continue;

    nextKnots[knot.id] = {
      ...knot,
      pos: calculateKnotPositionOnSegmentFromT(endpoints.start, endpoints.end, segment, knot.t),
    };
  }

  return nextKnots;
}