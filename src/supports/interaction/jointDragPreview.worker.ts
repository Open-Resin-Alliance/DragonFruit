import type { Knot, Roots } from '../types';
import { computeJointDragPreviewKnots, type JointDragPreviewSnapshot } from './jointDragPreviewMath';

interface JointDragPreviewWorkerRequest {
  requestId: number;
  preview: JointDragPreviewSnapshot | null;
  root?: Roots | null;
  parentKnot?: Knot | null;
  candidateKnots: Record<string, Knot>;
}

interface JointDragPreviewWorkerResponse {
  requestId: number;
  previewKnots: Record<string, Knot>;
}

self.onmessage = (event: MessageEvent<JointDragPreviewWorkerRequest>) => {
  const msg = event.data;
  if (!msg || !msg.requestId) return;

  try {
    const previewKnots = computeJointDragPreviewKnots(
      msg.preview,
      { root: msg.root ?? null, parentKnot: msg.parentKnot ?? null },
      msg.candidateKnots,
    );

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