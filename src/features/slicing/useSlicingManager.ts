import { useState, useEffect, useMemo, useCallback, useRef, type SetStateAction } from 'react';

interface SlicingStateProps {
  hasGeometry: boolean;
  zRange: { min: number; max: number };
}

export function useSlicingManager({ hasGeometry, zRange }: SlicingStateProps) {
  const [layerHeightMicron, setLayerHeightMicron] = useState<number>(50);
  const [crossSectionMode, setCrossSectionMode] = useState<'smooth' | 'rasterized'>('smooth');
  const [layerIndex, setLayerIndexState] = useState<number>(0);
  const [lowerLayerIndex, setLowerLayerIndexState] = useState<number>(0);
  const topSliderInitializedRef = useRef(false);
  const prevNumLayersRef = useRef<number>(0);

  const layerHeightMm = useMemo(() => layerHeightMicron / 1000, [layerHeightMicron]);

  // Reset layer index only when switching from no-geom to has-geom (e.g. first load)
  // We don't want to reset if we just deselected/selected different models but scene persists
  useEffect(() => {
    if (hasGeometry) {
        // Only reset if we are out of bounds? Or let it clamp?
        // For now, let's disable auto-reset on selection change to persist slider state
        // setLayerIndex(0); 
    }
  }, [hasGeometry]);

  const heightMm = useMemo(() => (hasGeometry ? zRange.max - zRange.min : 0), [hasGeometry, zRange]);
  
  const numLayers = useMemo(() => (
    heightMm > 0 && layerHeightMm > 0 ? Math.ceil(heightMm / layerHeightMm) : 0
  ), [heightMm, layerHeightMm]);

  const clampLayerIndex = useCallback((value: number): number => {
    const safeValue = Number.isFinite(value) ? Math.round(value) : 0;
    const maxLayer = Math.max(0, numLayers);
    return Math.max(0, Math.min(maxLayer, safeValue));
  }, [numLayers]);

  const setLayerIndex = useCallback((next: SetStateAction<number>) => {
    setLayerIndexState((previous) => {
      const resolved = typeof next === 'function'
        ? (next as (prevState: number) => number)(previous)
        : next;
      const clamped = clampLayerIndex(resolved);
      return previous === clamped ? previous : clamped;
    });
  }, [clampLayerIndex]);

  const setLowerLayerIndex = useCallback((next: SetStateAction<number>) => {
    setLowerLayerIndexState((previous) => {
      const resolved = typeof next === 'function'
        ? (next as (prevState: number) => number)(previous)
        : next;
      const clamped = clampLayerIndex(resolved);
      return previous === clamped ? previous : clamped;
    });
  }, [clampLayerIndex]);

  useEffect(() => {
    setLayerIndexState((previous) => {
      const clamped = clampLayerIndex(previous);
      return previous === clamped ? previous : clamped;
    });
  }, [clampLayerIndex]);

  // If numLayers grows (e.g. model moved upward) and the top slider was pinned
  // at the old maximum, follow it to the new maximum so cross-section stays off.
  useEffect(() => {
    const prevMax = prevNumLayersRef.current;
    prevNumLayersRef.current = numLayers;
    if (numLayers > prevMax && prevMax > 0) {
      setLayerIndexState((previous) => (previous === prevMax ? numLayers : previous));
    }
  }, [numLayers]);

  useEffect(() => {
    setLowerLayerIndexState((previous) => {
      const clamped = clampLayerIndex(previous);
      return previous === clamped ? previous : clamped;
    });
  }, [clampLayerIndex]);

  // Default UX: on a fresh geometry session, keep bottom slider at 0 and
  // initialize the top slider to max so users start with full-height view.
  // Do this once per "no-geometry -> geometry" transition only.
  useEffect(() => {
    if (!hasGeometry) {
      topSliderInitializedRef.current = false;
      return;
    }

    if (numLayers <= 0) return;
    if (topSliderInitializedRef.current) return;

    // Respect pre-existing/restored layer state if it was already set.
    if (layerIndex !== 0 || lowerLayerIndex !== 0) {
      topSliderInitializedRef.current = true;
      return;
    }

    setLayerIndexState(numLayers);
    topSliderInitializedRef.current = true;
  }, [hasGeometry, layerIndex, lowerLayerIndex, numLayers]);

  // Derive an ordered layer pair for clipping so lower-slider drags cannot
  // accidentally invalidate clipping (e.g. transient lower > upper).
  const orderedLayerRange = useMemo(() => {
    const upper = Math.max(layerIndex, lowerLayerIndex);
    const lower = Math.min(layerIndex, lowerLayerIndex);
    return { lower, upper };
  }, [layerIndex, lowerLayerIndex]);

  const currentHeightMm = useMemo(() => {
    if (!hasGeometry) return 0;
    const height = orderedLayerRange.upper * layerHeightMm;
    return Math.min(Math.max(height, 0), Math.max(heightMm, 0));
  }, [hasGeometry, orderedLayerRange.upper, layerHeightMm, heightMm]);

  const lowerCurrentHeightMm = useMemo(() => {
    if (!hasGeometry) return 0;
    const height = orderedLayerRange.lower * layerHeightMm;
    return Math.min(Math.max(height, 0), Math.max(heightMm, 0));
  }, [hasGeometry, orderedLayerRange.lower, layerHeightMm, heightMm]);

  const clipLower = useMemo(() => {
    if (!hasGeometry || orderedLayerRange.lower === 0) return null;
    const EPS = 1e-6;
    const lower = zRange.min + (orderedLayerRange.lower * layerHeightMm) - EPS;
    return Math.min(Math.max(lower, zRange.min - EPS), zRange.max);
  }, [hasGeometry, orderedLayerRange.lower, zRange, layerHeightMm]);

  const clipUpper = useMemo(() => {
    if (!hasGeometry) return null;

    // Disable upper clipping at either edge of the slider range.
    // - upper=0: historical behavior
    // - upper=max: new default-rest behavior (top slider parked at max)
    const maxLayer = Math.max(0, numLayers);
    if (orderedLayerRange.upper === 0 || orderedLayerRange.upper >= maxLayer) return null;

    const EPS = 1e-6;
    const upper = zRange.min + (orderedLayerRange.upper * layerHeightMm) + EPS;
    return Math.min(Math.max(upper, zRange.min), zRange.max + EPS);
  }, [hasGeometry, numLayers, orderedLayerRange.upper, zRange, layerHeightMm]);

  return {
    layerHeightMicron,
    setLayerHeightMicron,
    crossSectionMode,
    setCrossSectionMode,
    layerIndex,
    setLayerIndex,
    lowerLayerIndex,
    setLowerLayerIndex,
    layerHeightMm,
    heightMm,
    currentHeightMm,
    lowerCurrentHeightMm,
    numLayers,
    clipLower,
    clipUpper
  };
}
