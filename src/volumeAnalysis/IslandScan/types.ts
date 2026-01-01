export type Connectivity = 4 | 8;

export interface RasterScanOptions {
  px_mm: number;
  support_buffer_mm: number;
  connectivity?: Connectivity;
  min_island_area_mm2?: number; // Minimum area in mm² for an island to be kept (default: 0.01)
}

export interface Bounds2D {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface Mask {
  data: Uint8Array; // row-major, length = width * height, 0/1 values
  width: number;
  height: number;
  originX: number; // world X at column 0 center
  originZ: number; // world Z at row 0 center (note: we map THREE.Vector2 y <- -Z)
  px_mm: number;
}

export interface Labels {
  data: Int32Array; // row-major labels, 0 = background
  width: number;
  height: number;
}

export interface ComponentInfo {
  id: number;
  label: number; // Component label in the labels array
  area_px: number;
  size: number; // Number of pixels in the component
  centroidSumX: number; // Sum of X coordinates for centroid calc
  centroidSumY: number; // Sum of Y coordinates for centroid calc
}

export interface Island {
  id: number;
  firstLayer: number;
  lastLayer: number;
  status: 'active' | 'complete';
  totalAreaMm2: number; // Sum of all layer areas (for backward compatibility)
  perLayerAreaMm2: Map<number, number>;
  parentId?: number; // null if never merged, otherwise ID of parent island
  childIds: number[]; // IDs of islands that merged into this one
  volumeMm3?: number; // Calculated volume in mm³ (computed separately)
  maxAreaMm2?: number; // Maximum cross-sectional area across all layers
  maxAreaLayer?: number; // Layer index where maximum area occurs
  isMergedPlaceholder?: boolean; // True for temporary merged islands created during evaluation
  centroidSumX: number; // Accumulator for global centroid X
  centroidSumY: number; // Accumulator for global centroid Y
  centroidSumZ: number; // Accumulator for global centroid Z
  centroidCount: number; // Total pixel count for global centroid
  centroid?: { x: number; y: number; z: number }; // Final computed global centroid (mm)
  lastLayerCentroid?: { x: number; y: number; z: number }; // Centroid of the LAST active layer (Terminal Centroid)
}

export interface LayerIslandResult {
  labels: Labels; // per-pixel island IDs (0 = not island)
  components: ComponentInfo[]; // component metadata for this layer
  islandMask: Uint8Array; // binary mask of island pixels
}
