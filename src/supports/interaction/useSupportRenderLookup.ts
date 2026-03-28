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

// Worker request timeout: if no response after 5s, assume worker is dead
const WORKER_REQUEST_TIMEOUT_MS = 5000;

interface PendingWorkerRequest {
  requestId: number;
  timeout: number;
  timestamp: number;
}

export function useSupportRenderLookup(options: UseSupportRenderLookupOptions): SupportRenderLookupSnapshot {
  const [lookup, setLookup] = React.useState<SupportRenderLookupSnapshot>(EMPTY_LOOKUP);
  const workerRef = React.useRef<Worker | null>(null);
  const requestSeqRef = React.useRef(1);
  const latestAppliedRequestRef = React.useRef(0);
  const pendingRequestsRef = React.useRef<Map<number, PendingWorkerRequest>>(new Map());
  const workerHealthRef = React.useRef({ isHealthy: true, failureCount: 0 });
  const timeoutCheckIntervalRef = React.useRef<NodeJS.Timeout | null>(null);
  const respawnScheduledRef = React.useRef(false);

  // Initiate worker respawn (deferred to avoid immediate recursive calls)
  const scheduleWorkerRespawn = React.useCallback(() => {
    if (respawnScheduledRef.current) return;
    respawnScheduledRef.current = true;
    
    setTimeout(() => {
      respawnScheduledRef.current = false;
      // Clear refs and trigger useEffect to recreate worker
      workerRef.current = null;
      workerHealthRef.current = { isHealthy: true, failureCount: 0 };
    }, 100);
  }, []);

  // Respawn worker — setup/teardown function
  React.useEffect(() => {
    if (typeof Worker === 'undefined') return;

    // Only respawn if worker is null
    if (workerRef.current) return;

    try {
      const worker = new Worker(new URL('./supportRenderLookup.worker.ts', import.meta.url), { type: 'module' });
      workerRef.current = worker;

      worker.onmessage = (event: MessageEvent<{ requestId: number; snapshot: SupportRenderLookupSnapshot }>) => {
        const msg = event.data;
        if (!msg || msg.requestId < latestAppliedRequestRef.current) return;

        // Mark request as complete
        pendingRequestsRef.current.delete(msg.requestId);

        // Worker is healthy, reset failure count
        if (workerHealthRef.current.failureCount > 0) {
          console.debug('[SupportRenderLookup] Worker recovered after', workerHealthRef.current.failureCount, 'failures');
        }
        workerHealthRef.current = { isHealthy: true, failureCount: 0 };

        latestAppliedRequestRef.current = msg.requestId;
        setLookup(msg.snapshot);
      };

      worker.onerror = () => {
        console.error('[SupportRenderLookup] Worker error detected');
        workerRef.current = null;
        workerHealthRef.current.isHealthy = false;
        workerHealthRef.current.failureCount++;

        // Clear all pending requests on worker error
        pendingRequestsRef.current.clear();

        // Schedule respawn after a brief delay to avoid tight retry loops
        scheduleWorkerRespawn();
      };
    } catch (err) {
      console.error('[SupportRenderLookup] Failed to create worker:', err);
      workerRef.current = null;
      workerHealthRef.current.failureCount++;
    }

    return () => {
      if (workerRef.current) {
        try {
          workerRef.current.terminate();
        } catch {
          // Already terminated
        }
      }
      workerRef.current = null;
    };
  }, [scheduleWorkerRespawn]);

  // Health monitoring: detect stalled requests that never respond
  React.useEffect(() => {
    const checkTimeouts = () => {
      const now = performance.now();
      const stalled: number[] = [];

      for (const [requestId, pending] of pendingRequestsRef.current.entries()) {
        if (now - pending.timestamp > WORKER_REQUEST_TIMEOUT_MS) {
          stalled.push(requestId);
        }
      }

      if (stalled.length > 0) {
        console.warn('[SupportRenderLookup] Worker timeout detected for requests:', stalled, '— respawning worker');
        workerHealthRef.current.failureCount++;
        workerRef.current = null;
        pendingRequestsRef.current.clear();
        scheduleWorkerRespawn();
      }
    };

    timeoutCheckIntervalRef.current = setInterval(checkTimeouts, 1000);

    return () => {
      if (timeoutCheckIntervalRef.current) {
        clearInterval(timeoutCheckIntervalRef.current);
      }
    };
  }, [scheduleWorkerRespawn]);

  React.useEffect(() => {
    return () => {
      if (timeoutCheckIntervalRef.current) {
        clearInterval(timeoutCheckIntervalRef.current);
      }
    };
  }, []);

  React.useEffect(() => {
    const worker = workerRef.current;
    if (!worker) {
      // Fall back to main thread computation if worker is unavailable
      const snapshot = computeSupportRenderLookup(options);
      setLookup(snapshot);
      if (workerHealthRef.current.failureCount > 0) {
        console.debug('[SupportRenderLookup] Using main-thread fallback; worker failure#', workerHealthRef.current.failureCount);
      }
      return;
    }

    const requestId = requestSeqRef.current++;
    const now = performance.now();

    // Track pending request for timeout detection
    pendingRequestsRef.current.set(requestId, {
      requestId,
      timeout: WORKER_REQUEST_TIMEOUT_MS,
      timestamp: now,
    });

    try {
      worker.postMessage({ requestId, input: options });
    } catch (err) {
      console.error('[SupportRenderLookup] Failed to post message to worker:', err);
      pendingRequestsRef.current.delete(requestId);
      workerRef.current = null;
      workerHealthRef.current.failureCount++;
      // Fall back to main thread
      const snapshot = computeSupportRenderLookup(options);
      setLookup(snapshot);
    }
  }, [options]);

  return lookup;
}
