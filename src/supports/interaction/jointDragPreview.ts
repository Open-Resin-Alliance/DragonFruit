import React from 'react';
import { calculateKnotPositionOnSegmentFromT, getBranchSegmentEndpoints, getTrunkSegmentEndpoints } from '../SupportPrimitives/Knot/knotUtils';
import type { Branch, Knot, Trunk } from '../types';
import type { SupportState } from '../types';

export type JointDragPreviewKind = 'trunk' | 'branch';

export interface JointDragPreviewPayload<TSupport = unknown> {
  kind: JointDragPreviewKind;
  supportId: string;
  support: TSupport | null;
}

export type JointDragPreviewSnapshot = JointDragPreviewPayload<Trunk | Branch>;

const EVENT_NAME = 'dragonfruit-joint-drag-preview';

export function emitJointDragPreview<TSupport>(payload: JointDragPreviewPayload<TSupport>) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<JointDragPreviewPayload<TSupport>>(EVENT_NAME, { detail: payload }));
}

export function clearJointDragPreview(kind: JointDragPreviewKind, supportId: string) {
  emitJointDragPreview({ kind, supportId, support: null });
}

export function useJointDragPreview<TSupport>(kind: JointDragPreviewKind, supportId: string) {
  const [previewSupport, setPreviewSupport] = React.useState<TSupport | null>(null);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const handlePreview = (event: Event) => {
      const detail = (event as CustomEvent<JointDragPreviewPayload<TSupport>>).detail;
      if (!detail) return;
      if (detail.kind !== kind || detail.supportId !== supportId) return;
      setPreviewSupport(detail.support ?? null);
    };

    window.addEventListener(EVENT_NAME, handlePreview as EventListener);
    return () => window.removeEventListener(EVENT_NAME, handlePreview as EventListener);
  }, [kind, supportId]);

  return previewSupport;
}

export function useActiveJointDragPreview() {
  const [preview, setPreview] = React.useState<JointDragPreviewSnapshot | null>(null);
  const pendingPreviewRef = React.useRef<JointDragPreviewSnapshot | null>(null);
  const frameRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const handlePreview = (event: Event) => {
      const detail = (event as CustomEvent<JointDragPreviewPayload<Trunk | Branch>>).detail;
      if (!detail) return;

      pendingPreviewRef.current = detail.support ? detail : null;
      if (frameRef.current !== null) return;

      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        setPreview(pendingPreviewRef.current);
      });
    };

    window.addEventListener(EVENT_NAME, handlePreview as EventListener);
    return () => {
      window.removeEventListener(EVENT_NAME, handlePreview as EventListener);
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      pendingPreviewRef.current = null;
    };
  }, []);

  return preview;
}

function getSupportPreviewKnotsFromTrunk(trunk: Trunk, state: Pick<SupportState, 'roots' | 'knots'>) {
  const nextKnots: Record<string, Knot> = {};
  const root = state.roots[trunk.rootId];
  if (!root) return nextKnots;

  for (const knot of Object.values(state.knots)) {
    const segIndex = trunk.segments.findIndex((segment) => segment.id === knot.parentShaftId);
    if (segIndex === -1) continue;

    const segment = trunk.segments[segIndex];
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

function getSupportPreviewKnotsFromBranch(branch: Branch, state: Pick<SupportState, 'knots'>) {
  const nextKnots: Record<string, Knot> = {};
  const parentKnot = state.knots[branch.parentKnotId];
  if (!parentKnot) return nextKnots;

  for (const knot of Object.values(state.knots)) {
    const segIndex = branch.segments.findIndex((segment) => segment.id === knot.parentShaftId);
    if (segIndex === -1) continue;

    const segment = branch.segments[segIndex];
    const endpoints = getBranchSegmentEndpoints(branch, segment, segIndex, parentKnot);
    if (!endpoints || knot.t === undefined) continue;

    nextKnots[knot.id] = {
      ...knot,
      pos: calculateKnotPositionOnSegmentFromT(endpoints.start, endpoints.end, segment, knot.t),
    };
  }

  return nextKnots;
}

export function buildJointDragPreviewKnots(
  preview: JointDragPreviewSnapshot | null,
  state: Pick<SupportState, 'roots' | 'knots'>
) {
  if (!preview?.support) return {};
  if (preview.kind === 'trunk') {
    return getSupportPreviewKnotsFromTrunk(preview.support, state);
  }
  return getSupportPreviewKnotsFromBranch(preview.support, state);
}