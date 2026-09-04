import React from 'react';
import {
  beginSupportMarqueeSelection,
  clearSupportMarqueeSelection,
  commitSupportMarqueeSelection,
  updateSupportMarqueeCandidates,
} from '@/supports/interaction/shared/selection/marqueeSelectionController';

type MarqueeSelection = {
  start: { x: number; y: number };
  current: { x: number; y: number };
};

type UseMarqueeSelectionHandlersParams = {
  containerRef: React.RefObject<HTMLDivElement | null>;
  interactionResetToken?: number;
  mode?: string;
  prepareMarqueeEnabled?: boolean;
  allowPrepareMarqueeFromHover?: boolean;
  prepareMarqueePublishesModelSelectionEvents?: boolean;
  prepareMarqueeRequiresShift?: boolean;
  isGizmoDragging: boolean;
  isPostGizmoInteractionGuardActive: boolean;
  hoveredModelId: string | null;
  supportHoveredCategory: string | null | undefined;
  selectedModelIds?: string[];
  onMarqueeSelectionChange?: (ids: string[]) => void;
  resolveMarqueeSelectedIds: (selection: MarqueeSelection) => string[];
  resolveMarqueeSelectedSupportIds: (selection: MarqueeSelection) => string[];
  suppressNextCanvasClickRef: React.MutableRefObject<boolean>;
};

