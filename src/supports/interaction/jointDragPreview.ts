import React from 'react';
import type { Knot, Roots } from '../types';
import { computeJointDragPreviewKnots, type JointDragPreviewCandidateKnots, type JointDragPreviewContext, type JointDragPreviewKind, type JointDragPreviewPayload, type JointDragPreviewSnapshot } from './jointDragPreviewMath';
import type { PartDragPreviewPayload } from './partDragPreview';

const EVENT_NAME = 'dragonfruit-joint-drag-preview';
const PART_EVENT_NAME = 'dragonfruit-part-drag-update';
const EMPTY_PREVIEW_KNOTS: Record<string, Knot> = {};

interface UseJointDragPreviewOverridesOptions {
  roots: Record<string, Roots>;
  knots: Record<string, Knot>;
  kickstandKnots?: Record<string, Knot>;
  candidateKnots: JointDragPreviewCandidateKnots;
}

export type { JointDragPreviewKind, JointDragPreviewPayload, JointDragPreviewSnapshot } from './jointDragPreviewMath';

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

  const schedulePreview = React.useCallback((nextPreview: JointDragPreviewSnapshot | null) => {
    pendingPreviewRef.current = nextPreview;
    if (frameRef.current !== null) return;

    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      setPreview(pendingPreviewRef.current);
    });
  }, []);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const isJointPreviewKind = (kind: string): kind is JointDragPreviewKind => {
      return kind === 'trunk' || kind === 'branch' || kind === 'kickstand';
    };

    const handlePreview = (event: Event) => {
      const detail = (event as CustomEvent<JointDragPreviewPayload<unknown>>).detail;
      if (!detail) return;

      schedulePreview(detail.support ? (detail as JointDragPreviewSnapshot) : null);
    };

    const handlePartPreview = (event: Event) => {
      const detail = (event as CustomEvent<PartDragPreviewPayload<unknown>>).detail;
      if (!detail) return;
      if (!isJointPreviewKind(detail.kind)) return;

      const nextPreview: JointDragPreviewSnapshot | null = detail.support
        ? {
          kind: detail.kind,
          supportId: detail.supportId,
          support: detail.support as JointDragPreviewSnapshot['support'],
        }
        : null;

      schedulePreview(nextPreview);
    };

    window.addEventListener(EVENT_NAME, handlePreview as EventListener);
    window.addEventListener(PART_EVENT_NAME, handlePartPreview as EventListener);
    return () => {
      window.removeEventListener(EVENT_NAME, handlePreview as EventListener);
      window.removeEventListener(PART_EVENT_NAME, handlePartPreview as EventListener);
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      pendingPreviewRef.current = null;
    };
  }, [schedulePreview]);

  return preview;
}

export function useJointDragPreviewOverrides({ roots, knots, kickstandKnots, candidateKnots }: UseJointDragPreviewOverridesOptions) {
  const preview = useActiveJointDragPreview();

  return React.useMemo(() => {
    if (!preview) {
      return EMPTY_PREVIEW_KNOTS;
    }

    const context: JointDragPreviewContext = preview.kind === 'trunk'
      ? { root: roots[preview.support.rootId] ?? null }
      : preview.kind === 'kickstand'
        ? {
          root: roots[preview.support.rootId] ?? null,
          hostKnot: kickstandKnots?.[preview.support.hostKnotId] ?? knots[preview.support.hostKnotId] ?? null,
        }
        : { parentKnot: knots[preview.support.parentKnotId] ?? null };

    return computeJointDragPreviewKnots(preview, context, candidateKnots);
  }, [preview, roots, knots, kickstandKnots, candidateKnots]);
}