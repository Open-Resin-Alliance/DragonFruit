import { computeSupportRenderLookup, type SupportRenderLookupInput, type SupportRenderLookupSnapshot } from './supportRenderLookupMath';
import type { RecordDelta, SupportRenderLookupWorkerRequestMessage, SupportRenderLookupWorkerResponseMessage } from './supportRenderLookup.worker.shared';

type MutableRecord<T> = Record<string, T>;

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

const cachedInput: SupportRenderLookupInput = {
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

function applyRecordDelta<T>(target: MutableRecord<T>, delta?: RecordDelta<T>) {
  if (!delta) return;

  for (const deleteId of delta.deleteIds) {
    delete target[deleteId];
  }

  for (const [id, value] of Object.entries(delta.upserts)) {
    target[id] = value;
  }
}

function applyInputDelta(msg: SupportRenderLookupWorkerRequestMessage) {
  const delta = msg.delta;
  if (!delta) return;

  const stateDelta = delta.state;
  if (stateDelta) {
    applyRecordDelta(cachedInput.state.roots, stateDelta.roots);
    applyRecordDelta(cachedInput.state.trunks, stateDelta.trunks);
    applyRecordDelta(cachedInput.state.branches, stateDelta.branches);
    applyRecordDelta(cachedInput.state.leaves, stateDelta.leaves);
    applyRecordDelta(cachedInput.state.twigs, stateDelta.twigs);
    applyRecordDelta(cachedInput.state.sticks, stateDelta.sticks);
    applyRecordDelta(cachedInput.state.braces, stateDelta.braces);
    applyRecordDelta(cachedInput.state.knots, stateDelta.knots);
  }

  const kickstandDelta = delta.kickstandState;
  if (kickstandDelta) {
    applyRecordDelta(cachedInput.kickstandState.kickstands, kickstandDelta.kickstands);
    applyRecordDelta(cachedInput.kickstandState.knots, kickstandDelta.knots);
  }

  if (delta.activePreviewSupportChanged) {
    cachedInput.activePreviewSupport = delta.activePreviewSupport ?? null;
  }
}

// Track request start times for performance diagnostics
const requestStartTimes = new Map<number, number>();

self.onmessage = (event: MessageEvent<SupportRenderLookupWorkerRequestMessage>) => {
  const msg = event.data;
  if (!msg || !msg.requestId) return;

  const cancelView = msg.cancelSignal ? new Int32Array(msg.cancelSignal) : null;
  const expectedEpoch = msg.cancelEpoch ?? 0;
  const shouldAbort = cancelView && typeof Atomics !== 'undefined'
    ? () => Atomics.load(cancelView, 0) !== expectedEpoch
    : undefined;

  if (shouldAbort?.()) return;

  const startTime = performance.now();
  requestStartTimes.set(msg.requestId, startTime);

  try {
    applyInputDelta(msg);

    const snapshot = computeSupportRenderLookup(cachedInput, { shouldAbort });
    if (shouldAbort?.()) return;
    const out: SupportRenderLookupWorkerResponseMessage = { requestId: msg.requestId, snapshot };
    self.postMessage(out);

    const duration = performance.now() - startTime;
    if (duration > 1000) {
      console.warn('[SupportRenderLookupWorker] Slow computation:', duration.toFixed(2), 'ms for request', msg.requestId);
    }
  } catch (error) {
    console.error('[SupportRenderLookupWorker] Failed to compute lookup (request#' + msg.requestId + '):', error);
    
    const out: SupportRenderLookupWorkerResponseMessage = {
      requestId: msg.requestId,
      snapshot: EMPTY_LOOKUP,
    };
    self.postMessage(out);
  }

  // Clean up old request tracking
  if (requestStartTimes.size > 100) {
    const oldestId = Math.min(...requestStartTimes.keys());
    requestStartTimes.delete(oldestId);
  }
};

// Handle uncaught errors in the worker
self.onerror = () => {
  console.error('[SupportRenderLookupWorker] Uncaught error in worker thread');
};
