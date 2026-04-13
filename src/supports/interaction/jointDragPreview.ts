import React from 'react';
import { flushSync } from 'react-dom';
import type { Branch, Knot, Roots, Trunk } from '../types';
import { computeJointDragPreviewKnots, type JointDragPreviewCandidateKnots, type JointDragPreviewContext, type JointDragPreviewKind, type JointDragPreviewPayload, type JointDragPreviewSnapshot } from './jointDragPreviewMath';
import type { PartDragPreviewPayload } from './partDragPreview';
import { subscribeSupportInteractionReset } from './supportInteractionReset';
import { getSupportWorkerRuntimeCapabilities } from './supportWorkerCapabilities';
import { isSupportWorkerSafetyModeEnabled } from './supportWorkerSafetyMode';
import { SupportComputeRuntime } from './supportComputeRuntime';
import type { Kickstand } from '../SupportTypes/Kickstand/types';
import type {
  JointDragPreviewInputDelta,
  JointDragPreviewWorkerCollectionsRef,
  JointDragPreviewWorkerRequestMessage,
  JointDragPreviewWorkerResponseMessage,
  RecordDelta,
} from './jointDragPreview.worker.shared';

const EVENT_NAME = 'dragonfruit-joint-drag-preview';
const PART_EVENT_NAME = 'dragonfruit-part-drag-update';
const EMPTY_PREVIEW_KNOTS: Record<string, Knot> = {};
const INLINE_PREVIEW_CANDIDATE_THRESHOLD = 512;
const NULL_PREVIEW_KEY = 'null';
const PREVIEW_KEY_PRECISION = 1e4;

interface UseJointDragPreviewOverridesOptions {
  roots: Record<string, Roots>;
  knots: Record<string, Knot>;
  kickstandKnots?: Record<string, Knot>;
  candidateKnots: JointDragPreviewCandidateKnots;
}

type MutableRecord<T> = Record<string, T>;

function createEmptyWorkerCollectionsRef(): JointDragPreviewWorkerCollectionsRef {
  return {
    roots: {},
    knots: {},
    kickstandKnots: {},
    candidateKnots: {},
  };
}

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

function buildCollectionsDelta(
  workerCollections: JointDragPreviewWorkerCollectionsRef,
  source: {
    roots: Record<string, Roots>;
    knots: Record<string, Knot>;
    kickstandKnots: Record<string, Knot>;
    candidateKnots: JointDragPreviewCandidateKnots;
  },
  forceFullSync: boolean,
): JointDragPreviewInputDelta | undefined {
  const roots = diffRecordByRef(workerCollections.roots, source.roots, forceFullSync);
  const knots = diffRecordByRef(workerCollections.knots, source.knots, forceFullSync);
  const kickstandKnots = diffRecordByRef(workerCollections.kickstandKnots, source.kickstandKnots, forceFullSync);
  const candidateKnots = diffRecordByRef(workerCollections.candidateKnots, source.candidateKnots, forceFullSync);

  if (!roots && !knots && !kickstandKnots && !candidateKnots) {
    return undefined;
  }

  return {
    roots,
    knots,
    kickstandKnots,
    candidateKnots,
  };
}

function applyCollectionsDelta(workerCollections: JointDragPreviewWorkerCollectionsRef, delta?: JointDragPreviewInputDelta) {
  if (!delta) return;

  applyRecordDeltaInPlace(workerCollections.roots, delta.roots);
  applyRecordDeltaInPlace(workerCollections.knots, delta.knots);
  applyRecordDeltaInPlace(workerCollections.kickstandKnots, delta.kickstandKnots);
  applyRecordDeltaInPlace(workerCollections.candidateKnots, delta.candidateKnots);
}

interface MainThreadPreviewComputePayload {
  preview: JointDragPreviewSnapshot;
  context: JointDragPreviewContext;
  candidateKnots: JointDragPreviewCandidateKnots;
}

function quantizePreviewValue(value: number | undefined | null) {
  if (value === undefined || value === null || !Number.isFinite(value)) return 'n';
  return Math.round(value * PREVIEW_KEY_PRECISION);
}

