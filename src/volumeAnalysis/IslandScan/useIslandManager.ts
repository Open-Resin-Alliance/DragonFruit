import { useState, useCallback, useMemo } from 'react';
import * as THREE from 'three';
import { runIslandScan, runScanlineScan, type ScanResults } from './ScanOrchestrator';
import { runIslandScanNative } from './nativeIslandScan';
import { computeIslandMarkers, type IslandMarker } from './islandOverlayLogic';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import { quaternionFromGlobalEuler } from '@/utils/rotation';

interface TransformState {
  position: THREE.Vector3;
  rotation: THREE.Euler;
  scale: THREE.Vector3;
}

interface IslandManagerProps {
  geom: GeometryWithBounds | null;
  transform: TransformState;
  layerHeightMm: number; // Passed from slicing manager
}

export function useIslandManager({ geom, transform, layerHeightMm }: IslandManagerProps) {
  // Scanning State
  const [scanning, setScanning] = useState<boolean>(false);
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number } | null>(null);
  const [scanData, setScanData] = useState<ScanResults | null>(null);
  const [scanBBox, setScanBBox] = useState<THREE.Box3 | null>(null);

  // Scan Parameters
  const [pxMm, setPxMm] = useState<number>(0.10);
  const [supportBufMm, setSupportBufMm] = useState<number>(0.6);
  const [connectivity, setConnectivity] = useState<4 | 8>(4);
  const [minIslandAreaMm2, setMinIslandAreaMm2] = useState<number>(0);
  const [minOverlapPx, setMinOverlapPx] = useState<number>(4);
  const [overlapNeighborhoodPx, setOverlapNeighborhoodPx] = useState<number>(1);
  const [useSurfaceContiguity, setUseSurfaceContiguity] = useState<boolean>(false);

  // Native (Rust) toggle
  const [useNativeScan, setUseNativeScan] = useState<boolean>(true);

  // UI State
  const [scanCardExpanded, setScanCardExpanded] = useState<boolean>(true);

  // Overlay State
  const [overlayEnabled, setOverlayEnabled] = useState<boolean>(false);
  const [overlayBrushRadius, setOverlayBrushRadius] = useState<number>(0.5);
  const [overlayColor, setOverlayColor] = useState<string>('#ff0000');
  const [overlayOpacity, setOverlayOpacity] = useState<number>(1.0);
  const [showIslandIdLabels, setShowIslandIdLabels] = useState<boolean>(false);
  const [overlayTaper, setOverlayTaper] = useState<number>(0.60);

  // Selection State
  const [selectedIslandId, setSelectedIslandId] = useState<number | null>(null);
  const [showMerged, setShowMerged] = useState<boolean>(false);

  // Voxel State
  const [voxelEnabled, setVoxelEnabled] = useState<boolean>(false);
  const [voxelColorScheme, setVoxelColorScheme] = useState<'unique' | 'lifecycle' | 'height'>('unique');
  const [voxelOpacity, setVoxelOpacity] = useState<number>(1.0);
  const [voxelShowMerged, setVoxelShowMerged] = useState<boolean>(true);
  const [voxelShowTerritory, setVoxelShowTerritory] = useState<boolean>(false);

  // Helper to prepare geometry for scanning
  const prepareTransformedGeom = useCallback(() => {
    if (!geom) return null;

    const transformedGeom = geom.geometry.clone();

    // Center offset (negate to move geometry)
    // Note: geom.bbox is world-aligned but geom.geometry might need centering if it wasn't baked
    // In page.tsx: 
    // const bbox = geom.geometry.boundingBox ...
    // const centerOffset = bbox.getCenter(...)
    // transformedGeom.translate(-centerOffset.x...)

    const bbox = geom.geometry.boundingBox ?? new THREE.Box3().setFromBufferAttribute(
      geom.geometry.getAttribute('position') as THREE.BufferAttribute
    );
    const centerOffset = bbox.getCenter(new THREE.Vector3());

    transformedGeom.translate(-centerOffset.x, -centerOffset.y, -centerOffset.z);

    const quaternion = quaternionFromGlobalEuler(transform.rotation);
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(transform.position.x, transform.position.y, transform.position.z),
      quaternion,
      new THREE.Vector3(transform.scale.x, transform.scale.y, transform.scale.z)
    );
    transformedGeom.applyMatrix4(matrix);
    transformedGeom.computeBoundingBox();

    return transformedGeom;
  }, [geom, transform]);

  const onRunIslandScan = useCallback(async () => {
    if (!geom) return;
    const transformedGeom = prepareTransformedGeom();
    if (!transformedGeom) return;

    setScanning(true);
    const transformedBBox = transformedGeom.boundingBox!;
    setScanBBox(transformedBBox);

    setScanProgress({ done: 0, total: Math.max(0, Math.ceil((transformedBBox.max.z - transformedBBox.min.z) / layerHeightMm)) });

    try {
      const res = await runIslandScan(
        { geometry: transformedGeom, bbox: transformedBBox },
        layerHeightMm,
        {
          px_mm: pxMm,
          support_buffer_mm: supportBufMm,
          connectivity,
          min_island_area_mm2: minIslandAreaMm2,
          min_overlap_px: minOverlapPx,
          overlap_neighborhood_px: overlapNeighborhoodPx,
          useSurfaceContiguity,
        },
        (done, total) => setScanProgress({ done, total })
      );
      setScanData(res);
    } finally {
      setScanning(false);
    }
  }, [geom, prepareTransformedGeom, layerHeightMm, pxMm, supportBufMm, connectivity, minIslandAreaMm2, minOverlapPx, overlapNeighborhoodPx, useSurfaceContiguity]);

  const onRunScanlineScan = useCallback(async () => {
    if (!geom) return;
    const transformedGeom = prepareTransformedGeom();
    if (!transformedGeom) return;

    setScanning(true);
    const transformedBBox = transformedGeom.boundingBox!;
    setScanBBox(transformedBBox);

    setScanProgress({ done: 0, total: Math.max(0, Math.ceil((transformedBBox.max.z - transformedBBox.min.z) / layerHeightMm)) });

    const startTime = performance.now();
    try {
      const res = await runScanlineScan(
        { geometry: transformedGeom, bbox: transformedBBox },
        layerHeightMm,
        {
          px_mm: pxMm,
          support_buffer_mm: supportBufMm,
          connectivity,
          min_island_area_mm2: minIslandAreaMm2,
          min_overlap_px: minOverlapPx,
          overlap_neighborhood_px: overlapNeighborhoodPx,
          useSurfaceContiguity,
        },
        (done, total) => setScanProgress({ done, total })
      );
      const endTime = performance.now();
      console.log(`Scanline Scan took ${(endTime - startTime).toFixed(2)}ms`);
      setScanData(res);
    } finally {
      setScanning(false);
    }
  }, [geom, prepareTransformedGeom, layerHeightMm, pxMm, supportBufMm, connectivity, minIslandAreaMm2, minOverlapPx, overlapNeighborhoodPx, useSurfaceContiguity]);

  const onRunNativeIslandScan = useCallback(async () => {
    if (!geom) return;
    const transformedGeom = prepareTransformedGeom();
    if (!transformedGeom) return;

    setScanning(true);
    const transformedBBox = transformedGeom.boundingBox!;
    setScanBBox(transformedBBox);

    const numLayers = Math.max(0, Math.ceil((transformedBBox.max.z - transformedBBox.min.z) / layerHeightMm));
    setScanProgress({ done: 0, total: numLayers });

    const startTime = performance.now();
    try {
      const res = await runIslandScanNative(
        { geometry: transformedGeom, bbox: transformedBBox },
        layerHeightMm,
        {
          px_mm: pxMm,
          support_buffer_mm: supportBufMm,
          connectivity,
          min_island_area_mm2: minIslandAreaMm2,
          min_overlap_px: minOverlapPx,
          overlap_neighborhood_px: overlapNeighborhoodPx,
        },
        (done, total) => setScanProgress({ done, total })
      );
      const endTime = performance.now();
      console.log(`Native Island Scan took ${(endTime - startTime).toFixed(2)}ms`);
      setScanData(res);
    } finally {
      setScanning(false);
    }
  }, [geom, prepareTransformedGeom, layerHeightMm, pxMm, supportBufMm, connectivity, minIslandAreaMm2, minOverlapPx, overlapNeighborhoodPx]);

  // Compute markers
  const islandMarkers = useMemo<IslandMarker[]>(() => {
    if (!scanData || !scanBBox) return [];
    return computeIslandMarkers(scanData, scanBBox, layerHeightMm, overlayTaper);
  }, [scanData, scanBBox, layerHeightMm, overlayTaper]);

  // Clear scan data (e.g. on rotation)
  const clearScanData = useCallback(() => {
    setScanData(null);
    setOverlayEnabled(false);
    setVoxelEnabled(false);
    setSelectedIslandId(null);
  }, []);

  return {
    scanning,
    scanProgress,
    scanData,
    setScanData,
    scanBBox,
    pxMm, setPxMm,
    supportBufMm, setSupportBufMm,
    connectivity, setConnectivity,
    minIslandAreaMm2, setMinIslandAreaMm2,
    minOverlapPx, setMinOverlapPx,
    overlapNeighborhoodPx, setOverlapNeighborhoodPx,
    useSurfaceContiguity, setUseSurfaceContiguity,
    scanCardExpanded, setScanCardExpanded,
    overlayEnabled, setOverlayEnabled,
    overlayBrushRadius, setOverlayBrushRadius,
    overlayColor, setOverlayColor,
    overlayOpacity, setOverlayOpacity,
    showIslandIdLabels, setShowIslandIdLabels,
    overlayTaper, setOverlayTaper,
    selectedIslandId, setSelectedIslandId,
    showMerged, setShowMerged,
    voxelEnabled, setVoxelEnabled,
    voxelColorScheme, setVoxelColorScheme,
    voxelOpacity, setVoxelOpacity,
    voxelShowMerged, setVoxelShowMerged,
    voxelShowTerritory, setVoxelShowTerritory,
    islandMarkers,
    onRunIslandScan,
    onRunScanlineScan,
    onRunNativeIslandScan,
    useNativeScan, setUseNativeScan,
    clearScanData
  };
}
