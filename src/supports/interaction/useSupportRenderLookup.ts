import React from 'react';
import type { SupportState } from '../types';
import type { KickstandState } from '../SupportTypes/Kickstand/types';
import { computeSupportRenderLookup, type SupportRenderLookupInput, type SupportRenderLookupSnapshot } from './supportRenderLookupMath';
import { isSupportEditInteractionActive } from './gizmoInteractionLock';
import { getSupportWorkerRuntimeCapabilities } from './supportWorkerCapabilities';
import { isSupportWorkerSafetyModeEnabled } from './supportWorkerSafetyMode';
import type {
  RecordDelta,
  SupportLookupCollections,
  SupportLookupInputDelta,
  SupportLookupKickstandCollections,
  SupportRenderLookupWorkerRequestMessage,
  SupportRenderLookupWorkerResponseMessage,
} from './supportRenderLookup.worker.shared';

interface UseSupportRenderLookupOptions {
  state: Pick<SupportState, 'roots' | 'trunks' | 'branches' | 'leaves' | 'twigs' | 'sticks' | 'braces' | 'knots'>;
  kickstandState: Pick<KickstandState, 'kickstands' | 'knots'>;
  activePreviewSupport?: {
    kind: 'trunk' | 'branch' | 'kickstand' | null;
    support: { segments: Array<{ id: string }> } | null;
  } | null;
}

type WorkerCollectionsRef = {
  state: SupportLookupCollections;
  kickstandState: SupportLookupKickstandCollections;
  activePreviewSupport: SupportRenderLookupInput['activePreviewSupport'];
};

function createEmptyWorkerCollectionsRef(): WorkerCollectionsRef {
  return {
    state: {
      roots: {},
      trunks: {},
      branches: {},
      leaves: {},
      twigs: {},
      sticks: {},
      braces: {},
      knots: {},
    },
    kickstandState: {
      kickstands: {},
      knots: {},
    },
    activePreviewSupport: null,
  };
}

type MutableRecord<T> = Record<string, T>;

function diffRecordByRef<T>(prev: Record<string, T>, next: Record<string, T>, forceFullSync: boolean): RecordDelta<T> | undefined {
  if (!forceFullSync && prev === next) return undefined;

  const upserts: Record<string, T> = {};
  const deleteIds: string[] = [];

  for (const [id, value] of Object.entries(next)) {
    if (forceFullSync || prev[id] !== value) {
      upserts[id] = value;
    }
  }

  for (const id of Object.keys(prev)) {
    if (!(id in next)) {
      deleteIds.push(id);
    }
  }

  if (Object.keys(upserts).length === 0 && deleteIds.length === 0) {
    return undefined;
  }

  return { upserts, deleteIds };
}

function applyRecordDeltaInPlace<T>(target: MutableRecord<T>, delta?: RecordDelta<T>) {
  if (!delta) return;

  for (const id of delta.deleteIds) {
    delete target[id];
  }

  for (const [id, value] of Object.entries(delta.upserts)) {
    target[id] = value;
  }
}

function buildInputDelta(
  latest: SupportRenderLookupInput,
  workerCollectionsRef: WorkerCollectionsRef,
  forceFullSync: boolean,
): SupportLookupInputDelta | null {
  const stateDelta = {
    roots: diffRecordByRef(workerCollectionsRef.state.roots, latest.state.roots, forceFullSync),
    trunks: diffRecordByRef(workerCollectionsRef.state.trunks, latest.state.trunks, forceFullSync),
    branches: diffRecordByRef(workerCollectionsRef.state.branches, latest.state.branches, forceFullSync),
    leaves: diffRecordByRef(workerCollectionsRef.state.leaves, latest.state.leaves, forceFullSync),
    twigs: diffRecordByRef(workerCollectionsRef.state.twigs, latest.state.twigs, forceFullSync),
    sticks: diffRecordByRef(workerCollectionsRef.state.sticks, latest.state.sticks, forceFullSync),
    braces: diffRecordByRef(workerCollectionsRef.state.braces, latest.state.braces, forceFullSync),
    knots: diffRecordByRef(workerCollectionsRef.state.knots, latest.state.knots, forceFullSync),
  };

  const kickstandStateDelta = {
    kickstands: diffRecordByRef(workerCollectionsRef.kickstandState.kickstands, latest.kickstandState.kickstands, forceFullSync),
    knots: diffRecordByRef(workerCollectionsRef.kickstandState.knots, latest.kickstandState.knots, forceFullSync),
  };

  const activePreviewSupportChanged = forceFullSync || workerCollectionsRef.activePreviewSupport !== latest.activePreviewSupport;

  const hasStateDelta = Boolean(
    stateDelta.roots ||
    stateDelta.trunks ||
    stateDelta.branches ||
    stateDelta.leaves ||
    stateDelta.twigs ||
    stateDelta.sticks ||
    stateDelta.braces ||
    stateDelta.knots,
  );

  const hasKickstandDelta = Boolean(kickstandStateDelta.kickstands || kickstandStateDelta.knots);

  if (!hasStateDelta && !hasKickstandDelta && !activePreviewSupportChanged) {
    return null;
  }

  return {
    state: hasStateDelta ? stateDelta : undefined,
    kickstandState: hasKickstandDelta ? kickstandStateDelta : undefined,
    activePreviewSupport: activePreviewSupportChanged ? latest.activePreviewSupport : undefined,
    activePreviewSupportChanged,
  };
}

