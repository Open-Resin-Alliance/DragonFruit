import { type ScanResults, type GridRef, VOXEL_OFFSET_X, VOXEL_OFFSET_Y } from './ScanOrchestrator';
import * as THREE from 'three';

export type IslandMarker = {
  id: number;
  centerX: number;
  centerY: number;
  baseZ: number;
  pixelCount: number;
  geometry?: THREE.BufferGeometry; // 3D shape from island contours
  radius?: number; // Optional radius for geometry-independent rendering
};

/**
 * Computes island marker positions and 3D geometries from scan results.
 * Creates low-poly 3D shapes based on the first few layers of each island.
 * 
 * COORDINATE SYSTEM:
 * - World space uses Z-up: X and Y are horizontal, Z is vertical
 * - Grid space is a 2D raster of the horizontal XY plane
 * - grid.originX: World X coordinate of the grid origin
 * - grid.originZ: Confusingly named! Actually stores -Y values (legacy from Y-up system)
 * - grid.width: Number of pixels in X direction
 * - grid.height: Number of pixels in Y direction (rows)
 * 
 * CONVERSION:
 * - Grid column → World X: originX + col * px_mm
 * - Grid row → World Y: -(originZ + row * px_mm)  [negation undoes the -Y storage]
 */
export function computeIslandMarkers(
  scanResults: ScanResults,
  bbox: { min: { z: number } },
  layerHeightMm: number,
  taperFactor: number = 0.25
): IslandMarker[] {
  const { grid, islands, islandLabelsPerLayer, compBase } = scanResults;
  const markers: IslandMarker[] = [];

  // Build a map of actual layer ranges for each island from the label data.
  // This mirrors IslandVoxelVisualization and is more reliable than compBase
  // after placeholder reassignment.
  const islandLayerRanges = new Map<number, { first: number; last: number }>();

  for (let layer = 0; layer < islandLabelsPerLayer.length; layer++) {
    const layerLabels = islandLabelsPerLayer[layer];
    for (let y = 0; y < layerLabels.height; y++) {
      const row = layerLabels.rows[y];
      for (let i = 0; i < row.length; i += 3) {
        const islandId = row[i + 2];
        if (islandId > 0) {
          const range = islandLayerRanges.get(islandId);
          if (!range) {
            islandLayerRanges.set(islandId, { first: layer, last: layer });
          } else {
            range.last = layer;
          }
        }
      }
    }
  }

  // Iterate actual islands directly so that every detected island
  // (including those that start above other geometry) can get a marker.
  for (const island of islands) {
    // Only show markers for leaf islands (no children). Parent islands often
    // represent merged volumes and their lower boundaries are not true
    // unsupported bases.
    if (island.childIds && island.childIds.length > 0) continue;

    const label = island.id;
    const range = islandLayerRanges.get(label);

    // Preferred base layer: compBase / island.firstLayer (true unsupported seed).
    let baseLayer = compBase[label] ?? island.firstLayer;

    // Fallback: if compBase is invalid or has no labels, use first layer with pixels.
    if (baseLayer < 0 || baseLayer >= islandLabelsPerLayer.length) {
      if (!range) continue; // No pixels at all for this island
      baseLayer = range.first;
    }

    if (baseLayer < 0 || baseLayer >= islandLabelsPerLayer.length) continue;
    const rleLabels = islandLabelsPerLayer[baseLayer];

    let sumX = 0;  // Accumulate world X coordinates
    let sumY = 0;  // Accumulate world Y coordinates
    let count = 0;

    // Walk the RLE rows for the island's base layer and collect pixels
    for (let rowIndex = 0; rowIndex < rleLabels.height; rowIndex++) {
      const row = rleLabels.rows[rowIndex];

      for (let i = 0; i < row.length; i += 3) {
        const start = row[i];
        const len = row[i + 1];
        const id = row[i + 2];

        if (id !== label) continue;

        // Expand this run into individual pixels to compute centroid
        for (let j = 0; j < len; j++) {
          const col = start + j; // X direction in grid

          // Convert grid coordinates to world XY coordinates
          // X: straightforward mapping from column with voxel offset
          const worldX = grid.originX + col * grid.px_mm + grid.px_mm * VOXEL_OFFSET_X;
          // Y: grid.originZ stores -Y, so negate to get back to +Y
          // Subtract offset inside negation to shift Up (Positive Y)
          const worldY = -(grid.originZ + rowIndex * grid.px_mm - grid.px_mm * VOXEL_OFFSET_Y);

          sumX += worldX;
          sumY += worldY;
          count++;
        }
      }
    }

    if (count === 0) {
      continue;
    }

    const centerX = sumX / count;
    const centerY = sumY / count;
    const baseZ = bbox.min.z + baseLayer * layerHeightMm;

    // Build 3D geometry from first few layers of this island, using the
    // same base layer we just computed.
    const geometry = buildIslandGeometry(label, scanResults, bbox.min.z, layerHeightMm, 3, taperFactor, baseLayer);

    markers.push({
      id: label,
      centerX,
      centerY,
      baseZ,
      pixelCount: count,
      geometry,
    });
  }

  return markers;
}

