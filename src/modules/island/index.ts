// Core island detection
export { scanLayer, computeSupported } from './island';
export { labelComponents } from './components';
export { rasterizeLoopsToMask, rasterizeLoopsToExistingGrid } from './raster';
export { dilate } from './morphology';

// Island tracking and propagation
export { IslandTracker } from './islandTracker';
export { runIslandScan } from './ScanOrchestrator';
export type { GridRef, ScanLayerResult, ScanResults, ScanParams } from './ScanOrchestrator';

// Island volume queries
export {
  getIslandPixelsByLayer,
  getIslandPixelsWorldCoords,
  getIslandBoundingBox,
  getIslandsAtLayer,
  getIslandIdAtPixel,
  getIslandHierarchy,
  getIslandDescendants,
  calculateIslandVolume,
  calculateAllIslandVolumes,
} from './islandVolume';

// Types
export type {
  Connectivity,
  RasterScanOptions,
  Bounds2D,
  Mask,
  Labels,
  ComponentInfo,
  Island,
  LayerIslandResult,
} from './types';

// Overlay and visualization
export { computeIslandMarkers } from './islandOverlayLogic';
export type { IslandMarker } from './islandOverlayLogic';
export { applyIslandOverlay } from './islandOverlayPainter';
export type { IslandOverlayOptions } from './islandOverlayPainter';
