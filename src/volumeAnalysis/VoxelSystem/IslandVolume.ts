import type { Island } from '../IslandScan/types';
import type { ScanResults } from '../IslandScan/ScanOrchestrator';

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
    const rleLabels = islandLabelsPerLayer[layerIdx];
    const pixels: number[] = [];

    for (let y = 0; y < rleLabels.height; y++) {
      const row = rleLabels.rows[y];
      const rowOffset = y * grid.width;
      for (let i = 0; i < row.length; i += 3) {
        const start = row[i];
        const len = row[i + 1];
        const id = row[i + 2];

        if (id === islandId) {
          for (let j = 0; j < len; j++) {
            pixels.push(rowOffset + start + j);
          }
        }
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
  // Use the Surface implementation by default for now to prevent crashes
  // If we need internal voxels later, we can make a dedicated function or flag
  return getSurfacePixelsWorldCoords(islandId, scanResults);
}

/**
 * Get internal/all pixels (Legacy/Full implementation).
 */
export function getAllIslandPixelsWorldCoords(
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
 * Get ONLY SURFACE pixels belonging to an island in world coordinates.
 * A pixel is "Surface" if it has at least one empty neighbor (3D).
 */
export function getSurfacePixelsWorldCoords(
  islandId: number,
  scanResults: ScanResults
): Array<{ layer: number; x: number; z: number }> {
  const { grid, islandLabelsPerLayer } = scanResults;
  const worldCoords: Array<{ layer: number; x: number; z: number }> = [];
  const pixelsByLayer = getIslandPixelsByLayer(islandId, scanResults);

  const w = grid.width;
  const h = grid.height;

  // Helper to check if a voxel is active (part of THIS island)
  // We already know we are iterating this island's pixels, so we just need to know 
  // if the neighbor exists in the general set of "Filled Voxels" or "Same Island"
  // Usually "Surface" means "Next to Air".
  const isSolid = (l: number, px: number): boolean => {
    if (l < 0 || l >= islandLabelsPerLayer.length) return false;

    // Fast cleanup check: existence in the general solid mask
    // But we have access to the full ID grid via getIslandIdAtPixel
    // Optimization: checking specific island ID is slower than just checking "Solid"
    // But for visual correctness of "Island Surface", we might want "Next to NOT THIS ISLAND"
    // Let's stick to "Next to Air" (0) for now as requested by "Shell".

    return getIslandIdAtPixel(l, px, scanResults) !== 0;
  };

  for (const [layer, pixels] of pixelsByLayer) {
    for (const pixelIdx of pixels) {
      const row = Math.floor(pixelIdx / w);
      const col = pixelIdx % w;

      // Check 6 Neighbors
      // If ANY neighbor is 0 (Air), this is a surface voxel.

      let isSurface = false;

      // 1. Layer Below
      if (!isSolid(layer - 1, pixelIdx)) isSurface = true;
      // 2. Layer Above
      else if (!isSolid(layer + 1, pixelIdx)) isSurface = true;
      // 3. Left
      else if (col > 0 && !isSolid(layer, pixelIdx - 1)) isSurface = true;
      else if (col === 0) isSurface = true; // Edge of grid
      // 4. Right
      else if (col < w - 1 && !isSolid(layer, pixelIdx + 1)) isSurface = true;
      else if (col === w - 1) isSurface = true;
      // 5. Up (Row - 1) *Note: grid Y is Z in 3D
      else if (row > 0 && !isSolid(layer, pixelIdx - w)) isSurface = true;
      else if (row === 0) isSurface = true;
      // 6. Down (Row + 1)
      else if (row < h - 1 && !isSolid(layer, pixelIdx + w)) isSurface = true;
      else if (row === h - 1) isSurface = true;


      if (isSurface) {
        const x = grid.originX + col * grid.px_mm;
        const z = grid.originZ + row * grid.px_mm;
        worldCoords.push({ layer, x, z });
      }
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
  const rleLabels = scanResults.islandLabelsPerLayer[layerIdx];
  const { width } = rleLabels;
  const y = Math.floor(pixelIdx / width);
  const x = pixelIdx % width;

  if (y < 0 || y >= rleLabels.height) return 0;

  const row = rleLabels.rows[y];
  for (let i = 0; i < row.length; i += 3) {
    const start = row[i];
    const len = row[i + 1];
    const id = row[i + 2];
    if (x >= start && x < start + len) {
      return id;
    }
  }
  return 0;
}

/**
 * Get the complete island hierarchy (parent-child relationships).
 * Returns a tree structure showing which islands merged into which.
 */
export function getIslandHierarchy(scanResults: ScanResults): Map<number, Island[]> {
  const hierarchy = new Map<number, Island[]>();

  for (const island of scanResults.islands) {
    if (island.parentId !== null && island.parentId !== undefined) {
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
  // Optimized volume calculation using pre-calculated areas if available
  // This avoids iterating pixels if perLayerAreaMm2 is populated
  if (island.perLayerAreaMm2 && island.perLayerAreaMm2.size > 0) {
    let totalVolumeMm3 = 0;
    const maxLayerToCount = island.status === 'complete'
      ? island.lastLayer - 1
      : island.lastLayer;

    for (const [layer, areaMm2] of island.perLayerAreaMm2) {
      if (layer <= maxLayerToCount) {
        totalVolumeMm3 += areaMm2 * layerHeightMm;
      }
    }
    return totalVolumeMm3;
  }

  // Fallback to pixel counting (slower)
  const pixelsByLayer = getIslandPixelsByLayer(island.id, scanResults);
  const pixelAreaMm2 = scanResults.grid.px_mm * scanResults.grid.px_mm;
  let totalVolumeMm3 = 0;

  const maxLayerToCount = island.status === 'complete'
    ? island.lastLayer - 1
    : island.lastLayer;

  for (const [layer, pixels] of pixelsByLayer) {
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
