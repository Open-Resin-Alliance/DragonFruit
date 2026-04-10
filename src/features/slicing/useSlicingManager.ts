import { useState, useEffect, useMemo, useCallback, type SetStateAction } from 'react';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';

interface SlicingStateProps {
  hasGeometry: boolean;
  zRange: { min: number; max: number };
}

export function useSlicingManager({ hasGeometry, zRange }: SlicingStateProps) {
  const [layerHeightMicron, setLayerHeightMicron] = useState<number>(50);
  const [crossSectionMode, setCrossSectionMode] = useState<'smooth' | 'rasterized'>('smooth');
  const [layerIndex, setLayerIndexState] = useState<number>(0);

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

  const clampLayerIndex = useCallback((value: number) => {
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

  useEffect(() => {
    setLayerIndexState((previous) => {
      const clamped = clampLayerIndex(previous);
      return previous === clamped ? previous : clamped;
    });
  }, [clampLayerIndex]);

  const currentHeightMm = useMemo(() => {
    if (!hasGeometry) return 0;
    const height = layerIndex * layerHeightMm;
    return Math.min(Math.max(height, 0), Math.max(heightMm, 0));
  }, [hasGeometry, layerIndex, layerHeightMm, heightMm]);

  const clipLower = useMemo(() => null, []); // Always show from bottom

  const clipUpper = useMemo(() => {
    if (!hasGeometry || layerIndex === 0) return null;
    const EPS = 1e-6;
    const upper = zRange.min + (layerIndex * layerHeightMm) + EPS;
    return Math.min(Math.max(upper, zRange.min), zRange.max + EPS);
  }, [hasGeometry, layerIndex, zRange, layerHeightMm]);

  return {
    layerHeightMicron,
    setLayerHeightMicron,
    crossSectionMode,
    setCrossSectionMode,
    layerIndex,
    setLayerIndex,
    layerHeightMm,
    heightMm,
    currentHeightMm,
    numLayers,
    clipLower,
    clipUpper
  };
}