function appendPreviewPos(parts: string[], pos: { x: number; y: number; z: number } | undefined | null) {
  if (!pos) {
    parts.push('p:n');
    return;
  }

  parts.push(
    `p:${quantizePreviewValue(pos.x)},${quantizePreviewValue(pos.y)},${quantizePreviewValue(pos.z)}`,
  );
}

function buildPreviewSnapshotKey(preview: JointDragPreviewSnapshot | null) {
  if (!preview?.support) return NULL_PREVIEW_KEY;

  const support = preview.support;
  const parts: string[] = [preview.kind, preview.supportId, String(support.segments.length)];

  for (const segment of support.segments) {
    parts.push(
      's',
      segment.id,
      segment.type ?? 'straight',
      String(quantizePreviewValue(segment.diameter)),
      segment.topJoint?.id ?? 'tj:n',
      segment.bottomJoint?.id ?? 'bj:n',
    );

    appendPreviewPos(parts, segment.topJoint?.pos);
    appendPreviewPos(parts, segment.bottomJoint?.pos);
    appendPreviewPos(parts, segment.type === 'bezier' ? segment.controlPoint1 : undefined);
    appendPreviewPos(parts, segment.type === 'bezier' ? segment.controlPoint2 : undefined);
  }

  return parts.join('|');
}

function countCandidateKnots(candidateKnots: JointDragPreviewCandidateKnots) {
  let count = 0;
  for (const _knotId in candidateKnots) {
    count += 1;
  }
  return count;
}

export type { JointDragPreviewKind, JointDragPreviewPayload, JointDragPreviewSnapshot } from './jointDragPreviewMath';

export function emitJointDragPreview<TSupport>(payload: JointDragPreviewPayload<TSupport>) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<JointDragPreviewPayload<TSupport>>(EVENT_NAME, { detail: payload }));
}

export function clearJointDragPreview(kind: JointDragPreviewKind, supportId: string) {
  emitJointDragPreview({ kind, supportId, support: null });
}

export function useJointDragPreview<TSupport>(kind: JointDragPreviewKind, supportId: string) {
  const [previewSupport, setPreviewSupport] = React.useState<TSupport | null>(null);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const handlePreview = (event: Event) => {
      const detail = (event as CustomEvent<JointDragPreviewPayload<TSupport>>).detail;
      if (!detail) return;
      if (detail.kind !== kind || detail.supportId !== supportId) return;
      setPreviewSupport(detail.support ?? null);
    };

    window.addEventListener(EVENT_NAME, handlePreview as EventListener);
    return () => window.removeEventListener(EVENT_NAME, handlePreview as EventListener);
  }, [kind, supportId]);

  React.useEffect(() => {
    return subscribeSupportInteractionReset(() => {
      setPreviewSupport(null);
    });
  }, []);

  return previewSupport;
}

