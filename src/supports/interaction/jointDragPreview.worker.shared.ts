import type { Knot, Roots } from '../types';
import type { JointDragPreviewCandidateKnots, JointDragPreviewSnapshot } from './jointDragPreviewMath';

export type RecordDelta<T> = {
  upserts: Record<string, T>;
  deleteIds: string[];
};

export type JointDragPreviewInputDelta = Partial<{
  roots: RecordDelta<Roots>;
  knots: RecordDelta<Knot>;
  kickstandKnots: RecordDelta<Knot>;
  candidateKnots: RecordDelta<Knot>;
}>;

export type JointDragPreviewWorkerRequestMessage = {
  requestId: number;
  delta?: JointDragPreviewInputDelta;
  preview: JointDragPreviewSnapshot | null;
  rootId?: string | null;
  parentKnotId?: string | null;
  hostKnotId?: string | null;
  cancelSignal?: SharedArrayBuffer;
  cancelEpoch?: number;
};

export type JointDragPreviewWorkerResponseMessage = {
  requestId: number;
  previewKnots: Record<string, Knot>;
};

export interface JointDragPreviewWorkerCollectionsRef {
  roots: Record<string, Roots>;
  knots: Record<string, Knot>;
  kickstandKnots: Record<string, Knot>;
  candidateKnots: JointDragPreviewCandidateKnots;
}
