import { useState, useEffect, useMemo } from 'react';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';

interface SlicingStateProps {
  hasGeometry: boolean;
  zRange: { min: number; max: number };
}

export function useSlicingManager({ hasGeometry, zRange }: SlicingStateProps) {
  const [layerHeightMicron, setLayerHeightMicron] = useState<number>(50);
  const [crossSectionMode, setCrossSectionMode] = useState<'smooth' | 'rasterized'>('smooth');
  const [layerIndex, setLayerIndex] = useState<number>(0);

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

  const clipLower = useMemo(() => null, []); // Always show from bottom

  const clipUpper = useMemo(() => {
    if (!hasGeometry || layerIndex === 0) return null;
    const EPS = 1e-6;
    const upper = layerIndex * layerHeightMm + EPS;
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
    numLayers,
    clipLower,
    clipUpper
  };
}
