import React from 'react';
import type { SupportState } from '../types';
import type { KickstandState } from '../SupportTypes/Kickstand/types';
import { computeSupportRenderLookup, type SupportRenderLookupSnapshot } from './supportRenderLookupMath';

interface UseSupportRenderLookupOptions {
  state: Pick<SupportState, 'roots' | 'trunks' | 'branches' | 'leaves' | 'twigs' | 'sticks' | 'braces' | 'knots'>;
  kickstandState: Pick<KickstandState, 'kickstands' | 'knots'>;
  activePreviewSupport?: {
    kind: 'trunk' | 'branch' | 'kickstand' | null;
    support: { segments: Array<{ id: string }> } | null;
  } | null;
}

const EMPTY_LOOKUP: SupportRenderLookupSnapshot = {
  supportIdBySegmentId: {},
  supportIdByJointId: {},
  supportIdByKnotId: {},
  supportIdByContactDiskId: {},
  entitySegmentModelIdById: {},
  entityModelIdByKnotId: {},
  knotIdsByParentShaftId: {},
  kickstandKnotIdsByParentShaftId: {},
  previewCandidateKnots: {},
};

export function useSupportRenderLookup(options: UseSupportRenderLookupOptions): SupportRenderLookupSnapshot {
  const [lookup, setLookup] = React.useState<SupportRenderLookupSnapshot>(EMPTY_LOOKUP);
  const workerRef = React.useRef<Worker | null>(null);
  const requestSeqRef = React.useRef(1);
  const latestAppliedRequestRef = React.useRef(0);

  React.useEffect(() => {
    if (typeof Worker === 'undefined') return;

    const worker = new Worker(new URL('./supportRenderLookup.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<{ requestId: number; snapshot: SupportRenderLookupSnapshot }>) => {
      const msg = event.data;
      if (!msg || msg.requestId < latestAppliedRequestRef.current) return;
      latestAppliedRequestRef.current = msg.requestId;
      setLookup(msg.snapshot);
    };

    worker.onerror = (event) => {
      console.error('[SupportRenderLookup] Worker failed', event.message || event.error || event);
      workerRef.current = null;
    };

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  React.useEffect(() => {
    const worker = workerRef.current;
    if (!worker) {
      setLookup(computeSupportRenderLookup(options));
      return;
    }

    const requestId = requestSeqRef.current++;
    worker.postMessage({ requestId, input: options });
  }, [options]);

  return lookup;
}
