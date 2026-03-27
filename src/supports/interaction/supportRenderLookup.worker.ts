import { computeSupportRenderLookup, type SupportRenderLookupInput, type SupportRenderLookupSnapshot } from './supportRenderLookupMath';

type RequestMessage = {
  requestId: number;
  input: SupportRenderLookupInput;
};

type ResponseMessage = {
  requestId: number;
  snapshot: SupportRenderLookupSnapshot;
};

self.onmessage = (event: MessageEvent<RequestMessage>) => {
  const msg = event.data;
  if (!msg || !msg.requestId) return;

  try {
    const snapshot = computeSupportRenderLookup(msg.input);
    const out: ResponseMessage = { requestId: msg.requestId, snapshot };
    self.postMessage(out);
  } catch (error) {
    console.error('[SupportRenderLookupWorker] Failed', error);
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
};
