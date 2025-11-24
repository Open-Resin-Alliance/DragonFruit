import type { ScanResults, GridRef } from './ScanOrchestrator';
import * as THREE from 'three';

export type IslandMarker = {
  id: number;
  centerX: number;
  centerY: number;
  baseZ: number;
  pixelCount: number;
  geometry?: THREE.BufferGeometry; // 3D shape from island contours
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
  const { grid, baseLabels, compBase, firstHit, islands } = scanResults;
  const markers: IslandMarker[] = [];

  // Use filtered islands list instead of baseLabels to avoid showing filtered-out islands
  // Create set of valid island IDs that passed the volume filter
  const validIslandIds = new Set(islands.map(island => island.id));

  // Find all unique island labels from baseLabels that are still valid
  const labelSet = new Set<number>();
  for (let i = 0; i < baseLabels.length; i++) {
    const label = baseLabels[i];
    if (label > 0 && validIslandIds.has(label)) {
      labelSet.add(label);
    }
  }

  // For each valid island, compute centroid of base pixels
  for (const label of labelSet) {
    let sumX = 0;  // Accumulate world X coordinates
    let sumY = 0;  // Accumulate world Y coordinates
    let count = 0;

    for (let idx = 0; idx < baseLabels.length; idx++) {
      if (baseLabels[idx] !== label) continue;
      
      // Only include pixels at the base layer
      const baseLayer = compBase[label];
      if (firstHit[idx] !== baseLayer) continue;

      // Convert 1D grid index to 2D row/col
      const row = Math.floor(idx / grid.width);  // Y direction in grid
      const col = idx % grid.width;              // X direction in grid

      // Convert grid coordinates to world XY coordinates
      // X: straightforward mapping from column
      const worldX = grid.originX + col * grid.px_mm;
      // Y: grid.originZ stores -Y, so negate to get back to +Y
      const worldY = -(grid.originZ + row * grid.px_mm);

      sumX += worldX;
      sumY += worldY;
      count++;
    }

    if (count === 0) continue;

    const centerX = sumX / count;
    const centerY = sumY / count;
    const baseLayer = compBase[label];
    const baseZ = bbox.min.z + baseLayer * layerHeightMm;

    // Build 3D geometry from first few layers of this island
    const geometry = buildIslandGeometry(label, scanResults, bbox.min.z, layerHeightMm, 3, taperFactor);

    markers.push({
      id: label,
      centerX,
      centerY,
      baseZ,
      pixelCount: count,
      geometry
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
  taperFactor: number
): THREE.BufferGeometry {
  const { grid, layers, baseLabels, compBase, firstHit } = scanResults;
  const baseLayer = compBase[label];
  
  // Collect pixels for this island at base layer
  const pixels: Array<{ x: number; y: number }> = [];
  
  for (let idx = 0; idx < baseLabels.length; idx++) {
    if (baseLabels[idx] !== label) continue;
    if (firstHit[idx] !== baseLayer) continue;
    
    const row = Math.floor(idx / grid.width);
    const col = idx % grid.width;
    const worldX = grid.originX + col * grid.px_mm;
    const worldY = -(grid.originZ + row * grid.px_mm);
    
    pixels.push({ x: worldX, y: worldY });
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
