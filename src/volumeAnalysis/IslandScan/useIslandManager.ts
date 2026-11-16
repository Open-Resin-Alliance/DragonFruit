import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import * as THREE from 'three';
import { runIslandScan, runScanlineScan, type ScanResults } from './ScanOrchestrator';
import { runIslandScanNative } from './nativeIslandScan';
import { computeIslandMarkers, type IslandMarker } from './islandOverlayLogic';
import { buildIslandInstances, VOXEL_DISC_RADIUS_FACTOR } from '@/volumeAnalysis/Islands/islandInstances';
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
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number; phase?: string; phaseNumber?: number; phaseCount?: number } | null>(null);
  const [scanData, setScanData] = useState<ScanResults | null>(null);
  const [scanBBox, setScanBBox] = useState<THREE.Box3 | null>(null);

  // Scan Parameters
  const [pxMm, setPxMm] = useState<number>(0.10);
  const [supportBufMm, setSupportBufMm] = useState<number>(0.6);
  const [connectivity, setConnectivity] = useState<4 | 8>(8);
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

  const scanEpochRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);

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

    const soup = transformedGeom.index ? transformedGeom.toNonIndexed() : transformedGeom;
    if (soup !== transformedGeom) {
      transformedGeom.dispose();
    }

    if (matrix.determinant() < 0) {
      const posAttr = soup.getAttribute('position') as THREE.BufferAttribute;
      const positions = posAttr.array as Float32Array;
      for (let i = 0; i + 8 < positions.length; i += 9) {
        for (let k = 0; k < 3; k++) {
          const tmp = positions[i + 3 + k];
          positions[i + 3 + k] = positions[i + 6 + k];
          positions[i + 6 + k] = tmp;
        }
      }
      posAttr.needsUpdate = true;
    }

    soup.computeBoundingBox();

    return soup;
  }, [geom, transform]);

  const onRunIslandScan = useCallback(async () => {
    if (!geom) return;
    const transformedGeom = prepareTransformedGeom();
    if (!transformedGeom) return;

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const epoch = ++scanEpochRef.current;

    setScanning(true);
    const transformedBBox = transformedGeom.boundingBox!.clone();
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
        (done, total, phase, phaseNumber, phaseCount) => {
          if (scanEpochRef.current !== epoch) return;
          setScanProgress({ done, total, phase, phaseNumber, phaseCount });
        },
        controller.signal,
      );
      if (scanEpochRef.current !== epoch || controller.signal.aborted) return;
      setScanData(res);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      throw err;
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      transformedGeom.dispose();
      if (scanEpochRef.current === epoch) {
        setScanning(false);
      }
    }
  }, [geom, prepareTransformedGeom, layerHeightMm, pxMm, supportBufMm, connectivity, minIslandAreaMm2, minOverlapPx, overlapNeighborhoodPx, useSurfaceContiguity]);

  const onRunScanlineScan = useCallback(async () => {
    if (!geom) return;
    const transformedGeom = prepareTransformedGeom();
    if (!transformedGeom) return;

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const epoch = ++scanEpochRef.current;

    setScanning(true);
    const transformedBBox = transformedGeom.boundingBox!.clone();
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
        (done, total, phase, phaseNumber, phaseCount) => {
          if (scanEpochRef.current !== epoch) return;
          setScanProgress({ done, total, phase, phaseNumber, phaseCount });
        },
        controller.signal,
      );
      if (scanEpochRef.current !== epoch || controller.signal.aborted) return;
      const endTime = performance.now();
      console.log(`Scanline Scan took ${(endTime - startTime).toFixed(2)}ms`);
      setScanData(res);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      throw err;
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      transformedGeom.dispose();
      if (scanEpochRef.current === epoch) {
        setScanning(false);
      }
    }
  }, [geom, prepareTransformedGeom, layerHeightMm, pxMm, supportBufMm, connectivity, minIslandAreaMm2, minOverlapPx, overlapNeighborhoodPx, useSurfaceContiguity]);

  const onRunNativeIslandScan = useCallback(async () => {
    if (!geom) return;
    const transformedGeom = prepareTransformedGeom();
    if (!transformedGeom) return;

    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    const epoch = ++scanEpochRef.current;

    setScanning(true);
    const transformedBBox = transformedGeom.boundingBox!.clone();
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
        (done: number, total: number) => {
          if (scanEpochRef.current !== epoch) return;
          setScanProgress({ done, total, phase: 'Slicing' });
        }
      );
      if (scanEpochRef.current !== epoch) return;
      const endTime = performance.now();
      console.log(`Native Island Scan took ${(endTime - startTime).toFixed(2)}ms`);
      setScanData(res);
    } finally {
      transformedGeom.dispose();
      if (scanEpochRef.current === epoch) {
        setScanning(false);
      }
    }
  }, [geom, prepareTransformedGeom, layerHeightMm, pxMm, supportBufMm, connectivity, minIslandAreaMm2, minOverlapPx, overlapNeighborhoodPx]);

  // Compute markers
  const islandMarkers = useMemo<IslandMarker[]>(() => {
    if (!scanData || !scanBBox) return [];
    const raw = computeIslandMarkers(scanData, scanBBox, layerHeightMm, overlayTaper);
    return raw.map(m => {
      const area = m.pixelCount * pxMm * pxMm;
      const radius = area > 0 ? Math.max(0.1, Math.sqrt(area / Math.PI)) : 0.1;
      return { ...m, radius, type: 0, islandId: m.id };
    });
  }, [scanData, scanBBox, layerHeightMm, overlayTaper, pxMm]);

  // Drawable form of the same set for the instanced overlay. This scan keeps
  // its islands as markers rather than contact footprints, so each island is
  // one disc at its contact point.
  const islandInstances = useMemo(
    () => buildIslandInstances(
      islandMarkers.map((m) => ({
        markerId: m.id,
        type: 0,
        centerX: m.centerX,
        centerY: m.centerY,
        baseZ: m.baseZ,
        radius: m.radius ?? 0.1,
        footprint: null,
      })),
      pxMm * VOXEL_DISC_RADIUS_FACTOR,
    ),
    [islandMarkers, pxMm],
  );

  // Clear scan data (e.g. on rotation)
  const clearScanData = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    scanEpochRef.current += 1;
    setScanData(null);
    setScanBBox(null);
    setScanning(false);
    setScanProgress(null);
    setOverlayEnabled(false);
    setVoxelEnabled(false);
    setSelectedIslandId(null);
  }, []);

  const prevInvalidationRef = useRef<{
    geometry: THREE.BufferGeometry | null;
    uuid: string;
    px: number; py: number; pz: number;
    rx: number; ry: number; rz: number;
    sx: number; sy: number; sz: number;
  } | null>(null);

  const curGeometry = geom?.geometry ?? null;
  const curUuid = curGeometry?.uuid ?? '';
  const px = transform.position.x;
  const py = transform.position.y;
  const pz = transform.position.z;
  const rx = transform.rotation.x;
  const ry = transform.rotation.y;
  const rz = transform.rotation.z;
  const sx = transform.scale.x;
  const sy = transform.scale.y;
  const sz = transform.scale.z;

  useEffect(() => {
    const next = { geometry: curGeometry, uuid: curUuid, px, py, pz, rx, ry, rz, sx, sy, sz };
    const prev = prevInvalidationRef.current;
    prevInvalidationRef.current = next;
    if (!prev) {
      return;
    }
    if (
      prev.geometry === next.geometry &&
      prev.uuid === next.uuid &&
      prev.px === next.px && prev.py === next.py && prev.pz === next.pz &&
      prev.rx === next.rx && prev.ry === next.ry && prev.rz === next.rz &&
      prev.sx === next.sx && prev.sy === next.sy && prev.sz === next.sz
    ) {
      return;
    }
    clearScanData();
  }, [curGeometry, curUuid, px, py, pz, rx, ry, rz, sx, sy, sz, clearScanData]);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
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
    islandInstances,
    onRunIslandScan,
    onRunScanlineScan,
    onRunNativeIslandScan,
    useNativeScan, setUseNativeScan,
    clearScanData
  };
}