export function useMarqueeSelectionHandlers({
  containerRef,
  interactionResetToken,
  mode,
  prepareMarqueeEnabled = false,
  allowPrepareMarqueeFromHover = false,
  prepareMarqueePublishesModelSelectionEvents = true,
  prepareMarqueeRequiresShift = true,
  isGizmoDragging,
  isPostGizmoInteractionGuardActive,
  hoveredModelId,
  supportHoveredCategory,
  selectedModelIds,
  onMarqueeSelectionChange,
  resolveMarqueeSelectedIds,
  resolveMarqueeSelectedSupportIds,
  suppressNextCanvasClickRef,
}: UseMarqueeSelectionHandlersParams) {
  const marqueePointerIdRef = React.useRef<number | null>(null);
  const marqueePointerStartRef = React.useRef<{ x: number; y: number } | null>(null);
  const [marqueeSelection, setMarqueeSelection] = React.useState<MarqueeSelection | null>(null);
  const isMarqueeSelecting = marqueeSelection !== null;

  React.useEffect(() => {
    marqueePointerIdRef.current = null;
    marqueePointerStartRef.current = null;
    setMarqueeSelection(null);
    clearSupportMarqueeSelection();
  }, [interactionResetToken]);

  const clampPointToContainer = React.useCallback((clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return null;

    const x = Math.min(rect.width, Math.max(0, clientX - rect.left));
    const y = Math.min(rect.height, Math.max(0, clientY - rect.top));
    return { x, y, rect };
  }, [containerRef]);

  const handleMarqueePointerDownCapture = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const canUsePrepareMarquee = mode === 'prepare' && prepareMarqueeEnabled;
    if (!canUsePrepareMarquee && mode !== 'support') return;
    if (e.button !== 0) return;
    if (mode === 'support' || prepareMarqueeRequiresShift) {
      if (!e.shiftKey) return;
    }
    // Skip marquee when Cmd/Ctrl+Shift is held — that's rotation snap, not selection
    if (e.metaKey || e.ctrlKey) return;
    if (isGizmoDragging || isPostGizmoInteractionGuardActive) return;
    if (
      mode === 'prepare'
      && !allowPrepareMarqueeFromHover
      && (hoveredModelId || supportHoveredCategory !== 'none')
    ) return;

    const clamped = clampPointToContainer(e.clientX, e.clientY);
    if (!clamped) return;

    marqueePointerIdRef.current = e.pointerId;
    marqueePointerStartRef.current = { x: clamped.x, y: clamped.y };
  }, [
    clampPointToContainer,
    hoveredModelId,
    isGizmoDragging,
    isPostGizmoInteractionGuardActive,
    mode,
    allowPrepareMarqueeFromHover,
    prepareMarqueeRequiresShift,
    prepareMarqueeEnabled,
    supportHoveredCategory,
  ]);

  const handleMarqueePointerMoveCapture = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (marqueePointerIdRef.current == null) return;
    if (e.pointerId !== marqueePointerIdRef.current) return;
    const start = marqueePointerStartRef.current;
    if (!start) return;

    const clamped = clampPointToContainer(e.clientX, e.clientY);
    if (!clamped) return;

    if (!marqueeSelection) {
      const dx = clamped.x - start.x;
      const dy = clamped.y - start.y;
      const dragDistanceSq = (dx * dx) + (dy * dy);

      if (dragDistanceSq < 16) {
        return;
      }

      suppressNextCanvasClickRef.current = true;
      setMarqueeSelection({
        start: { x: start.x, y: start.y },
        current: { x: clamped.x, y: clamped.y },
      });

      if (mode === 'support') {
        beginSupportMarqueeSelection();
      }

      e.preventDefault();
      e.stopPropagation();
      if (e.nativeEvent?.stopImmediatePropagation) e.nativeEvent.stopImmediatePropagation();

      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // no-op: pointer capture can fail in edge cases; marquee still works without it
      }
      return;
    }

    setMarqueeSelection((prev) => (prev
      ? {
        ...prev,
        current: { x: clamped.x, y: clamped.y },
      }
      : prev));

    if (mode === 'support') {
      const previewSelection = {
        start,
        current: { x: clamped.x, y: clamped.y },
      };
      const candidateIds = resolveMarqueeSelectedSupportIds(previewSelection);
      updateSupportMarqueeCandidates(candidateIds);
    }

    e.preventDefault();
    e.stopPropagation();
    if (e.nativeEvent?.stopImmediatePropagation) e.nativeEvent.stopImmediatePropagation();
  }, [
    clampPointToContainer,
    marqueeSelection,
    mode,
    resolveMarqueeSelectedSupportIds,
    suppressNextCanvasClickRef,
  ]);

  const endMarqueeSelection = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (marqueePointerIdRef.current == null) return;
    if (e.pointerId !== marqueePointerIdRef.current) return;

    const currentSelection = marqueeSelection;
    marqueePointerIdRef.current = null;
    marqueePointerStartRef.current = null;
    setMarqueeSelection(null);

    if (currentSelection) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ignore release failures
      }
    }

    if (!currentSelection) {
      if (mode === 'support') {
        clearSupportMarqueeSelection();
      }
      return;
    }

    const dragDx = currentSelection.current.x - currentSelection.start.x;
    const dragDy = currentSelection.current.y - currentSelection.start.y;
    const dragDistanceSq = (dragDx * dragDx) + (dragDy * dragDy);

    if (dragDistanceSq < 64) {
      if (mode === 'support') {
        clearSupportMarqueeSelection();
      }
      return;
    }

    suppressNextCanvasClickRef.current = true;
    // The click that follows the drag is swallowed by whoever sees it first.
    // If none does — the pointer up was stopped short — nothing would ever
    // lower the flag, and it would eat the next honest click instead.
    window.requestAnimationFrame(() => {
      suppressNextCanvasClickRef.current = false;
    });

    if (mode === 'prepare') {
      if (!onMarqueeSelectionChange) return;

      const selectedIds = resolveMarqueeSelectedIds(currentSelection);
      // A marquee only ever adds, as CAD applications do: catching nothing
      // leaves the selection alone rather than clearing it.
      if (selectedIds.length === 0) return;

      onMarqueeSelectionChange(Array.from(new Set([...(selectedModelIds ?? []), ...selectedIds])));

      if (prepareMarqueePublishesModelSelectionEvents) {
        window.dispatchEvent(new CustomEvent('model-clicked', { detail: { modelId: selectedIds[0] } }));

        window.__modelClickGuardUntil = performance.now() + 48;
        window.__modelClickedThisFrame = true;
        window.setTimeout(() => {
          window.__modelClickedThisFrame = false;
        }, 0);
      }
    } else if (mode === 'support') {
      const selectedSupportIds = resolveMarqueeSelectedSupportIds(currentSelection);
      commitSupportMarqueeSelection(selectedSupportIds);
    }

    e.preventDefault();
    e.stopPropagation();
    if (e.nativeEvent?.stopImmediatePropagation) e.nativeEvent.stopImmediatePropagation();
  }, [
    marqueeSelection,
    mode,
    onMarqueeSelectionChange,
    prepareMarqueePublishesModelSelectionEvents,
    resolveMarqueeSelectedIds,
    resolveMarqueeSelectedSupportIds,
    selectedModelIds,
    suppressNextCanvasClickRef,
  ]);

  return {
    marqueeSelection,
    isMarqueeSelecting,
    handleMarqueePointerDownCapture,
    handleMarqueePointerMoveCapture,
    endMarqueeSelection,
  };
}
