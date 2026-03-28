import { computeSupportRenderLookup, type SupportRenderLookupInput, type SupportRenderLookupSnapshot } from './supportRenderLookupMath';

type RequestMessage = {
  requestId: number;
  input: SupportRenderLookupInput;
};

type ResponseMessage = {
  requestId: number;
  snapshot: SupportRenderLookupSnapshot;
};

// Track request start times for performance diagnostics
const requestStartTimes = new Map<number, number>();

self.onmessage = (event: MessageEvent<RequestMessage>) => {
  const msg = event.data;
  if (!msg || !msg.requestId) return;

  const startTime = performance.now();
  requestStartTimes.set(msg.requestId, startTime);

  try {
    const snapshot = computeSupportRenderLookup(msg.input);
    const out: ResponseMessage = { requestId: msg.requestId, snapshot };
    self.postMessage(out);

    const duration = performance.now() - startTime;
    if (duration > 1000) {
      console.warn('[SupportRenderLookupWorker] Slow computation:', duration.toFixed(2), 'ms for request', msg.requestId);
    }
  } catch (error) {
    console.error('[SupportRenderLookupWorker] Failed to compute lookup (request#' + msg.requestId + '):', error);
    
    const out: ResponseMessage = {
      requestId: msg.requestId,
      snapshot: {
        supportIdBySegmentId: {},
        supportIdByJointId: {},
        supportIdByKnotId: {},
        supportIdByContactDiskId: {},
        entitySegmentModelIdById: {},
        entityModelIdByKnotId: {},
        knotIdsByParentShaftId: {},
        kickstandKnotIdsByParentShaftId: {},
        previewCandidateKnots: {},
      },
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
