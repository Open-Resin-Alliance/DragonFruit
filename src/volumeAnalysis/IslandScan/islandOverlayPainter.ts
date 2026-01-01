import * as THREE from 'three';
import { applyIslandSoftBrushByLabel } from '@/components/analysis/MeshPainter';
import type { ScanResults } from './ScanOrchestrator';

export type IslandOverlayOptions = {
  brushRadiusMm: number;
  color: string;
  opacity: number;
};

/**
 * Applies island overlay painting to mesh geometry using vertex colors.
 * Paints soft brush halos at island base locations directly on the mesh surface.
 */
export function applyIslandOverlay(
  geometry: THREE.BufferGeometry,
  baseColor: THREE.Color,
  scanResults: ScanResults,
  bbox: { min: { y: number } },
  layerHeightMm: number,
  options: IslandOverlayOptions
): number {
  const tintColor = new THREE.Color(options.color);
  
  // Adjust tint opacity by modifying the color intensity
  // (vertex colors don't support alpha, so we lerp toward base color)
  const effectiveTint = new THREE.Color().lerpColors(
    baseColor,
    tintColor,
    options.opacity
  );

  const painted = applyIslandSoftBrushByLabel(
    geometry,
    baseColor,
    scanResults.grid,
    scanResults.baseLabels,
    scanResults.firstHit,
    scanResults.compBase,
    bbox.min.y,
    layerHeightMm,
    options.brushRadiusMm,
    effectiveTint
  );

  return painted;
}
