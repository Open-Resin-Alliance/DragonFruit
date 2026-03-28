import type { Knot, Roots } from '../types';
import { computeJointDragPreviewKnots, type JointDragPreviewSnapshot } from './jointDragPreviewMath';

interface JointDragPreviewWorkerRequest {
  requestId: number;
  preview: JointDragPreviewSnapshot | null;
  root?: Roots | null;
  parentKnot?: Knot | null;
  hostKnot?: Knot | null;
  candidateKnots: Record<string, Knot>;
  cancelSignal?: SharedArrayBuffer;
  cancelEpoch?: number;
}

interface JointDragPreviewWorkerResponse {
  requestId: number;
  previewKnots: Record<string, Knot>;
}

self.onmessage = (event: MessageEvent<JointDragPreviewWorkerRequest>) => {
  const msg = event.data;
  if (!msg || !msg.requestId) return;

  const cancelView = msg.cancelSignal ? new Int32Array(msg.cancelSignal) : null;
  const expectedEpoch = msg.cancelEpoch ?? 0;
  const shouldAbort = cancelView && typeof Atomics !== 'undefined'
    ? () => Atomics.load(cancelView, 0) !== expectedEpoch
    : undefined;

  if (shouldAbort?.()) return;

  try {
    const previewKnots = computeJointDragPreviewKnots(
      msg.preview,
      { root: msg.root ?? null, parentKnot: msg.parentKnot ?? null, hostKnot: msg.hostKnot ?? null },
      msg.candidateKnots,
      { shouldAbort },
    );

    if (shouldAbort?.()) return;

    const out: JointDragPreviewWorkerResponse = {
      requestId: msg.requestId,
      previewKnots,
    };

    self.postMessage(out);
  } catch (error) {
    console.error('[JointDragPreviewWorker] Failed to compute preview knots', error);
    const out: JointDragPreviewWorkerResponse = {
      requestId: msg.requestId,
      previewKnots: {},
    };
    self.postMessage(out);
  }
};