function applyDeltaToWorkerCollectionsRef(target: WorkerCollectionsRef, delta: SupportLookupInputDelta) {
  if (delta.state) {
    applyRecordDeltaInPlace(target.state.roots, delta.state.roots);
    applyRecordDeltaInPlace(target.state.trunks, delta.state.trunks);
    applyRecordDeltaInPlace(target.state.branches, delta.state.branches);
    applyRecordDeltaInPlace(target.state.leaves, delta.state.leaves);
    applyRecordDeltaInPlace(target.state.twigs, delta.state.twigs);
    applyRecordDeltaInPlace(target.state.sticks, delta.state.sticks);
    applyRecordDeltaInPlace(target.state.braces, delta.state.braces);
    applyRecordDeltaInPlace(target.state.knots, delta.state.knots);
  }

  if (delta.kickstandState) {
    applyRecordDeltaInPlace(target.kickstandState.kickstands, delta.kickstandState.kickstands);
    applyRecordDeltaInPlace(target.kickstandState.knots, delta.kickstandState.knots);
  }

  if (delta.activePreviewSupportChanged) {
    target.activePreviewSupport = delta.activePreviewSupport ?? null;
  }
}

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
  const workerCapabilities = React.useMemo(() => getSupportWorkerRuntimeCapabilities(), []);
  const supportsWorkerSafeMode = React.useMemo(() => isSupportWorkerSafetyModeEnabled(), []);
  const [lookup, setLookup] = React.useState<SupportRenderLookupSnapshot>(EMPTY_LOOKUP);

  const workerRef = React.useRef<Worker | null>(null);
  const cancelSignalRef = React.useRef<SharedArrayBuffer | null>(null);
  const cancelSignalViewRef = React.useRef<Int32Array | null>(null);
  const latestOptionsRef = React.useRef<SupportRenderLookupInput>(options);
  const latestAppliedRequestIdRef = React.useRef(0);
  const nextRequestIdRef = React.useRef(1);
  const inFlightRequestIdRef = React.useRef<number | null>(null);
  const hasQueuedWorkRef = React.useRef(false);
  const requestTimeoutRef = React.useRef<number | null>(null);
  const restartTimerRef = React.useRef<number | null>(null);
  const interactionFlushRafRef = React.useRef<number | null>(null);
  const workerCollectionsRef = React.useRef<WorkerCollectionsRef>(createEmptyWorkerCollectionsRef());
  const workerNeedsFullSyncRef = React.useRef(true);

  const clearRequestTimeout = React.useCallback(() => {
    if (requestTimeoutRef.current !== null) {
      window.clearTimeout(requestTimeoutRef.current);
      requestTimeoutRef.current = null;
    }
  }, []);

  const cancelOutstandingWorkerRequest = React.useCallback(() => {
    const cancelView = cancelSignalViewRef.current;
    if (!cancelView || typeof Atomics === 'undefined') return;
    Atomics.add(cancelView, 0, 1);
  }, []);

  const terminateWorker = React.useCallback(() => {
    cancelOutstandingWorkerRequest();
    clearRequestTimeout();
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    cancelSignalRef.current = null;
    cancelSignalViewRef.current = null;
    inFlightRequestIdRef.current = null;
    workerCollectionsRef.current = createEmptyWorkerCollectionsRef();
    workerNeedsFullSyncRef.current = true;
  }, [cancelOutstandingWorkerRequest, clearRequestTimeout]);

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

    if (workerCapabilities.sharedMemoryWorkersEnabled) {
      const cancelSignal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      cancelSignalRef.current = cancelSignal;
      cancelSignalViewRef.current = new Int32Array(cancelSignal);
      Atomics.store(cancelSignalViewRef.current, 0, 0);
    } else {
      cancelSignalRef.current = null;
      cancelSignalViewRef.current = null;
    }

    worker.onmessage = (event: MessageEvent<SupportRenderLookupWorkerResponseMessage>) => {
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
  }, [clearRequestTimeout, terminateWorker, workerCapabilities]);

  const postLatestRequest = React.useCallback(() => {
    if (isSupportEditInteractionActive()) {
      hasQueuedWorkRef.current = true;
      scheduleFlushAfterInteraction();
      return;
    }

    if (supportsWorkerSafeMode || !workerCapabilities.hasWorker || typeof Worker === 'undefined') {
      terminateWorker();
      setLookup(computeSupportRenderLookup(latestOptionsRef.current));
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
    const cancelSignalView = cancelSignalViewRef.current;
    const cancelEpoch = cancelSignalView && typeof Atomics !== 'undefined'
      ? (Atomics.add(cancelSignalView, 0, 1) + 1)
      : undefined;

    const delta = buildInputDelta(
      latestOptionsRef.current,
      workerCollectionsRef.current,
      workerNeedsFullSyncRef.current,
    );

    if (!delta) {
      return;
    }

    const request: SupportRenderLookupWorkerRequestMessage = {
      requestId,
      delta,
      cancelSignal: cancelSignalRef.current ?? undefined,
      cancelEpoch,
    };

    try {
      inFlightRequestIdRef.current = requestId;
      workerRef.current.postMessage(request);
      applyDeltaToWorkerCollectionsRef(workerCollectionsRef.current, delta);
      workerNeedsFullSyncRef.current = false;

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
  }, [clearRequestTimeout, createWorker, scheduleFlushAfterInteraction, supportsWorkerSafeMode, terminateWorker, workerCapabilities]);

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
    if (!supportsWorkerSafeMode) return;
    terminateWorker();
  }, [supportsWorkerSafeMode, terminateWorker]);

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
