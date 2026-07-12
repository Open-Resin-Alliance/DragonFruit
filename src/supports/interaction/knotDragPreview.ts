import React from 'react';
import type { Branch, Knot } from '../types';
import { subscribeSupportInteractionReset } from './supportInteractionReset';

const EVENT_NAME = 'dragonfruit-knot-drag-preview';

export interface KnotDragPreviewSnapshot {
  knotId: string;
  knot: Knot;
  branchSegmentsById: Record<string, Branch['segments']>;
  coincidentKnots?: Knot[];
}

export function emitKnotDragPreview(snapshot: KnotDragPreviewSnapshot) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<KnotDragPreviewSnapshot>(EVENT_NAME, { detail: snapshot }));
}

export function clearKnotDragPreview() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<KnotDragPreviewSnapshot | null>(EVENT_NAME, { detail: null }));
}

export function useActiveKnotDragPreview() {
  const [preview, setPreview] = React.useState<KnotDragPreviewSnapshot | null>(null);
  const pendingPreviewRef = React.useRef<KnotDragPreviewSnapshot | null>(null);
  const frameRef = React.useRef<number | null>(null);

  const schedulePreview = React.useCallback((nextPreview: KnotDragPreviewSnapshot | null) => {
    pendingPreviewRef.current = nextPreview;
    if (frameRef.current !== null) return;

    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      setPreview(pendingPreviewRef.current);
    });
  }, []);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const handlePreview = (event: Event) => {
      const detail = (event as CustomEvent<KnotDragPreviewSnapshot | null>).detail;
      schedulePreview(detail ?? null);
    };

    window.addEventListener(EVENT_NAME, handlePreview as EventListener);
    const unsubscribeReset = subscribeSupportInteractionReset(() => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      pendingPreviewRef.current = null;
      setPreview(null);
    });

    return () => {
      unsubscribeReset();
      window.removeEventListener(EVENT_NAME, handlePreview as EventListener);
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      pendingPreviewRef.current = null;
    };
  }, [schedulePreview]);

  return preview;
}
