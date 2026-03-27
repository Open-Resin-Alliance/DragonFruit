import React from 'react';
import type { Knot, Roots } from '../types';
import { computeJointDragPreviewKnots, type JointDragPreviewCandidateKnots, type JointDragPreviewContext, type JointDragPreviewKind, type JointDragPreviewPayload, type JointDragPreviewSnapshot } from './jointDragPreviewMath';

const EVENT_NAME = 'dragonfruit-joint-drag-preview';

interface JointDragPreviewWorkerResponse {
  requestId: number;
  previewKnots: Record<string, Knot>;
}

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

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const handlePreview = (event: Event) => {
      const detail = (event as CustomEvent<JointDragPreviewPayload<unknown>>).detail;
      if (!detail) return;

      pendingPreviewRef.current = detail.support ? (detail as JointDragPreviewSnapshot) : null;
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

export function useJointDragPreviewOverrides({ roots, knots, kickstandKnots, candidateKnots }: UseJointDragPreviewOverridesOptions) {
  const preview = useActiveJointDragPreview();
  const [previewKnots, setPreviewKnots] = React.useState<Record<string, Knot>>({});
  const workerRef = React.useRef<Worker | null>(null);
  const workerReadyRef = React.useRef(false);
  const requestSeqRef = React.useRef(1);
  const latestAppliedRequestRef = React.useRef(0);

  React.useEffect(() => {
    if (typeof Worker === 'undefined') return;

    const worker = new Worker(new URL('./jointDragPreview.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    workerReadyRef.current = true;

    worker.onmessage = (event: MessageEvent<JointDragPreviewWorkerResponse>) => {
      const msg = event.data;
      if (!msg || msg.requestId < latestAppliedRequestRef.current) return;
      latestAppliedRequestRef.current = msg.requestId;
      setPreviewKnots(msg.previewKnots);
    };

    worker.onerror = (event) => {
      console.error('[JointDragPreview] Worker failed', event.message || event.error || event);
      workerReadyRef.current = false;
      workerRef.current = null;
    };

    return () => {
      worker.terminate();
      workerReadyRef.current = false;
      workerRef.current = null;
    };
  }, []);

  React.useEffect(() => {
    if (!preview) {
      setPreviewKnots({});
      return;
    }

    const context: JointDragPreviewContext = preview.kind === 'trunk'
      ? { root: roots[preview.support.rootId] ?? null }
      : preview.kind === 'kickstand'
        ? {
          root: roots[preview.support.rootId] ?? null,
          hostKnot: kickstandKnots?.[preview.support.hostKnotId] ?? knots[preview.support.hostKnotId] ?? null,
        }
        : { parentKnot: knots[preview.support.parentKnotId] ?? null };

    const immediatePreviewKnots = computeJointDragPreviewKnots(preview, context, candidateKnots);
    setPreviewKnots(immediatePreviewKnots);

    if (!workerReadyRef.current || !workerRef.current) {
      return;
    }

    const requestId = requestSeqRef.current++;
    workerRef.current.postMessage({
      requestId,
      preview,
      ...context,
      candidateKnots,
    });
  }, [preview, roots, knots, kickstandKnots, candidateKnots]);

  return previewKnots;
}