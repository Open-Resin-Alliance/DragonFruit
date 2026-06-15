import * as THREE from 'three';
import type { IslandMarker } from './islandOverlayLogic';

export interface DecalGridResult {
  gridTexture: THREE.DataTexture;
  markerTexture: THREE.DataTexture;
  markerMetaTexture: THREE.DataTexture;
  bboxMin: THREE.Vector3;
  bboxMax: THREE.Vector3;
}

export function generateDecalGrid(
  markers: IslandMarker[],
  bbox: THREE.Box3 | null
): DecalGridResult {
  if (!bbox || markers.length === 0) {
    // Return dummy 1x1 textures to avoid WebGL binding errors
    const dummyGrid = new Float32Array(4);
    dummyGrid.fill(-1.0);
    const dummyMarker = new Float32Array(4);
    const dummyMeta = new Float32Array(4);
    
    const gridTexture = new THREE.DataTexture(dummyGrid, 1, 1, THREE.RGBAFormat, THREE.FloatType);
    gridTexture.internalFormat = 'RGBA32F';
    gridTexture.needsUpdate = true;
    const markerTexture = new THREE.DataTexture(dummyMarker, 1, 1, THREE.RGBAFormat, THREE.FloatType);
    markerTexture.internalFormat = 'RGBA32F';
    markerTexture.needsUpdate = true;
    const markerMetaTexture = new THREE.DataTexture(dummyMeta, 1, 1, THREE.RGBAFormat, THREE.FloatType);
    markerMetaTexture.internalFormat = 'RGBA32F';
    markerMetaTexture.needsUpdate = true;

    return {
      gridTexture,
      markerTexture,
      markerMetaTexture,
      bboxMin: new THREE.Vector3(),
      bboxMax: new THREE.Vector3(),
    };
  }

  const min = bbox.min;
  const max = bbox.max;
  const dx = (max.x - min.x) || 1.0;
  const dy = (max.y - min.y) || 1.0;

  // 1. Build the 1D Marker Textures (unpacked)
  const markerCount = markers.length;
  const markerData = new Float32Array(markerCount * 4);
  const markerMetaData = new Float32Array(markerCount * 4);

  for (let i = 0; i < markerCount; i++) {
    const marker = markers[i] as any;
    const cx = marker.centerX;
    const cy = marker.centerY;
    const cz = marker.baseZ;
    const r = marker.radius ?? 0.1;
    const type = marker.type ?? 0;
    const islandId = marker.islandId ?? marker.id;

    // R: cx, G: cy, B: cz, A: r
    markerData[i * 4] = cx;
    markerData[i * 4 + 1] = cy;
    markerData[i * 4 + 2] = cz;
    markerData[i * 4 + 3] = r;

    // R: islandId, G: type, B: 0, A: 0
    markerMetaData[i * 4] = islandId;
    markerMetaData[i * 4 + 1] = type;
    markerMetaData[i * 4 + 2] = 0.0;
    markerMetaData[i * 4 + 3] = 0.0;
  }

  const markerTexture = new THREE.DataTexture(markerData, markerCount, 1, THREE.RGBAFormat, THREE.FloatType);
  markerTexture.minFilter = THREE.NearestFilter;
  markerTexture.magFilter = THREE.NearestFilter;
  markerTexture.internalFormat = 'RGBA32F';
  markerTexture.needsUpdate = true;

  const markerMetaTexture = new THREE.DataTexture(markerMetaData, markerCount, 1, THREE.RGBAFormat, THREE.FloatType);
  markerMetaTexture.minFilter = THREE.NearestFilter;
  markerMetaTexture.magFilter = THREE.NearestFilter;
  markerMetaTexture.internalFormat = 'RGBA32F';
  markerMetaTexture.needsUpdate = true;

  // 2. Build the 2D Spatial Index Grid Texture
  const W = 256;
  const H = 256;
  const gridData = new Float32Array(W * H * 4);
  gridData.fill(-1.0); // Initialize all index slots to -1.0

  for (let i = 0; i < markerCount; i++) {
    const marker = markers[i] as any;
    if (marker.id < 0) continue; // Skip utility/seed markers

    const cx = marker.centerX;
    const cy = marker.centerY;
    const r = marker.radius ?? 0.1;
    const rDilated = r + 0.15; // 0.15mm padding for smooth anti-aliased edge interpolation

    // Find the cell bounding box in grid space, dilated by ±1 cell to prevent clipping of small circles
    const xStart = Math.max(0, Math.floor(((cx - rDilated - min.x) / dx) * W) - 1);
    const xEnd = Math.min(W - 1, Math.ceil(((cx + rDilated - min.x) / dx) * W) + 1);
    const yStart = Math.max(0, Math.floor(((cy - rDilated - min.y) / dy) * H) - 1);
    const yEnd = Math.min(H - 1, Math.ceil(((cy + rDilated - min.y) / dy) * H) + 1);

    // Rasterize marker index into overlapping grid cells in the bounding box (conservative)
    for (let gy = yStart; gy <= yEnd; gy++) {
      for (let gx = xStart; gx <= xEnd; gx++) {
        const pixelIdx = (gx + gy * W) * 4;
        
        // Store index in the first available channel slot
        for (let c = 0; c < 4; c++) {
          if (gridData[pixelIdx + c] === -1.0) {
            gridData[pixelIdx + c] = i;
            break;
          }
        }
      }
    }
  }

  const gridTexture = new THREE.DataTexture(gridData, W, H, THREE.RGBAFormat, THREE.FloatType);
  gridTexture.minFilter = THREE.NearestFilter;
  gridTexture.magFilter = THREE.NearestFilter;
  gridTexture.wrapS = THREE.ClampToEdgeWrapping;
  gridTexture.wrapT = THREE.ClampToEdgeWrapping;
  gridTexture.internalFormat = 'RGBA32F';
  gridTexture.needsUpdate = true;

  return {
    gridTexture,
    markerTexture,
    markerMetaTexture,
    bboxMin: min.clone(),
    bboxMax: max.clone(),
  };
}
