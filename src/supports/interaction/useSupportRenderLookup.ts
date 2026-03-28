import React from 'react';
import type { SupportState } from '../types';
import type { KickstandState } from '../SupportTypes/Kickstand/types';
import type { SupportRenderLookupInput, SupportRenderLookupSnapshot } from './supportRenderLookupMath';
import { isSupportEditInteractionActive } from './gizmoInteractionLock';

interface UseSupportRenderLookupOptions {
  state: Pick<SupportState, 'roots' | 'trunks' | 'branches' | 'leaves' | 'twigs' | 'sticks' | 'braces' | 'knots'>;
  kickstandState: Pick<KickstandState, 'kickstands' | 'knots'>;
  activePreviewSupport?: {
    kind: 'trunk' | 'branch' | 'kickstand' | null;
    support: { segments: Array<{ id: string }> } | null;
  } | null;
}

type WorkerRequest = {
  requestId: number;
  input: SupportRenderLookupInput;
};

type WorkerResponse = {
  requestId: number;
  snapshot: SupportRenderLookupSnapshot;
};

const REQUEST_TIMEOUT_MS = 5000;
const WORKER_RESTART_BACKOFF_MS = 100;

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
  const latestOptionsRef = React.useRef<SupportRenderLookupInput>(options);
  const latestAppliedRequestIdRef = React.useRef(0);
  const nextRequestIdRef = React.useRef(1);
  const inFlightRequestIdRef = React.useRef<number | null>(null);
  const hasQueuedWorkRef = React.useRef(false);
  const requestTimeoutRef = React.useRef<number | null>(null);
  const restartTimerRef = React.useRef<number | null>(null);
  const interactionFlushRafRef = React.useRef<number | null>(null);

  const clearRequestTimeout = React.useCallback(() => {
    if (requestTimeoutRef.current !== null) {
      window.clearTimeout(requestTimeoutRef.current);
      requestTimeoutRef.current = null;
    }
  }, []);

  const terminateWorker = React.useCallback(() => {
    clearRequestTimeout();
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    inFlightRequestIdRef.current = null;
  }, [clearRequestTimeout]);

  const postLatestRequestRef = React.useRef<(() => void) | null>(null);

  const cancelInteractionFlushRaf = React.useCallback(() => {
    if (interactionFlushRafRef.current !== null) {
      window.cancelAnimationFrame(interactionFlushRafRef.current);
      interactionFlushRafRef.current = null;
    }
  }, []);

  const scheduleFlushAfterInteraction = React.useCallback(() => {
    if (interactionFlushRafRef.current !== null) return;

    const tick = () => {
      interactionFlushRafRef.current = null;

      if (isSupportEditInteractionActive()) {
        interactionFlushRafRef.current = window.requestAnimationFrame(tick);
        return;
      }

      if (hasQueuedWorkRef.current && postLatestRequestRef.current) {
        hasQueuedWorkRef.current = false;
        postLatestRequestRef.current();
      }
    };

    interactionFlushRafRef.current = window.requestAnimationFrame(tick);
  }, []);

  const createWorker = React.useCallback(() => {
    const worker = new Worker(new URL('./supportRenderLookup.worker.ts', import.meta.url), { type: 'module' });

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const data = event.data;
      if (!data || typeof data.requestId !== 'number') return;

      if (inFlightRequestIdRef.current !== data.requestId) {
        // Ignore stale/out-of-order responses.
        return;
      }

      clearRequestTimeout();
      inFlightRequestIdRef.current = null;

      if (data.requestId >= latestAppliedRequestIdRef.current) {
        latestAppliedRequestIdRef.current = data.requestId;
        setLookup(data.snapshot ?? EMPTY_LOOKUP);
      }

      if (hasQueuedWorkRef.current) {
        if (isSupportEditInteractionActive()) {
          scheduleFlushAfterInteraction();
        } else if (postLatestRequestRef.current) {
          hasQueuedWorkRef.current = false;
          postLatestRequestRef.current();
        }
      }
    };

    worker.onerror = (error) => {
      console.error('[SupportRenderLookup] Worker error, restarting:', error);
      terminateWorker();
      if (restartTimerRef.current !== null) {
        window.clearTimeout(restartTimerRef.current);
      }
      restartTimerRef.current = window.setTimeout(() => {
        restartTimerRef.current = null;
        workerRef.current = createWorker();
        if (postLatestRequestRef.current) {
          postLatestRequestRef.current();
        }
      }, WORKER_RESTART_BACKOFF_MS);
    };

    return worker;
  }, [clearRequestTimeout, terminateWorker]);

  const postLatestRequest = React.useCallback(() => {
    if (isSupportEditInteractionActive()) {
      hasQueuedWorkRef.current = true;
      scheduleFlushAfterInteraction();
      return;
    }

    if (!workerRef.current) {
      workerRef.current = createWorker();
    }

    if (inFlightRequestIdRef.current !== null) {
      hasQueuedWorkRef.current = true;
      return;
    }

    const requestId = nextRequestIdRef.current++;
    const request: WorkerRequest = {
      requestId,
      input: latestOptionsRef.current,
    };

    try {
      inFlightRequestIdRef.current = requestId;
      workerRef.current.postMessage(request);

      clearRequestTimeout();
      requestTimeoutRef.current = window.setTimeout(() => {
        const stuckRequest = inFlightRequestIdRef.current;
        if (stuckRequest !== requestId) return;

        console.warn('[SupportRenderLookup] Worker request timed out, restarting worker (request', requestId, ')');
        terminateWorker();
        workerRef.current = createWorker();

        inFlightRequestIdRef.current = null;
        hasQueuedWorkRef.current = true;

        if (postLatestRequestRef.current) {
          postLatestRequestRef.current();
        }
      }, REQUEST_TIMEOUT_MS);
    } catch (error) {
      console.error('[SupportRenderLookup] Failed to post worker request:', error);
      inFlightRequestIdRef.current = null;
      terminateWorker();
      workerRef.current = createWorker();
      hasQueuedWorkRef.current = true;
      if (postLatestRequestRef.current) {
        postLatestRequestRef.current();
      }
    }
  }, [clearRequestTimeout, createWorker, scheduleFlushAfterInteraction, terminateWorker]);

  React.useEffect(() => {
    postLatestRequestRef.current = postLatestRequest;
  }, [postLatestRequest]);

  React.useEffect(() => {
    latestOptionsRef.current = options;
    if (postLatestRequestRef.current) {
      postLatestRequestRef.current();
    }
  }, [
    options.state.roots,
    options.state.trunks,
    options.state.branches,
    options.state.leaves,
    options.state.twigs,
    options.state.sticks,
    options.state.braces,
    options.state.knots,
    options.kickstandState.kickstands,
    options.kickstandState.knots,
    options.activePreviewSupport,
  ]);

  React.useEffect(() => {
    return () => {
      cancelInteractionFlushRaf();
      if (restartTimerRef.current !== null) {
        window.clearTimeout(restartTimerRef.current);
        restartTimerRef.current = null;
      }
      terminateWorker();
    };
  }, [cancelInteractionFlushRaf, terminateWorker]);

  return lookup;
}
