import { useState, useEffect, useMemo, useCallback, useRef, type SetStateAction } from 'react';
import { setSceneClip } from './sceneClipStore';

interface SlicingStateProps {
  hasGeometry: boolean;
  zRange: { min: number; max: number };
  layerHeightMm?: number | null;
}

function resolveLayerHeightMicron(layerHeightMm: number | null | undefined): number | null {
  const parsed = Number(layerHeightMm);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(1, Math.round(parsed * 1000));
}

export function useSlicingManager({ hasGeometry, zRange, layerHeightMm: controlledLayerHeightMm }: SlicingStateProps) {
  const controlledLayerHeightMicron = useMemo(
    () => resolveLayerHeightMicron(controlledLayerHeightMm),
    [controlledLayerHeightMm],
  );
  const [uncontrolledLayerHeightMicron, setLayerHeightMicron] = useState<number>(() => controlledLayerHeightMicron ?? 50);
  const [layerIndex, setLayerIndexState] = useState<number>(0);
  const [lowerLayerIndex, setLowerLayerIndexState] = useState<number>(0);
  const topSliderInitializedRef = useRef(false);
  const prevNumLayersRef = useRef<number>(0);

  const layerHeightMicron = controlledLayerHeightMicron ?? uncontrolledLayerHeightMicron;
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

  // The clip is published straight to the scene store, so a drag does not need
  // a React render to move the cross-section. While the thumb is held the
  // committed index is deferred to the release; the slider draws its own value.
  const scrubRef = useRef(false);
  const pendingLayerIndexRef = useRef<number | null>(null);
  const pendingLowerLayerIndexRef = useRef<number | null>(null);
  const layerIndexRef = useRef(layerIndex);
  const lowerLayerIndexRef = useRef(lowerLayerIndex);
  const clipParamsRef = useRef({ hasGeometry, zRange, layerHeightMm, numLayers });

  const publishClip = useCallback((upperIndex: number, lowerIndexValue: number) => {
    const params = clipParamsRef.current;
    if (!params.hasGeometry) {
      setSceneClip(null, null);
      return;
    }
    const EPS = 1e-6;
    const upper = Math.max(upperIndex, lowerIndexValue);
    const lower = Math.min(upperIndex, lowerIndexValue);
    const maxLayer = Math.max(0, params.numLayers);
    const lowerMm = lower === 0
      ? null
      : Math.min(
        Math.max(params.zRange.min + (lower * params.layerHeightMm) - EPS, params.zRange.min - EPS),
        params.zRange.max,
      );
    const upperMm = upper === 0 || upper >= maxLayer
      ? null
      : Math.min(
        Math.max(params.zRange.min + (upper * params.layerHeightMm) + EPS, params.zRange.min),
        params.zRange.max + EPS,
      );
    setSceneClip(lowerMm, upperMm);
  }, []);

  const beginScrub = useCallback(() => {
    scrubRef.current = true;
  }, []);

  const endScrub = useCallback(() => {
    scrubRef.current = false;
    const pendingUpper = pendingLayerIndexRef.current;
    const pendingLower = pendingLowerLayerIndexRef.current;
    pendingLayerIndexRef.current = null;
    pendingLowerLayerIndexRef.current = null;
    if (pendingUpper != null) setLayerIndexState(pendingUpper);
    if (pendingLower != null) setLowerLayerIndexState(pendingLower);
  }, []);

  const setLayerIndex = useCallback((next: SetStateAction<number>) => {
    const previous = layerIndexRef.current;
    const resolved = typeof next === 'function'
      ? (next as (prevState: number) => number)(previous)
      : next;
    const clamped = clampLayerIndex(resolved);
    if (clamped === previous) return;
    layerIndexRef.current = clamped;
    publishClip(clamped, lowerLayerIndexRef.current);
    if (scrubRef.current) {
      pendingLayerIndexRef.current = clamped;
      return;
    }
    setLayerIndexState(clamped);
  }, [clampLayerIndex, publishClip]);

  const setLowerLayerIndex = useCallback((next: SetStateAction<number>) => {
    const previous = lowerLayerIndexRef.current;
    const resolved = typeof next === 'function'
      ? (next as (prevState: number) => number)(previous)
      : next;
    const clamped = clampLayerIndex(resolved);
    if (clamped === previous) return;
    lowerLayerIndexRef.current = clamped;
    publishClip(layerIndexRef.current, clamped);
    if (scrubRef.current) {
      pendingLowerLayerIndexRef.current = clamped;
      return;
    }
    setLowerLayerIndexState(clamped);
  }, [clampLayerIndex, publishClip]);

  // Keep the published clip in step with the committed state and with a new
  // model's height or layer height. The refs the setters read are synced here
  // too, so a scrub started between renders still sees the current values.
  useEffect(() => {
    layerIndexRef.current = layerIndex;
    lowerLayerIndexRef.current = lowerLayerIndex;
    clipParamsRef.current = { hasGeometry, zRange, layerHeightMm, numLayers };
    publishClip(layerIndex, lowerLayerIndex);
  }, [publishClip, layerIndex, lowerLayerIndex, hasGeometry, zRange, layerHeightMm, numLayers]);

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

  return {
    layerHeightMicron,
    setLayerHeightMicron,
    layerIndex,
    setLayerIndex,
    lowerLayerIndex,
    setLowerLayerIndex,
    beginScrub,
    endScrub,
    layerHeightMm,
    heightMm,
    currentHeightMm,
    lowerCurrentHeightMm,
    numLayers,
  };
}
