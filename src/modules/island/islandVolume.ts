import type { Island } from './types';
import type { ScanResults } from './ScanOrchestrator';

/**
 * Get all pixels (grid indices) belonging to a specific island across all layers.
 * Returns a map of layer index -> pixel indices for that island.
 */
export function getIslandPixelsByLayer(
  islandId: number,
  scanResults: ScanResults
): Map<number, number[]> {
  const pixelsByLayer = new Map<number, number[]>();
  const { islandLabelsPerLayer, grid } = scanResults;

  for (let layerIdx = 0; layerIdx < islandLabelsPerLayer.length; layerIdx++) {
    const labels = islandLabelsPerLayer[layerIdx];
    const pixels: number[] = [];

    for (let i = 0; i < labels.length; i++) {
      if (labels[i] === islandId) {
        pixels.push(i);
      }
    }

    if (pixels.length > 0) {
      pixelsByLayer.set(layerIdx, pixels);
    }
  }

  return pixelsByLayer;
}

/**
 * Get all pixels belonging to an island in world coordinates (x, z).
 * Returns array of {layer, x, z} for each pixel.
 */
export function getIslandPixelsWorldCoords(
  islandId: number,
  scanResults: ScanResults
): Array<{ layer: number; x: number; z: number }> {
  const { grid } = scanResults;
  const pixelsByLayer = getIslandPixelsByLayer(islandId, scanResults);
  const worldCoords: Array<{ layer: number; x: number; z: number }> = [];

  for (const [layer, pixels] of pixelsByLayer) {
    for (const pixelIdx of pixels) {
      const row = Math.floor(pixelIdx / grid.width);
      const col = pixelIdx % grid.width;
      const x = grid.originX + col * grid.px_mm;
      const z = grid.originZ + row * grid.px_mm;
      worldCoords.push({ layer, x, z });
    }
  }

  return worldCoords;
}

/**
 * Get the 3D bounding box for an island in world coordinates.
 */
export function getIslandBoundingBox(
  island: Island,
  scanResults: ScanResults,
  layerHeightMm: number
): { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } {
  const coords = getIslandPixelsWorldCoords(island.id, scanResults);
  const { grid } = scanResults;
  const bbox = scanResults.grid;

  if (coords.length === 0) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
  }

  let minX = Infinity, maxX = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  for (const coord of coords) {
    minX = Math.min(minX, coord.x);
    maxX = Math.max(maxX, coord.x);
    minZ = Math.min(minZ, coord.z);
    maxZ = Math.max(maxZ, coord.z);
  }

  // Calculate Y bounds from layer indices
  const minY = island.firstLayer * layerHeightMm;
  const maxY = (island.lastLayer + 1) * layerHeightMm;

  return { minX, maxX, minY, maxY, minZ, maxZ };
}

/**
 * Get all islands that are active at a specific layer.
 */
export function getIslandsAtLayer(
  layerIdx: number,
  scanResults: ScanResults
): Island[] {
  return scanResults.islands.filter(
    island => island.firstLayer <= layerIdx && island.lastLayer >= layerIdx
  );
}

/**
 * Get the island ID at a specific pixel and layer.
 * Returns 0 if no island exists at that location.
 */
export function getIslandIdAtPixel(
  layerIdx: number,
  pixelIdx: number,
  scanResults: ScanResults
): number {
  if (layerIdx < 0 || layerIdx >= scanResults.islandLabelsPerLayer.length) {
    return 0;
  }
  const labels = scanResults.islandLabelsPerLayer[layerIdx];
  return labels[pixelIdx] || 0;
}

/**
 * Get the complete island hierarchy (parent-child relationships).
 * Returns a tree structure showing which islands merged into which.
 */
export function getIslandHierarchy(scanResults: ScanResults): Map<number, Island[]> {
  const hierarchy = new Map<number, Island[]>();

  for (const island of scanResults.islands) {
    if (island.parentId !== null) {
      if (!hierarchy.has(island.parentId)) {
        hierarchy.set(island.parentId, []);
      }
      hierarchy.get(island.parentId)!.push(island);
    }
  }

  return hierarchy;
}

/**
 * Get all descendants of an island (children, grandchildren, etc.).
 */
export function getIslandDescendants(
  islandId: number,
  scanResults: ScanResults
): Island[] {
  const descendants: Island[] = [];
  const hierarchy = getIslandHierarchy(scanResults);
  
  const collectDescendants = (id: number) => {
    const children = hierarchy.get(id) || [];
    for (const child of children) {
      descendants.push(child);
      collectDescendants(child.id);
    }
  };
  
  collectDescendants(islandId);
  return descendants;
}

/**
 * Calculate the total volume of an island in mm³.
 * Uses pixel area × layer height for each layer.
 * 
 * For merged islands (status='complete'), only counts volume up to the layer
 * BEFORE they merged (lastLayer is the merge point, not included in volume).
 * For active islands, counts full volume from firstLayer to lastLayer.
 */
export function calculateIslandVolume(
  island: Island,
  scanResults: ScanResults,
  layerHeightMm: number
): number {
  const pixelsByLayer = getIslandPixelsByLayer(island.id, scanResults);
  const pixelAreaMm2 = scanResults.grid.px_mm * scanResults.grid.px_mm;
  let totalVolumeMm3 = 0;

  // For merged islands, exclude the merge layer (lastLayer)
  // For active islands, include all layers
  const maxLayerToCount = island.status === 'complete' 
    ? island.lastLayer - 1 
    : island.lastLayer;

  for (const [layer, pixels] of pixelsByLayer) {
    // Skip layers beyond the counting range
    if (layer > maxLayerToCount) continue;
    
    const layerAreaMm2 = pixels.length * pixelAreaMm2;
    totalVolumeMm3 += layerAreaMm2 * layerHeightMm;
  }

  return totalVolumeMm3;
}

/**
 * Calculate and populate volumes for all islands in the scan results.
 * Modifies the islands in place by setting their volumeMm3 property.
 */
export function calculateAllIslandVolumes(
  scanResults: ScanResults,
  layerHeightMm: number
): void {
  for (const island of scanResults.islands) {
    island.volumeMm3 = calculateIslandVolume(island, scanResults, layerHeightMm);
  }
}