/**
 * Builds a low-poly 3D geometry from the first N layers of an island.
 * Creates an extruded shape based on the island's actual pixel footprint using convex hull.
 */
function buildIslandGeometry(
  label: number,
  scanResults: ScanResults,
  minZ: number,
  layerHeightMm: number,
  numLayers: number,
  taperFactor: number,
  baseLayerOverride?: number
): THREE.BufferGeometry {
  const { grid, islandLabelsPerLayer } = scanResults;
  const baseLayer = baseLayerOverride ?? 0;

  // Collect pixels for this island at base layer directly from islandLabelsPerLayer
  const pixels: Array<{ x: number; y: number }> = [];

  const rleLabels = islandLabelsPerLayer[baseLayer];
  if (!rleLabels) {
    return new THREE.BufferGeometry();
  }

  for (let rowIndex = 0; rowIndex < rleLabels.height; rowIndex++) {
    const row = rleLabels.rows[rowIndex];

    for (let i = 0; i < row.length; i += 3) {
      const start = row[i];
      const len = row[i + 1];
      const id = row[i + 2];

      if (id !== label) continue;

      for (let j = 0; j < len; j++) {
        const col = start + j;
        const worldX = grid.originX + col * grid.px_mm + grid.px_mm * VOXEL_OFFSET_X;
        const worldY = -(grid.originZ + rowIndex * grid.px_mm - grid.px_mm * VOXEL_OFFSET_Y);
        pixels.push({ x: worldX, y: worldY });
      }
    }
  }

  if (pixels.length === 0) {
    return new THREE.BufferGeometry();
  }

  // For very small islands (1-2 pixels), use circular shape
  if (pixels.length <= 2) {
    return createCircleFromPixels(pixels, minZ, baseLayer, layerHeightMm, numLayers, grid.px_mm);
  }

  // Compute convex hull of pixels for better shape
  const hull = computeConvexHull(pixels);

  if (hull.length < 3) {
    // Fallback to circular shape if hull computation fails
    return createCircleFromPixels(pixels, minZ, baseLayer, layerHeightMm, numLayers, grid.px_mm);
  }

  // Create tapered cone-like shape for dramatic 3D effect
  const height = layerHeightMm * numLayers;
  const baseZ = minZ + baseLayer * layerHeightMm;

  // Calculate hull bounds and apply minimum size scaling
  let hullMinX = Infinity, hullMaxX = -Infinity;
  let hullMinY = Infinity, hullMaxY = -Infinity;
  for (const p of hull) {
    if (p.x < hullMinX) hullMinX = p.x;
    if (p.x > hullMaxX) hullMaxX = p.x;
    if (p.y < hullMinY) hullMinY = p.y;
    if (p.y > hullMaxY) hullMaxY = p.y;
  }

  const hullCenterX = (hullMinX + hullMaxX) / 2;
  const hullCenterY = (hullMinY + hullMaxY) / 2;
  const hullWidth = hullMaxX - hullMinX;
  const hullDepth = hullMaxY - hullMinY;

  // Minimum size for visibility (0.5mm)
  const minSize = 0.5;
  const scaleX = Math.max(1, minSize / hullWidth);
  const scaleY = Math.max(1, minSize / hullDepth);

  // Create base shape from hull points, scaled if needed
  const shape = new THREE.Shape();
  const scaledHull = hull.map(p => ({
    x: hullCenterX + (p.x - hullCenterX) * scaleX,
    y: hullCenterY + (p.y - hullCenterY) * scaleY
  }));

  shape.moveTo(scaledHull[0].x, scaledHull[0].y);
  for (let i = 1; i < scaledHull.length; i++) {
    shape.lineTo(scaledHull[i].x, scaledHull[i].y);
  }
  shape.closePath();

  // Use custom extrude with scale function for dramatic taper
  const extrudeSettings = {
    depth: height,
    bevelEnabled: false,
    steps: 4, // More steps for smoother taper
    extrudePath: undefined,
    UVGenerator: undefined as any,
    // Scale function: starts at 1.0 (base) and tapers to 0.3 (top)
    // This creates a cone/pyramid effect
  };

  // Create custom geometry with manual scaling per step
  const baseGeometry = new THREE.ExtrudeGeometry(shape, extrudeSettings);

  // Apply taper by scaling vertices based on their Z position (extrusion direction)
  const positions = baseGeometry.attributes.position;

  // Find centroid of scaled hull for taper scaling origin
  let cx = 0, cy = 0;
  for (const p of scaledHull) {
    cx += p.x;
    cy += p.y;
  }
  cx /= scaledHull.length;
  cy /= scaledHull.length;

  for (let i = 0; i < positions.count; i++) {
    const z = positions.getZ(i); // Z is extrusion direction
    const t = z / height; // 0 at base, 1 at top
    const scale = taperFactor + (1.0 - taperFactor) * t; // Linear taper from taperFactor at base to 1.0 at top

    // Get XY position of vertex
    const x = positions.getX(i);
    const y = positions.getY(i);

    // Scale towards center
    const dx = x - cx;
    const dy = y - cy;
    positions.setX(i, cx + dx * scale);
    positions.setY(i, cy + dy * scale);
  }

  positions.needsUpdate = true;
  baseGeometry.computeVertexNormals(); // Recompute normals after scaling

  // Position at base Z height (extrusion already goes along Z axis)
  baseGeometry.translate(0, 0, baseZ);

  return baseGeometry;
}