export function useActiveJointDragPreview() {
  const [preview, setPreview] = React.useState<JointDragPreviewSnapshot | null>(null);
  const pendingPreviewRef = React.useRef<JointDragPreviewSnapshot | null>(null);
  const pendingPreviewKeyRef = React.useRef<string>(NULL_PREVIEW_KEY);
  const committedPreviewKeyRef = React.useRef<string>(NULL_PREVIEW_KEY);
  const frameRef = React.useRef<number | null>(null);

  const schedulePreview = React.useCallback((nextPreview: JointDragPreviewSnapshot | null) => {
    const nextPreviewKey = buildPreviewSnapshotKey(nextPreview);
    if (nextPreviewKey === committedPreviewKeyRef.current) return;

    pendingPreviewRef.current = nextPreview;
    pendingPreviewKeyRef.current = nextPreviewKey;
    committedPreviewKeyRef.current = nextPreviewKey;

    // flushSync forces a synchronous React commit so InstancedContactConeGroup's
    // useLayoutEffect runs and updates instance matrices before R3F renders the
    // next frame. Without this, React 18 auto-batches the update and flushes it
    // asynchronously, letting R3F render the gizmo ball (imperative) at the new
    // position while the cone (React props) is still one frame behind.
    flushSync(() => setPreview(nextPreview));
  }, []);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const isJointPreviewKind = (kind: string): kind is JointDragPreviewKind => {
      return kind === 'trunk' || kind === 'branch' || kind === 'kickstand';
    };

    const handlePreview = (event: Event) => {
      const detail = (event as CustomEvent<JointDragPreviewPayload<unknown>>).detail;
      if (!detail) return;

      schedulePreview(detail.support ? (detail as JointDragPreviewSnapshot) : null);
    };

    const handlePartPreview = (event: Event) => {
      const detail = (event as CustomEvent<PartDragPreviewPayload<unknown>>).detail;
      if (!detail) return;
      if (!isJointPreviewKind(detail.kind)) return;

      const nextPreview: JointDragPreviewSnapshot | null = detail.support
        ? {
          kind: detail.kind,
          supportId: detail.supportId,
          support: detail.support as JointDragPreviewSnapshot['support'],
        }
        : null;

      schedulePreview(nextPreview);
    };

    window.addEventListener(EVENT_NAME, handlePreview as EventListener);
    window.addEventListener(PART_EVENT_NAME, handlePartPreview as EventListener);
    const unsubscribeReset = subscribeSupportInteractionReset(() => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      pendingPreviewRef.current = null;
      pendingPreviewKeyRef.current = NULL_PREVIEW_KEY;
      committedPreviewKeyRef.current = NULL_PREVIEW_KEY;
      setPreview(null);
    });

    return () => {
      unsubscribeReset();
      window.removeEventListener(EVENT_NAME, handlePreview as EventListener);
      window.removeEventListener(PART_EVENT_NAME, handlePartPreview as EventListener);
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      pendingPreviewRef.current = null;
      pendingPreviewKeyRef.current = NULL_PREVIEW_KEY;
      committedPreviewKeyRef.current = NULL_PREVIEW_KEY;
    };
  }, [schedulePreview]);

  return preview;
}

