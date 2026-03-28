import React from 'react';
import type { SupportState } from '../types';
import type { KickstandState } from '../SupportTypes/Kickstand/types';
import { type SupportRenderLookupSnapshot } from './supportRenderLookupMath';

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

const WORKER_REQUEST_TIMEOUT_MS = 5000;
const WORKER_RESPAWN_DELAY_MS = 150;

type PendingRequestInfo = {
  requestId: number;
  startedAt: number;
  version: number;
};

type WorkerHealth = {
  failureCount: number;
  lastFailureReason: string | null;
};

export function useSupportRenderLookup(options: UseSupportRenderLookupOptions): SupportRenderLookupSnapshot {
  const [lookup, setLookup] = React.useState<SupportRenderLookupSnapshot>(EMPTY_LOOKUP);
  const [workerGeneration, setWorkerGeneration] = React.useState(0);

  const workerRef = React.useRef<Worker | null>(null);
  const pendingRequestRef = React.useRef<PendingRequestInfo | null>(null);
  const requestVersionRef = React.useRef(0);
  const latestAppliedRequestRef = React.useRef(0);
  const latestOptionsRef = React.useRef(options);
  const workerHealthRef = React.useRef<WorkerHealth>({ failureCount: 0, lastFailureReason: null });
  const restartTimerRef = React.useRef<number | null>(null);
  const flushTimerRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    latestOptionsRef.current = options;
    requestVersionRef.current += 1;
  }, [options]);

  const restartWorker = React.useCallback((reason: string) => {
    workerHealthRef.current = {
      failureCount: workerHealthRef.current.failureCount + 1,
      lastFailureReason: reason,
    };

    pendingRequestRef.current = null;

    const worker = workerRef.current;
    if (worker) {
      try {
        worker.terminate();
      } catch {
        // already dead
      }
      workerRef.current = null;
    }

    if (restartTimerRef.current !== null) return;

    restartTimerRef.current = window.setTimeout(() => {
      restartTimerRef.current = null;
      setWorkerGeneration((generation) => generation + 1);
    }, WORKER_RESPAWN_DELAY_MS);
  }, []);

  const flushLatestRequest = React.useCallback(() => {
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }

    const worker = workerRef.current;
    if (!worker) return;
    if (pendingRequestRef.current) return;

    const version = requestVersionRef.current;
    const requestId = latestAppliedRequestRef.current + 1;
    const startedAt = performance.now();

    pendingRequestRef.current = { requestId, startedAt, version };

    try {
      worker.postMessage({ requestId, input: latestOptionsRef.current });
    } catch (error) {
      console.error('[SupportRenderLookup] Failed to post request to worker:', error);
      pendingRequestRef.current = null;
      restartWorker('postMessage');
    }
  }, [restartWorker]);

  const scheduleFlush = React.useCallback(() => {
    if (flushTimerRef.current !== null) return;

    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null;
      flushLatestRequest();
    }, 0);
  }, [flushLatestRequest]);

  React.useEffect(() => {
    if (typeof Worker === 'undefined') return;

    const worker = new Worker(new URL('./supportRenderLookup.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    const timeoutId = window.setInterval(() => {
      const pending = pendingRequestRef.current;
      if (!pending) return;

      if (performance.now() - pending.startedAt <= WORKER_REQUEST_TIMEOUT_MS) return;

      console.warn('[SupportRenderLookup] Worker request timed out:', pending.requestId);
      restartWorker(`timeout:${pending.requestId}`);
    }, 1000);

    worker.onmessage = (event: MessageEvent<{ requestId: number; snapshot: SupportRenderLookupSnapshot }>) => {
      const msg = event.data;
      const pending = pendingRequestRef.current;
      if (!msg || !pending || msg.requestId !== pending.requestId) return;

      pendingRequestRef.current = null;

      if (workerHealthRef.current.failureCount > 0) {
        console.debug(
          '[SupportRenderLookup] Worker recovered after',
          workerHealthRef.current.failureCount,
          'failures',
        );
      }
      workerHealthRef.current = { failureCount: 0, lastFailureReason: null };

      latestAppliedRequestRef.current = msg.requestId;
      setLookup(msg.snapshot);

      if (requestVersionRef.current > pending.version) {
        scheduleFlush();
      }
    };

    worker.onerror = (event) => {
      console.error('[SupportRenderLookup] Worker error detected', event.message || event.error || event);
      restartWorker('error');
    };

    scheduleFlush();

    return () => {
      window.clearInterval(timeoutId);

      if (restartTimerRef.current !== null) {
        window.clearTimeout(restartTimerRef.current);
        restartTimerRef.current = null;
      }

      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }

      pendingRequestRef.current = null;

      if (workerRef.current === worker) {
        workerRef.current = null;
      }

      try {
        worker.terminate();
      } catch {
        // already terminated
      }
    };
  }, [restartWorker, scheduleFlush, workerGeneration]);

  React.useEffect(() => {
    scheduleFlush();
  }, [options, scheduleFlush]);

  React.useEffect(() => {
    return () => {
      if (restartTimerRef.current !== null) {
        window.clearTimeout(restartTimerRef.current);
        restartTimerRef.current = null;
      }
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    };
  }, []);

  return lookup;
}
