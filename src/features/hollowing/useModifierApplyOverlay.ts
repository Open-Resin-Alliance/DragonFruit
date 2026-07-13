import * as React from 'react';

export interface ModifierApplyOverlayArgs {
  /** scene.hasPendingBackgroundGeometryWork — polled by the drain-watcher. */
  hasPendingBackgroundGeometryWork: () => boolean;
  /** Cross-domain apply flags, needed only to gate the two finalizing content
   *  branches so they yield to in-flight applies exactly as today. */
  isApplyingHollowing: boolean;
  isApplyingHolePunch: boolean;
  pendingHolePunchAutoApplyModelId: string | null;
}

export interface ModifierApplyOverlayContent {
  title: string;
  detailLines: string[];
}

export interface ModifierApplyOverlayApi {
  /** finalizingModifierApply !== null */
  isFinalizing: boolean;
  beginFinalizing: (kind: 'hollowing' | 'holePunch') => void;
  clearFinalizing: () => void;
  /** The "…complete — loading mesh…" content, or null when a plain apply
   *  message should win. Consumed by a 1-line guard in modifierApplyOverlayContent. */
  finalizingOverlayContent: ModifierApplyOverlayContent | null;
  /** Pure double-rAF; resolves after the next presented frame. */
  nextPaint: () => Promise<void>;
}

export function useModifierApplyOverlay(
  args: ModifierApplyOverlayArgs,
): ModifierApplyOverlayApi {
  const {
    hasPendingBackgroundGeometryWork,
    isApplyingHollowing,
    isApplyingHolePunch,
    pendingHolePunchAutoApplyModelId,
  } = args;

  // Set when a modifier apply's BACKEND work has finished but the UI-side
  // finalization (geometry build, React commit, GPU upload, deferred BVH /
  // flattening-plane work) is still in flight. Keeps the blocking overlay up
  // with a "loading mesh" message until the app is genuinely responsive —
  // previously the overlay vanished at the end of the async handler while
  // the main thread stayed frozen for seconds afterwards.
  const [finalizingModifierApply, setFinalizingModifierApply] =
    React.useState<null | 'hollowing' | 'holePunch'>(null);

  // Resolves after the NEXT presented frame: the first rAF fires after the
  // pending React commit but before paint, the second after that frame has
  // actually been shown. Used to let an overlay message paint before a heavy
  // synchronous main-thread block starts.
  const nextPaint = React.useCallback(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  }), []);

  const finalizingOverlayContent = React.useMemo<ModifierApplyOverlayContent | null>(() => {
    // Backend finished; the UI is loading the new mesh (geometry build, GPU
    // upload, pick-acceleration rebuild). Wins over the "Applying..." copy
    // for the same operation, but yields to a queued hole-punch auto-apply
    // chain, whose combined/punch messages stay accurate.
    if (
      finalizingModifierApply === 'hollowing'
      && !isApplyingHolePunch
      && pendingHolePunchAutoApplyModelId === null
    ) {
      return {
        title: 'Hollowing complete — loading mesh…',
        detailLines: [
          'Uploading the new geometry to the viewport and rebuilding pick acceleration.',
          'The app may pause briefly.',
        ],
      };
    }

    if (finalizingModifierApply === 'holePunch' && !isApplyingHollowing) {
      return {
        title: 'Hole punches complete — loading mesh…',
        detailLines: [
          'Uploading the new geometry to the viewport and rebuilding pick acceleration.',
          'The app may pause briefly.',
        ],
      };
    }

    return null;
  }, [finalizingModifierApply, isApplyingHollowing, isApplyingHolePunch, pendingHolePunchAutoApplyModelId]);

  // Clears the "finalizing" overlay state once the post-apply mesh swap has
  // genuinely settled: two consecutive presented frames with the deferred
  // geometry work (BVH builds, disposals, flattening planes) drained. rAF
  // only fires between presented frames, so this inherently waits out the
  // heavy commit + GPU-upload frame as well. A 20s cap prevents a wedged
  // queue from pinning the overlay forever.
  React.useEffect(() => {
    if (finalizingModifierApply === null) return;
    let cancelled = false;
    let rafId = 0;
    const startedAt = performance.now();
    let idleFrames = 0;
    const tick = () => {
      if (cancelled) return;
      const busy = hasPendingBackgroundGeometryWork();
      idleFrames = busy ? 0 : idleFrames + 1;
      if (idleFrames >= 2 || performance.now() - startedAt > 20_000) {
        setFinalizingModifierApply(null);
        return;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    };
  }, [finalizingModifierApply, hasPendingBackgroundGeometryWork]);

  const beginFinalizing = React.useCallback((kind: 'hollowing' | 'holePunch') => {
    setFinalizingModifierApply(kind);
  }, []);
  const clearFinalizing = React.useCallback(() => {
    setFinalizingModifierApply(null);
  }, []);

  return {
    isFinalizing: finalizingModifierApply !== null,
    beginFinalizing,
    clearFinalizing,
    finalizingOverlayContent,
    nextPaint,
  };
}
