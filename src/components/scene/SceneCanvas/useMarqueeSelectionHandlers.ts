import React from 'react';
import { selectAllSupports } from '@/supports/interaction/SupportSelection';

type MarqueeSelection = {
  start: { x: number; y: number };
  current: { x: number; y: number };
};

type UseMarqueeSelectionHandlersParams = {
  containerRef: React.RefObject<HTMLDivElement | null>;
  mode?: string;
  isGizmoDragging: boolean;
  isPostGizmoInteractionGuardActive: boolean;
  hoveredModelId: string | null;
  supportHoveredCategory: string | null | undefined;
  onActiveModelChange?: (id: string | null, options?: { selectionMode?: 'single' | 'toggle' | 'add' }) => void;
  activeModelId: string | null;
  selectedModelIds?: string[];
  isOrbitInteracting: boolean;
  spaceMouseNavigationActive: boolean;
  onMarqueeSelectionChange?: (ids: string[]) => void;
  resolveMarqueeSelectedIds: (selection: MarqueeSelection) => string[];
  resolveMarqueeSelectedSupportIds: (selection: MarqueeSelection) => string[];
  suppressNextCanvasClickRef: React.MutableRefObject<boolean>;
};

export function useMarqueeSelectionHandlers({
  containerRef,
  mode,
  isGizmoDragging,
  isPostGizmoInteractionGuardActive,
  hoveredModelId,
  supportHoveredCategory,
  onActiveModelChange,
  activeModelId,
  selectedModelIds,
  isOrbitInteracting,
  spaceMouseNavigationActive,
  onMarqueeSelectionChange,
  resolveMarqueeSelectedIds,
  resolveMarqueeSelectedSupportIds,
  suppressNextCanvasClickRef,
}: UseMarqueeSelectionHandlersParams) {
  const marqueePointerIdRef = React.useRef<number | null>(null);
  const marqueePointerStartRef = React.useRef<{ x: number; y: number } | null>(null);
  const [marqueeSelection, setMarqueeSelection] = React.useState<MarqueeSelection | null>(null);
  const isMarqueeSelecting = marqueeSelection !== null;

  const clampPointToContainer = React.useCallback((clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return null;

    const x = Math.min(rect.width, Math.max(0, clientX - rect.left));
    const y = Math.min(rect.height, Math.max(0, clientY - rect.top));
    return { x, y, rect };
  }, [containerRef]);

  const handleMarqueePointerDownCapture = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (mode !== 'prepare' && mode !== 'support') return;
    if (e.button !== 0) return;
    if (!e.shiftKey) return;
    if (isGizmoDragging || isPostGizmoInteractionGuardActive) return;
    if (mode === 'prepare' && (hoveredModelId || supportHoveredCategory !== 'none')) return;

    if (mode === 'prepare' && onActiveModelChange) {
      const hasSelection = !!activeModelId || !!selectedModelIds?.length;
      if (hasSelection && !window.__modelClickedThisFrame && !isOrbitInteracting && !spaceMouseNavigationActive) {
        onActiveModelChange(null);
        window.dispatchEvent(new CustomEvent('model-deselected'));
      }
    }

    const clamped = clampPointToContainer(e.clientX, e.clientY);
    if (!clamped) return;

    marqueePointerIdRef.current = e.pointerId;
    marqueePointerStartRef.current = { x: clamped.x, y: clamped.y };
  }, [
    activeModelId,
    clampPointToContainer,
    hoveredModelId,
    isGizmoDragging,
    isOrbitInteracting,
    isPostGizmoInteractionGuardActive,
    mode,
    onActiveModelChange,
    selectedModelIds,
    spaceMouseNavigationActive,
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

    e.preventDefault();
    e.stopPropagation();
    if (e.nativeEvent?.stopImmediatePropagation) e.nativeEvent.stopImmediatePropagation();
  }, [clampPointToContainer, marqueeSelection, suppressNextCanvasClickRef]);

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
      return;
    }

    const dragDx = currentSelection.current.x - currentSelection.start.x;
    const dragDy = currentSelection.current.y - currentSelection.start.y;
    const dragDistanceSq = (dragDx * dragDx) + (dragDy * dragDy);

    if (dragDistanceSq < 64) {
      return;
    }

    suppressNextCanvasClickRef.current = true;

    if (mode === 'prepare') {
      if (!onMarqueeSelectionChange) return;

      const selectedIds = resolveMarqueeSelectedIds(currentSelection);
      onMarqueeSelectionChange(selectedIds);

      if (selectedIds.length > 0) {
        window.dispatchEvent(new CustomEvent('model-clicked', { detail: { modelId: selectedIds[0] } }));
      } else {
        window.dispatchEvent(new CustomEvent('model-deselected'));
      }

      window.__modelClickGuardUntil = performance.now() + 48;
      window.__modelClickedThisFrame = true;
      window.setTimeout(() => {
        window.__modelClickedThisFrame = false;
      }, 0);
    } else if (mode === 'support') {
      const selectedSupportIds = resolveMarqueeSelectedSupportIds(currentSelection);
      selectAllSupports(selectedSupportIds);
    }

    e.preventDefault();
    e.stopPropagation();
    if (e.nativeEvent?.stopImmediatePropagation) e.nativeEvent.stopImmediatePropagation();
  }, [
    marqueeSelection,
    mode,
    onMarqueeSelectionChange,
    resolveMarqueeSelectedIds,
    resolveMarqueeSelectedSupportIds,
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