export function useJointDragPreviewOverrides({ roots, knots, kickstandKnots, candidateKnots }: UseJointDragPreviewOverridesOptions) {
  const workerCapabilities = React.useMemo(() => getSupportWorkerRuntimeCapabilities(), []);
  const supportsWorkerSafeMode = React.useMemo(() => isSupportWorkerSafetyModeEnabled(), []);
  const preview = useActiveJointDragPreview();
  const [previewKnots, setPreviewKnots] = React.useState<Record<string, Knot>>(EMPTY_PREVIEW_KNOTS);
  const workerRef = React.useRef<Worker | null>(null);
  const workerFailedRef = React.useRef(false);
  const canAcceptWorkerResultsRef = React.useRef(false);
  const cancelSignalRef = React.useRef<SharedArrayBuffer | null>(null);
  const cancelSignalViewRef = React.useRef<Int32Array | null>(null);
  const nextRequestIdRef = React.useRef(1);
  const latestRequestedRequestIdRef = React.useRef(0);
  const workerCollectionsRef = React.useRef<JointDragPreviewWorkerCollectionsRef>(createEmptyWorkerCollectionsRef());
  const workerNeedsFullSyncRef = React.useRef(true);
  const latestMainThreadComputeGenerationRef = React.useRef(0);
  const previewRuntimeRef = React.useRef<SupportComputeRuntime | null>(null);

  if (!previewRuntimeRef.current) {
    previewRuntimeRef.current = new SupportComputeRuntime({
      runners: {
        'joint-drag-preview': (payload) => {
          const p = payload as {
            preview: JointDragPreviewSnapshot;
            context: JointDragPreviewContext;
            candidateKnots: JointDragPreviewCandidateKnots;
          };
          return computeJointDragPreviewKnots(p.preview, p.context, p.candidateKnots);
        },
      },
      onError: (_kind, error) => {
        console.error('[JointDragPreview] Runtime compute failed:', error);
      },
    });
  }

  const cancelOutstandingWorkerRequest = React.useCallback(() => {
    const cancelView = cancelSignalViewRef.current;
    if (!cancelView || typeof Atomics === 'undefined') return;
    Atomics.add(cancelView, 0, 1);
  }, []);

  const resolvePreviewContext = React.useCallback((activePreview: JointDragPreviewSnapshot): JointDragPreviewContext => {
    const support = activePreview.support;
    if (!support) return {};

    if (activePreview.kind === 'trunk') {
      const trunkSupport = support as Trunk;
      return { root: roots[trunkSupport.rootId] ?? null };
    }

    if (activePreview.kind === 'kickstand') {
      const kickstandSupport = support as Kickstand;
      return {
        root: roots[kickstandSupport.rootId] ?? null,
        hostKnot: kickstandKnots?.[kickstandSupport.hostKnotId] ?? knots[kickstandSupport.hostKnotId] ?? null,
      };
    }

    const branchSupport = support as Branch;
    return { parentKnot: knots[branchSupport.parentKnotId] ?? null };
  }, [roots, kickstandKnots, knots]);

  const computeSync = React.useCallback((activePreview: JointDragPreviewSnapshot) => {
    return computeJointDragPreviewKnots(activePreview, resolvePreviewContext(activePreview), candidateKnots);
  }, [resolvePreviewContext, candidateKnots]);

  const scheduleMainThreadPreviewCompute = React.useCallback((activePreview: JointDragPreviewSnapshot) => {
    const runtime = previewRuntimeRef.current;
    if (!runtime) {
      setPreviewKnots(computeSync(activePreview));
      return;
    }

    const context = resolvePreviewContext(activePreview);
    const generation = latestMainThreadComputeGenerationRef.current + 1;
    latestMainThreadComputeGenerationRef.current = generation;

    runtime.cancelGeneration(generation - 1);

    const payload: MainThreadPreviewComputePayload = {
      preview: activePreview,
      context,
      candidateKnots,
    };

    void runtime
      .enqueue<MainThreadPreviewComputePayload, Record<string, Knot>>(
        'joint-drag-preview',
        payload,
        {
          priority: 'high',
          generation,
          dedupeKey: 'joint-drag-preview:main-thread',
        },
      )
      .then((result) => {
        if (generation !== latestMainThreadComputeGenerationRef.current) return;
        setPreviewKnots(result ?? EMPTY_PREVIEW_KNOTS);
      })
      .catch(() => {
        if (generation !== latestMainThreadComputeGenerationRef.current) return;
        setPreviewKnots(EMPTY_PREVIEW_KNOTS);
      });
  }, [candidateKnots, computeSync, resolvePreviewContext]);

  const candidateKnotCount = React.useMemo(() => countCandidateKnots(candidateKnots), [candidateKnots]);
  const useInlinePreviewCompute = preview?.kind === 'trunk' || candidateKnotCount <= INLINE_PREVIEW_CANDIDATE_THRESHOLD;
  const inlinePreviewKnots = React.useMemo(() => {
    if (!preview || !useInlinePreviewCompute) return EMPTY_PREVIEW_KNOTS;
    return computeSync(preview);
  }, [preview, useInlinePreviewCompute, computeSync]);

  React.useEffect(() => {
    if (!preview) {
      cancelOutstandingWorkerRequest();
      canAcceptWorkerResultsRef.current = false;
      latestMainThreadComputeGenerationRef.current += 1;
      setPreviewKnots(EMPTY_PREVIEW_KNOTS);
      latestRequestedRequestIdRef.current = 0;
      return;
    }

    if (useInlinePreviewCompute) {
      cancelOutstandingWorkerRequest();
      canAcceptWorkerResultsRef.current = false;
      latestMainThreadComputeGenerationRef.current += 1;
      // Avoid worker roundtrip latency for small/typical preview sets.
      return;
    }

    if (supportsWorkerSafeMode || !workerCapabilities.hasWorker || typeof window === 'undefined' || typeof Worker === 'undefined' || workerFailedRef.current) {
      canAcceptWorkerResultsRef.current = false;
      cancelOutstandingWorkerRequest();
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
      cancelSignalRef.current = null;
      cancelSignalViewRef.current = null;
      workerCollectionsRef.current = createEmptyWorkerCollectionsRef();
      workerNeedsFullSyncRef.current = true;
      scheduleMainThreadPreviewCompute(preview);
      return;
    }

    if (!workerRef.current) {
      try {
        const worker = new Worker(new URL('./jointDragPreview.worker.ts', import.meta.url), { type: 'module' });
        if (workerCapabilities.sharedMemoryWorkersEnabled) {
          const cancelSignal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
          cancelSignalRef.current = cancelSignal;
          cancelSignalViewRef.current = new Int32Array(cancelSignal);
          Atomics.store(cancelSignalViewRef.current, 0, 0);
        } else {
          cancelSignalRef.current = null;
          cancelSignalViewRef.current = null;
        }

        worker.onmessage = (event: MessageEvent<JointDragPreviewWorkerResponseMessage>) => {
          const data = event.data;
          if (!data || typeof data.requestId !== 'number') return;
          if (!canAcceptWorkerResultsRef.current) return;
          if (data.requestId < latestRequestedRequestIdRef.current) return;
          setPreviewKnots(data.previewKnots ?? EMPTY_PREVIEW_KNOTS);
        };
        worker.onerror = (error) => {
          console.error('[JointDragPreview] Worker failed; falling back to main-thread compute:', error);
          workerFailedRef.current = true;
          worker.terminate();
          workerRef.current = null;
          cancelSignalRef.current = null;
          cancelSignalViewRef.current = null;
          workerCollectionsRef.current = createEmptyWorkerCollectionsRef();
          workerNeedsFullSyncRef.current = true;
          if (preview) {
            scheduleMainThreadPreviewCompute(preview);
          }
        };
        workerRef.current = worker;
      } catch (error) {
        console.error('[JointDragPreview] Failed to create worker; using main-thread compute:', error);
        workerFailedRef.current = true;
        cancelSignalRef.current = null;
        cancelSignalViewRef.current = null;
        workerCollectionsRef.current = createEmptyWorkerCollectionsRef();
        workerNeedsFullSyncRef.current = true;
        scheduleMainThreadPreviewCompute(preview);
        return;
      }
    }

    const requestId = nextRequestIdRef.current++;
    latestRequestedRequestIdRef.current = requestId;
    canAcceptWorkerResultsRef.current = true;

    const cancelSignalView = cancelSignalViewRef.current;
    const cancelEpoch = cancelSignalView && typeof Atomics !== 'undefined'
      ? (Atomics.add(cancelSignalView, 0, 1) + 1)
      : undefined;

    const context = resolvePreviewContext(preview);
    const collectionsDelta = buildCollectionsDelta(
      workerCollectionsRef.current,
      {
        roots,
        knots,
        kickstandKnots: kickstandKnots ?? knots,
        candidateKnots,
      },
      workerNeedsFullSyncRef.current,
    );

    const request: JointDragPreviewWorkerRequestMessage = {
      requestId,
      preview,
      delta: collectionsDelta,
      rootId: context.root?.id ?? null,
      parentKnotId: context.parentKnot?.id ?? null,
      hostKnotId: context.hostKnot?.id ?? null,
      cancelSignal: cancelSignalRef.current ?? undefined,
      cancelEpoch,
    };

    try {
      workerRef.current.postMessage(request);
      applyCollectionsDelta(workerCollectionsRef.current, collectionsDelta);
      workerNeedsFullSyncRef.current = false;
    } catch (error) {
      console.error('[JointDragPreview] Worker postMessage failed; using main-thread compute:', error);
      workerFailedRef.current = true;
      workerRef.current?.terminate();
      workerRef.current = null;
      cancelSignalRef.current = null;
      cancelSignalViewRef.current = null;
      workerCollectionsRef.current = createEmptyWorkerCollectionsRef();
      workerNeedsFullSyncRef.current = true;
      scheduleMainThreadPreviewCompute(preview);
    }
  }, [preview, roots, knots, kickstandKnots, candidateKnots, resolvePreviewContext, scheduleMainThreadPreviewCompute, useInlinePreviewCompute, cancelOutstandingWorkerRequest, supportsWorkerSafeMode, workerCapabilities]);

  React.useEffect(() => {
    return () => {
      canAcceptWorkerResultsRef.current = false;
      latestMainThreadComputeGenerationRef.current += 1;
      previewRuntimeRef.current?.dispose();
      previewRuntimeRef.current = null;
      cancelOutstandingWorkerRequest();
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
      cancelSignalRef.current = null;
      cancelSignalViewRef.current = null;
      workerCollectionsRef.current = createEmptyWorkerCollectionsRef();
      workerNeedsFullSyncRef.current = true;
    };
  }, [cancelOutstandingWorkerRequest]);

  if (!preview) return EMPTY_PREVIEW_KNOTS;
  if (useInlinePreviewCompute) return inlinePreviewKnots;
  return previewKnots;
}