/**
 * Simple convex hull using gift wrapping algorithm (Jarvis march)
 */
function computeConvexHull(points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  if (points.length < 3) return points;

  // Find leftmost point
  let leftmost = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].x < points[leftmost].x ||
      (points[i].x === points[leftmost].x && points[i].y < points[leftmost].y)) {
      leftmost = i;
    }
  }

  const hull: Array<{ x: number; y: number }> = [];
  let current = leftmost;

  do {
    hull.push(points[current]);
    let next = 0;

    for (let i = 0; i < points.length; i++) {
      if (i === current) continue;

      const cross = crossProduct(
        points[current],
        points[i],
        points[next]
      );

      if (next === current || cross > 0 ||
        (cross === 0 && distance(points[current], points[i]) > distance(points[current], points[next]))) {
        next = i;
      }
    }

    current = next;
  } while (current !== leftmost && hull.length < points.length);

  return hull;
}

function crossProduct(o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function createCircleFromPixels(
  pixels: Array<{ x: number; y: number }>,
  minZ: number,
  baseLayer: number,
  layerHeightMm: number,
  numLayers: number,
  pxMm: number
): THREE.BufferGeometry {
  // Calculate centroid
  let sumX = 0, sumY = 0;
  for (const p of pixels) {
    sumX += p.x;
    sumY += p.y;
  }
  const centerX = sumX / pixels.length;
  const centerY = sumY / pixels.length;

  // Calculate radius as max distance from center, with minimum size
  let maxDist = 0;
  for (const p of pixels) {
    const dx = p.x - centerX;
    const dy = p.y - centerY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > maxDist) maxDist = dist;
  }

  // Add padding and ensure minimum size (0.5mm diameter = 0.25mm radius)
  const radius = Math.max(0.25, maxDist + pxMm * 0.5);
  const height = layerHeightMm * numLayers;
  const baseZ = minZ + baseLayer * layerHeightMm;

  // Create cylinder geometry with higher polygon count for smoother appearance
  const geometry = new THREE.CylinderGeometry(radius, radius, height, 32);
  // Rotate to align with Z-up (cylinder is Y-up by default)
  geometry.rotateX(Math.PI / 2);
  geometry.translate(centerX, centerY, baseZ + height / 2);

  return geometry;
}

function createBoxFromPixels(
  pixels: Array<{ x: number; y: number }>,
  minZ: number,
  baseLayer: number,
  layerHeightMm: number,
  numLayers: number,
  pxMm: number
): THREE.BufferGeometry {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;

  for (const p of pixels) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  const padding = pxMm * 0.5;
  minX -= padding;
  maxX += padding;
  minY -= padding;
  maxY += padding;

  // Calculate center for minimum size enforcement
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  // Ensure minimum visible size (0.5mm x 0.5mm)
  const minSize = 0.5;
  let width = maxX - minX;
  let depth = maxY - minY;

  if (width < minSize) {
    width = minSize;
    minX = centerX - minSize / 2;
    maxX = centerX + minSize / 2;
  }
  if (depth < minSize) {
    depth = minSize;
    minY = centerY - minSize / 2;
    maxY = centerY + minSize / 2;
  }

  const height = layerHeightMm * numLayers;
  const baseZ = minZ + baseLayer * layerHeightMm;

  const geometry = new THREE.BoxGeometry(width, depth, height);
  geometry.translate((minX + maxX) / 2, (minY + maxY) / 2, baseZ + height / 2);

  return geometry;
}

/**
 * Computes visualization markers for Seed Voxels.
 * These are single voxels that identify the "Internal Center" of each island.
 */
export function computeSeedMarkers(
  scanResults: ScanResults,
  bbox: { min: { z: number } },
  layerHeightMm: number
): IslandMarker[] {
  const { grid, islands } = scanResults;
  const markers: IslandMarker[] = [];
  const SEED_OFFSET = 1_000_000;

  const boxGeometry = new THREE.BoxGeometry(grid.px_mm, grid.px_mm, layerHeightMm);

  for (const island of islands) {
    if (!island.seedVoxel) continue;

    const { x: col, y: row, z: layer } = island.seedVoxel;

    // Convert grid coordinates to world coordinates
    // Matches logic in computeIslandMarkers for perfect alignment
    const worldX = grid.originX + col * grid.px_mm + grid.px_mm * VOXEL_OFFSET_X;
    // Y: grid.originZ stores -Y, negation undoes it. Subtract offset inside negation to shift up.
    // Note: computeIslandMarkers uses logic: `-(grid.originZ + rowIndex * grid.px_mm - grid.px_mm * VOXEL_OFFSET_Y)`
    const worldY = -(grid.originZ + row * grid.px_mm - grid.px_mm * VOXEL_OFFSET_Y);
    const worldZ = bbox.min.z + layer * layerHeightMm + layerHeightMm / 2; // Center Z

    // Clone geometry and position
    const geom = boxGeometry.clone();
    geom.translate(worldX, worldY, worldZ);

    markers.push({
      id: -island.id - SEED_OFFSET, // Result: e.g., -1000001
      centerX: worldX,
      centerY: worldY,
      baseZ: worldZ,
      pixelCount: 1,
      geometry: geom
    });
  }

  return markers;
}
