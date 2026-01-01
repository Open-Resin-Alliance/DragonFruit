'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import { useStlGeometry } from '@/hooks/useStlGeometry';
import { SceneCanvas } from '@/components/scene/SceneCanvas';
import { Sidebar } from '@/components/ui/Sidebar';
import { TopBar } from '@/components/layout/TopBar';
import { clearPaintToBase } from '@/components/analysis/MeshPainter';
import { LayerSlider } from '@/components/controls/LayerSlider';
import { IslandOverlayControls } from '@/components/controls/IslandOverlayControls';
import { IslandVoxelControls } from '@/components/controls/IslandVoxelControls';
import { IslandListCard } from '@/components/controls/IslandListCard';
import { TransformToolbar } from '@/components/controls/TransformToolbar';
import { TransformControls } from '@/components/controls/TransformControls';
import type { SelectionHighlightMode } from '@/components/selection';
import { SupportSidebar } from '@/supports/Settings';

import { useModelTransform } from '@/hooks/useModelTransform';
import { runIslandScan, runScanlineScan, type ScanResults } from '@/modules/island/ScanOrchestrator';
import { computeIslandMarkers, type IslandMarker } from '@/modules/island/islandOverlayLogic';
import { initializeBVH } from '@/utils/bvh';
import { useTrunkPlacementV2 } from '@/supports/SupportTypes/Trunk/useTrunkPlacement';
import { useInteractionStatus } from '@/supports/interaction/useInteractionStatus';
import { useJointCreationState, jointCreationStore } from '@/supports/SupportPrimitives/Joint/jointCreationState';
import { computeLowestZ, computeBoundsZ } from '@/utils/geometry';

import { loadFromLychee, getSelectedId, getSelectedCategory, setSelectedId, subscribe } from '@/supports/state';

// Initialize BVH acceleration globally (must be done once before any geometry is created)
if (typeof window !== 'undefined') {
  initializeBVH();
  console.log('[App] BVH acceleration initialized');
}

export default function Home() {
  const handleLoadLychee = async () => {
    try {
      const res = await fetch('/dragonfruit_supports.json');
      const data = await res.json();
      loadFromLychee(data);
      console.log('Loaded Lychee data:', data);
    } catch (e) {
      console.error('Failed to load Lychee data:', e);
    }
  };
  const renderId = useRef(0);
  renderId.current++;
  console.log(`[${new Date().toISOString()}] [Home] Render #${renderId.current} start`);
  const renderStart = performance.now();

  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [Home] Render #${renderId.current} finished. Took ${(performance.now() - renderStart).toFixed(2)}ms`);
  });

  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [layerHeightMicron, setLayerHeightMicron] = useState<number>(50);
  const [meshColor, setMeshColor] = useState<string>('#a3a3a3');
  const [crossSectionMode, setCrossSectionMode] = useState<'smooth' | 'rasterized'>('smooth');

  const geom = useStlGeometry(fileUrl);
  // Global application mode: prepare (default) or support.
  const [mode, setMode] = useState<'prepare' | 'support'>('prepare');
  // Selection highlight mode
  const [selectionHighlightMode, setSelectionHighlightMode] = useState<SelectionHighlightMode>('spotlight');

  // V2 Trunk Placement
  const trunkPlacementV2 = useTrunkPlacementV2();
  // V2 Joint Creation State
  const jointCreationState = useJointCreationState();

  // Centralized interaction status
  const { isPlacementDisabled } = useInteractionStatus();

  // Joint selection state for gizmo transformation
  const globalSelectedId = useSyncExternalStore(subscribe, getSelectedId, getSelectedId);
  const globalSelectedCategory = useSyncExternalStore(subscribe, getSelectedCategory, getSelectedCategory);
  
  // Derived: if selected item is a joint, we have a selectedJointId
  const selectedJointId = globalSelectedCategory === 'joint' ? globalSelectedId : null;

  const [scanning, setScanning] = useState<boolean>(false);
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number } | null>(null);
  const [scanData, setScanData] = useState<ScanResults | null>(null);
  const [pxMm, setPxMm] = useState<number>(0.10);
  const [supportBufMm, setSupportBufMm] = useState<number>(0.6);
  const [connectivity, setConnectivity] = useState<4 | 8>(4);
  const [minIslandAreaMm2, setMinIslandAreaMm2] = useState<number>(0.01); // Default 0.01 mm² (0.1mm x 0.1mm)
  const [scanCardExpanded, setScanCardExpanded] = useState<boolean>(true);

  // Island overlay state
  const [overlayEnabled, setOverlayEnabled] = useState<boolean>(false);
  const [overlayBrushRadius, setOverlayBrushRadius] = useState<number>(0.5);
  const [overlayColor, setOverlayColor] = useState<string>('#ff0000');
  const [overlayOpacity, setOverlayOpacity] = useState<number>(1.0);
  const [showIslandIdLabels, setShowIslandIdLabels] = useState<boolean>(false); // TEMPORARY DEBUG
  const [overlayTaper, setOverlayTaper] = useState<number>(0.60); // 0.0 = no taper, 1.0 = full taper to point (0.60 = 40% taper)

  // Island selection state
  const [selectedIslandId, setSelectedIslandId] = useState<number | null>(null);
  const [showMerged, setShowMerged] = useState<boolean>(false);

  // Island voxel visualization state
  const [voxelEnabled, setVoxelEnabled] = useState<boolean>(false);
  const [voxelColorScheme, setVoxelColorScheme] = useState<'unique' | 'lifecycle' | 'height'>('unique');
  const [voxelOpacity, setVoxelOpacity] = useState<number>(0.7);
  const [voxelShowMerged, setVoxelShowMerged] = useState<boolean>(true); // Default to true to show all islands

  // Mesh visibility state
  const [meshVisible, setMeshVisible] = useState<boolean>(true);

  // Transform state for performance optimization
  const [isTransforming, setIsTransforming] = useState<boolean>(false);
  const pendingTransformRef = useRef<{ pos: THREE.Vector3; rot: THREE.Euler; scl: THREE.Vector3 } | null>(null);

  // Lighting controls
  const [ambientIntensity, setAmbientIntensity] = useState<number>(0.6);
  const [directionalIntensity, setDirectionalIntensity] = useState<number>(0.8);
  const [materialRoughness, setMaterialRoughness] = useState<number>(0.65);

  // Transform controls
  const transformHook = useModelTransform();
  const { mode: transformMode, setMode: setTransformMode, transform, setPosition } = transformHook;

  // Auto-lift settings with localStorage persistence
  const [autoLift, setAutoLift] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = window.localStorage.getItem('autoLift');
      return saved ? JSON.parse(saved) : false;
    }
    return false;
  });
  const [liftDistance, setLiftDistance] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = window.localStorage.getItem('liftDistance');
      return saved ? parseFloat(saved) : 5;
    }
    return 5;
  });

  // Save auto-lift settings to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('autoLift', JSON.stringify(autoLift));
    }
  }, [autoLift]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('liftDistance', String(liftDistance));
    }
  }, [liftDistance]);

  // Find the actual world Z coordinate of the lowest point after ALL transforms
  const getLowestWorldZ = useCallback((): number | null => {
    if (!geom) return null;

    // Use pending transform if available (during/after drag), otherwise use state
    const currentT = pendingTransformRef.current
      ? {
        position: pendingTransformRef.current.pos,
        rotation: pendingTransformRef.current.rot,
        scale: pendingTransformRef.current.scl
      }
      : transform;

    // Get center offset
    const bbox = geom.geometry.boundingBox ?? new THREE.Box3().setFromBufferAttribute(geom.geometry.getAttribute('position') as THREE.BufferAttribute);
    const center = bbox.getCenter(new THREE.Vector3());

    // Construct the full transform matrix:
    // V_world = Pos * RotScale * Offset * V_local

    // 1. Offset matrix (centering)
    const offsetMatrix = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);

    // 2. Rotation and Scale matrix
    const rotScaleMatrix = new THREE.Matrix4();
    rotScaleMatrix.compose(
      new THREE.Vector3(0, 0, 0),
      new THREE.Quaternion().setFromEuler(currentT.rotation),
      currentT.scale
    );

    // 3. Position matrix
    const posMatrix = new THREE.Matrix4();
    posMatrix.makeTranslation(currentT.position.x, currentT.position.y, currentT.position.z);

    // Combine: final = pos * rotScale * offset
    const finalMatrix = posMatrix.multiply(rotScaleMatrix).multiply(offsetMatrix);

    // Use optimized utility to find lowest Z without cloning geometry
    const z = computeLowestZ(geom.geometry, finalMatrix);
    console.log('[getLowestWorldZ] Computed lowest Z:', z);
    return z;
  }, [geom, transform]);

  // Auto-snap when lift distance changes (if auto-snap is enabled)
  // Note: Don't include transformHook in dependencies to avoid infinite loop
  useEffect(() => {
    const lowestWorldZ = getLowestWorldZ();
    if (lowestWorldZ !== null && transformHook.autoSnapEnabled) {
      if (autoLift) {
        transformHook.snapToLift(lowestWorldZ, liftDistance);
      } else {
        transformHook.snapToPlatform(lowestWorldZ);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liftDistance, autoLift]);

  // Initialize transform position when geometry loads
  // Geometry is centered at its center of mass, so we need to offset Z to place bottom at Z=0
  useEffect(() => {
    if (geom?.bbox) {
      const bbox = geom.bbox;
      const center = bbox.getCenter(new THREE.Vector3());
      // Geometry is centered, so we need to lift it by half its height to place bottom at Z=0
      const heightOffset = center.z - bbox.min.z;

      // Apply auto-lift if enabled
      const finalZ = autoLift ? heightOffset + liftDistance : heightOffset;
      setPosition(0, 0, finalZ);
    }
  }, [geom, setPosition, autoLift, liftDistance]);

  const isValidHex = useCallback((s: string) => /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s), []);
  useEffect(() => {
    try {
      const saved = typeof window !== 'undefined' ? window.localStorage.getItem('meshColor') : null;
      if (saved && isValidHex(saved)) setMeshColor(saved);
    } catch { }
  }, [isValidHex]);
  useEffect(() => {
    try {
      if (isValidHex(meshColor)) window.localStorage.setItem('meshColor', meshColor);
    } catch { }
  }, [meshColor, isValidHex]);

  // Scene-space Z range: compute actual world-space bounds after transforms
  // min: always 0 (grid base)
  // max: highest vertex in world space after all transforms applied
  const zRange = useMemo(() => {
    if (!geom?.bbox) return { min: 0, max: 0 };

    // During transformation, use fast approximation to avoid expensive calculations
    if (isTransforming) {
      const originalHeight = geom.bbox.max.z - geom.bbox.min.z;
      const maxScale = Math.max(transform.scale.x, transform.scale.y, transform.scale.z);
      return { min: 0, max: originalHeight * maxScale * 1.5 };
    }

    // Clone geometry and apply same transforms as rendered mesh
    // OPTIMIZED: Use computeBoundsZ to avoid cloning geometry

    // Get center offset
    const bbox = geom.geometry.boundingBox ?? new THREE.Box3().setFromBufferAttribute(geom.geometry.getAttribute('position') as THREE.BufferAttribute);
    const center = bbox.getCenter(new THREE.Vector3());

    // Construct the full transform matrix:
    // V_world = Pos * RotScale * Offset * V_local

    // 1. Offset matrix (centering)
    const offsetMatrix = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);

    // 2. Rotation and Scale matrix
    const rotScaleMatrix = new THREE.Matrix4();
    rotScaleMatrix.compose(
      new THREE.Vector3(0, 0, 0),
      new THREE.Quaternion().setFromEuler(
        new THREE.Euler(transform.rotation.x, transform.rotation.y, transform.rotation.z)
      ),
      new THREE.Vector3(transform.scale.x, transform.scale.y, transform.scale.z)
    );

    // 3. Position matrix
    const posMatrix = new THREE.Matrix4();
    posMatrix.makeTranslation(transform.position.x, transform.position.y, transform.position.z);

    // Combine: final = pos * rotScale * offset
    const finalMatrix = posMatrix.multiply(rotScaleMatrix).multiply(offsetMatrix);

    console.time('zRange_computeBoundsZ');
    const { min, max } = computeBoundsZ(geom.geometry, finalMatrix);
    console.timeEnd('zRange_computeBoundsZ');

    // Return range from grid base (0) to highest point in world space
    // The original logic seemed to imply min is always 0 for the slider range?
    // "min: always 0 (grid base)"
    // "max: highest vertex in world space"
    // So we return { min: 0, max: max }
    return { min: 0, max: max };
  }, [
    geom,
    isTransforming,
    transform.position.x, transform.position.y, transform.position.z,
    transform.rotation.x, transform.rotation.y, transform.rotation.z,
    transform.scale.x, transform.scale.y, transform.scale.z
  ]);

  // Slider controls LAYER INDEX: 0 = home (no clipping), 1..numLayers = visible single layer band
  const [layerIndex, setLayerIndex] = useState<number>(0);
  useEffect(() => {
    if (geom) setLayerIndex(0);
  }, [geom]);

  const layerHeightMm = useMemo(() => layerHeightMicron / 1000, [layerHeightMicron]);

  // Initialize/refresh base vertex colors whenever geometry or base color changes
  useEffect(() => {
    if (!geom) return;
    const base = new THREE.Color(meshColor);
    clearPaintToBase(geom.geometry, base);
  }, [geom, meshColor]);


  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    setFileUrl(url);
    setFileName(f.name);
  }, []);

  const onSliderChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setLayerIndex(parseInt(e.target.value, 10) || 0);
  }, []);
  const heightMm = useMemo(() => (geom ? zRange.max - zRange.min : 0), [geom, zRange]);
  const numLayers = useMemo(() => (heightMm > 0 && layerHeightMm > 0 ? Math.ceil(heightMm / layerHeightMm) : 0), [heightMm, layerHeightMm]);

  // Calculate polygon count (triangles)
  const polygonCount = useMemo(() => {
    if (!geom?.geometry) return 0;
    const positionAttr = geom.geometry.getAttribute('position');
    if (!positionAttr) return 0;
    return positionAttr.count / 3; // 3 vertices per triangle
  }, [geom]);
  // Compute clipping: show everything from bottom (0) up to current layer
  const clipLower = useMemo(() => {
    // No lower clip - show from bottom
    return null;
  }, []);
  const clipUpper = useMemo(() => {
    if (!geom || layerIndex === 0) return null;
    const EPS = 1e-6;
    const upper = layerIndex * layerHeightMm + EPS;
    return Math.min(Math.max(upper, zRange.min), zRange.max + EPS);
  }, [geom, layerIndex, zRange, layerHeightMm]);

  // Worker setup for island scanning
  // No overlay logic; scan orchestrated via module on demand.

  // Store transformed bbox for island marker computation
  const [scanBBox, setScanBBox] = useState<THREE.Box3 | null>(null);

  const onRunIslandScan = useCallback(async () => {
    if (!geom) return;
    const layerHeightMm = layerHeightMicron / 1000;
    setScanning(true);

    // Clone and transform geometry to scan in world space (global Z-axis)
    // Must apply the same transforms as the rendered mesh: centerOffset, then transform
    const transformedGeom = geom.geometry.clone();

    // Get center offset (same as in SceneCanvas)
    const bbox = geom.geometry.boundingBox ?? new THREE.Box3().setFromBufferAttribute(
      geom.geometry.getAttribute('position') as THREE.BufferAttribute
    );
    const centerOffset = bbox.getCenter(new THREE.Vector3());

    // Apply center offset (negate to move geometry)
    transformedGeom.translate(-centerOffset.x, -centerOffset.y, -centerOffset.z);

    // Apply transform matrix
    const quaternion = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(transform.rotation.x, transform.rotation.y, transform.rotation.z)
    );
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(transform.position.x, transform.position.y, transform.position.z),
      quaternion,
      new THREE.Vector3(transform.scale.x, transform.scale.y, transform.scale.z)
    );
    transformedGeom.applyMatrix4(matrix);
    transformedGeom.computeBoundingBox();
    const transformedBBox = transformedGeom.boundingBox!;
    setScanBBox(transformedBBox);

    setScanProgress({ done: 0, total: Math.max(0, Math.ceil((transformedBBox.max.z - transformedBBox.min.z) / layerHeightMm)) });
    try {
      const res = await runIslandScan(
        { geometry: transformedGeom, bbox: transformedBBox },
        layerHeightMm,
        { px_mm: pxMm, support_buffer_mm: supportBufMm, connectivity, min_island_area_mm2: minIslandAreaMm2 },
        (done, total) => {
          setScanProgress({ done, total });
        }
      );
      setScanData(res);
    } finally {
      setScanning(false);
    }
  }, [geom, layerHeightMicron, pxMm, supportBufMm, connectivity, minIslandAreaMm2, transform]);

  const onRunScanlineScan = useCallback(async () => {
    if (!geom) return;
    const layerHeightMm = layerHeightMicron / 1000;
    setScanning(true);

    // Clone and transform geometry to scan in world space (global Z-axis)
    // Must apply the same transforms as the rendered mesh: centerOffset, then transform
    const transformedGeom = geom.geometry.clone();

    // Get center offset (same as in SceneCanvas)
    const bbox = geom.geometry.boundingBox ?? new THREE.Box3().setFromBufferAttribute(
      geom.geometry.getAttribute('position') as THREE.BufferAttribute
    );
    const centerOffset = bbox.getCenter(new THREE.Vector3());

    // Apply center offset (negate to move geometry)
    transformedGeom.translate(-centerOffset.x, -centerOffset.y, -centerOffset.z);

    // Apply transform matrix
    const quaternion = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(transform.rotation.x, transform.rotation.y, transform.rotation.z)
    );
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(transform.position.x, transform.position.y, transform.position.z),
      quaternion,
      new THREE.Vector3(transform.scale.x, transform.scale.y, transform.scale.z)
    );
    transformedGeom.applyMatrix4(matrix);
    transformedGeom.computeBoundingBox();
    const transformedBBox = transformedGeom.boundingBox!;
    setScanBBox(transformedBBox);

    setScanProgress({ done: 0, total: Math.max(0, Math.ceil((transformedBBox.max.z - transformedBBox.min.z) / layerHeightMm)) });

    const startTime = performance.now();
    try {
      const res = await runScanlineScan(
        { geometry: transformedGeom, bbox: transformedBBox },
        layerHeightMm,
        { px_mm: pxMm, support_buffer_mm: supportBufMm, connectivity, min_island_area_mm2: minIslandAreaMm2 },
        (done, total) => {
          setScanProgress({ done, total });
        }
      );
      const endTime = performance.now();
      console.log(`Scanline Scan took ${(endTime - startTime).toFixed(2)}ms`);
      setScanData(res);
    } finally {
      setScanning(false);
    }
  }, [geom, layerHeightMicron, pxMm, supportBufMm, connectivity, minIslandAreaMm2, transform]);

  // Compute island markers using the transformed bbox
  const islandMarkers = useMemo<IslandMarker[]>(() => {
    if (!scanData || !scanBBox) return [];
    return computeIslandMarkers(scanData, scanBBox, layerHeightMm, overlayTaper);
  }, [scanData, scanBBox, layerHeightMm, overlayTaper]);

  const totalIslandCount = useMemo(() => islandMarkers.length, [islandMarkers]);

  // Unified handlers
  const onSupportHover = useCallback((hit: THREE.Intersection | null) => {
    // Don't show support previews if placement is disabled (e.g. Gizmo active)
    if (isPlacementDisabled) {
      // Note: trunkPlacementV2 handles its own disabled state internally via useInteractionStatus
      return;
    }

    if (jointCreationState.isActive) {
        // V2 Joint Creation handles its own hover via useFrame in Canvas
        return;
    }

    // Normal trunk mode: show trunk preview
    trunkPlacementV2.onSupportHover(hit);
  }, [isPlacementDisabled, trunkPlacementV2, jointCreationState.isActive]);

  const onSupportClick = useCallback((hit: THREE.Intersection) => {
    if (jointCreationState.isActive) {
        // V2 Joint Creation handles clicks internally via global capture
        return;
    }

    trunkPlacementV2.onSupportClick(hit);
  }, [trunkPlacementV2, jointCreationState.isActive]);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-neutral-950 text-neutral-100">
      <TopBar
        onFileChange={onFileChange}
        fileName={fileName}
        layerHeightMicron={layerHeightMicron}
        onLayerHeightChange={setLayerHeightMicron}
        layerHeightMm={layerHeightMm}
        meshColor={meshColor}
        onMeshColorChange={setMeshColor}
        ambientIntensity={ambientIntensity}
        onAmbientIntensityChange={setAmbientIntensity}
        directionalIntensity={directionalIntensity}
        onDirectionalIntensityChange={setDirectionalIntensity}
        materialRoughness={materialRoughness}
        onMaterialRoughnessChange={setMaterialRoughness}
        meshVisible={meshVisible}
        onMeshVisibleChange={setMeshVisible}
        mode={mode}
        onModeChange={setMode}
        selectionHighlightMode={selectionHighlightMode}
        onSelectionHighlightModeChange={setSelectionHighlightMode}
      />
      <Sidebar>

        {mode === 'prepare' ? (
          <>
            <div className="bg-neutral-800 rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setScanCardExpanded(!scanCardExpanded)}
                    className="p-0.5 hover:bg-neutral-700 rounded transition-colors"
                    title={scanCardExpanded ? 'Collapse card' : 'Expand card'}
                  >
                    <svg
                      className={`w-4 h-4 ${scanCardExpanded ? 'text-blue-500' : 'text-neutral-500'}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                  </button>
                  <h3 className="text-sm font-semibold text-neutral-200">Island Scan</h3>
                </div>
                <button
                  type="button"
                  onClick={onRunIslandScan}
                  disabled={!geom || scanning}
                  className="px-3 py-1 text-xs rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-200 disabled:opacity-50 transition-colors"
                >
                  {scanning ? 'Scanning…' : 'Scan'}
                </button>
                <button
                  type="button"
                  onClick={onRunScanlineScan}
                  disabled={!geom || scanning}
                  className="flex-1 bg-purple-600 hover:bg-purple-500 disabled:bg-gray-600 text-white px-4 py-2 rounded font-medium transition-colors"
                  title="Run optimized scanline rasterization"
                >
                  {scanning ? '...' : 'Scanline'}
                </button>
              </div>
              
              <div className="pt-2 border-t border-neutral-700">
                 <button
                   onClick={handleLoadLychee}
                   className="w-full bg-green-600 hover:bg-green-500 text-white px-3 py-2 rounded text-sm font-medium transition-colors"
                 >
                   Load LYS Data (V2)
                 </button>
              </div>

              {scanProgress && (
                <div className="text-xs text-neutral-400">
                  {scanProgress.done} / {scanProgress.total} layers scanned
                  {scanData && scanData.islands.length > 0 && (
                    <span> - {scanData.islands.length} island{scanData.islands.length !== 1 ? 's' : ''}</span>
                  )}
                </div>
              )}

              {scanCardExpanded && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-neutral-400">Pixel size (mm)</label>
                      <input
                        type="text"
                        defaultValue={pxMm}
                        key={pxMm}
                        onBlur={(e) => {
                          const val = e.target.value.trim();
                          if (val === '' || val === '.' || val === '0' || val === '0.') {
                            setPxMm(0.10);
                            e.target.value = '0.10';
                          } else {
                            const num = parseFloat(val);
                            if (!isNaN(num) && num >= 0.01 && num <= 0.5) {
                              setPxMm(num);
                            } else {
                              setPxMm(0.10);
                              e.target.value = '0.10';
                            }
                          }
                        }}
                        className="w-full rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-sm text-neutral-100"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-neutral-400">Support buffer (mm)</label>
                      <input
                        type="text"
                        defaultValue={supportBufMm}
                        key={supportBufMm}
                        onBlur={(e) => {
                          const val = e.target.value.trim();
                          if (val === '' || val === '.' || val === '0' || val === '0.') {
                            setSupportBufMm(0.6);
                            e.target.value = '0.6';
                          } else {
                            const num = parseFloat(val);
                            if (!isNaN(num) && num >= 0 && num <= 2) {
                              setSupportBufMm(num);
                            } else {
                              setSupportBufMm(0.6);
                              e.target.value = '0.6';
                            }
                          }
                        }}
                        className="w-full rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-sm text-neutral-100"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-neutral-400">Connectivity</label>
                      <select
                        value={String(connectivity)}
                        onChange={(e) => setConnectivity((parseInt(e.target.value, 10) === 8 ? 8 : 4))}
                        className="w-full rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-sm text-neutral-100"
                      >
                        <option value="4">4</option>
                        <option value="8">8</option>
                      </select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-neutral-400">Min island area (mm²)</label>
                      <input
                        type="number"
                        min="0.001"
                        max="10"
                        step="0.01"
                        value={minIslandAreaMm2}
                        onChange={(e) => {
                          const num = parseFloat(e.target.value);
                          if (!isNaN(num) && num >= 0.001 && num <= 10) {
                            setMinIslandAreaMm2(num);
                          }
                        }}
                        className="w-full rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-sm text-neutral-100"
                      />
                    </div>
                  </div>
                </>
              )}
            </div>

            <IslandListCard
              scanData={scanData}
              selectedIslandId={selectedIslandId}
              onSelectIsland={setSelectedIslandId}
              onDeleteIsland={(id) => console.log('Delete island', id)}
              showMerged={showMerged}
              onToggleMerged={setShowMerged}
            />

            <IslandOverlayControls
              enabled={overlayEnabled}
              onToggle={setOverlayEnabled}
              brushRadius={overlayBrushRadius}
              onBrushRadiusChange={setOverlayBrushRadius}
              color={overlayColor}
              onColorChange={setOverlayColor}
              opacity={overlayOpacity}
              onOpacityChange={setOverlayOpacity}
              showLabels={showIslandIdLabels}
              onToggleLabels={setShowIslandIdLabels}
              taper={overlayTaper}
              onTaperChange={setOverlayTaper}
            />

            <IslandVoxelControls
              enabled={voxelEnabled}
              onToggle={setVoxelEnabled}
              opacity={voxelOpacity}
              onOpacityChange={setVoxelOpacity}
              colorScheme={voxelColorScheme}
              onColorSchemeChange={setVoxelColorScheme}
              showMerged={voxelShowMerged}
              onToggleShowMerged={setVoxelShowMerged}
            />
          </>
        ) : (
          <SupportSidebar />
        )}
      </Sidebar>

      <div className="flex-1 relative h-full w-full">
        <SceneCanvas
          geom={geom}
          clipLower={clipLower}
          clipUpper={clipUpper}
          meshColor={meshColor}
          meshVisible={meshVisible}
          disableRaycast={isTransforming}
          hideCrossSectionCap={false}
          onCameraChange={() => {
            /* Optional: debounce or logic */
          }}
          onCameraEnd={() => {
            /* Optional: camera settle logic */
          }}
          islandMarkers={overlayEnabled ? islandMarkers : []}
          overlayBrushRadius={overlayBrushRadius}
          overlayColor={overlayColor}
          overlayOpacity={overlayOpacity}
          overlaySelectedIslandId={selectedIslandId}
          ambientIntensity={ambientIntensity}
          directionalIntensity={directionalIntensity}
          materialRoughness={materialRoughness}
          scanResults={scanData}
          layerHeightMm={layerHeightMm}
          scanBBox={scanBBox}
          showIslandIdLabels={showIslandIdLabels}
          voxelEnabled={voxelEnabled}
          voxelColorScheme={voxelColorScheme}
          voxelSelectedIslandId={selectedIslandId}
          voxelShowMerged={voxelShowMerged}
          voxelOpacity={voxelOpacity}
          transformMode={transformMode}
          transform={transform}
          onTransformChange={(pos, rot, scl) => {
            // Store in ref to avoid React re-renders during transformation
            pendingTransformRef.current = { pos, rot, scl };

            // Update transform state immediately for gizmo positioning
            transformHook.setPosition(pos.x, pos.y, pos.z);
            transformHook.setRotation(rot.x, rot.y, rot.z);
            transformHook.setScale(scl.x, scl.y, scl.z);
          }}
          onTransformEnd={(mode) => {
            // Mark transformation as complete immediately for UI responsiveness
            setIsTransforming(false);

            // When rotation widget is released, clear scan data (rotation invalidates slicing)
            if (mode === 'rotate') {
              console.log('[Rotation] Clearing scan data - rotation invalidates island detection');
              setScanData(null);
              setOverlayEnabled(false);
              setVoxelEnabled(false);
              setSelectedIslandId(null);

              // Defer expensive operations to avoid blocking pointer release
              setTimeout(() => {
                // Auto-snap if enabled
                if (transformHook.autoSnapEnabled) {
                  const lowestWorldZ = getLowestWorldZ();
                  if (lowestWorldZ !== null) {
                    console.log('[Auto-Snap] Lowest World Z:', {
                      lowestWorldZ,
                      autoLift,
                      liftDistance
                    });
                    if (autoLift) {
                      transformHook.snapToLift(lowestWorldZ, liftDistance);
                    } else {
                      transformHook.snapToPlatform(lowestWorldZ);
                    }
                  }
                }
                // Clear pending transform after we've used it for the snap calculation
                pendingTransformRef.current = null;
              }, 0);
            } else {
              pendingTransformRef.current = null;
            }
          }}
          mode={mode}
          onSupportClick={onSupportClick}
          onSupportHover={onSupportHover}
          trunkPlacementPreview={trunkPlacementV2.previewData}
          blockSupportPlacement={isPlacementDisabled}
          gpuPickingTest={false}
          selectionHighlightMode={selectionHighlightMode}
        />

        {/* Transform Toolbar */}
        {geom && mode === 'prepare' && (
          <>
            <TransformToolbar mode={transformMode} onModeChange={setTransformMode} />

            {/* Transform Controls Panel */}
            {transformMode === 'transform' && (
              <TransformControls
                position={transform.position}
                onPositionChange={transformHook.setPosition}
                onCenter={transformHook.centerXY}
                onPlatform={transformHook.setPlatformZ}
                rotation={transform.rotation}
                onRotationChange={transformHook.setRotation}
                onResetRotation={transformHook.resetRotation}
                onRotationComplete={() => {
                  setScanData(null);
                  setOverlayEnabled(false);
                  setVoxelEnabled(false);
                  setSelectedIslandId(null);
                  setTimeout(() => {
                    if (transformHook.autoSnapEnabled) {
                      const lowestWorldZ = getLowestWorldZ();
                      if (lowestWorldZ !== null) {
                        if (autoLift) {
                          transformHook.snapToLift(lowestWorldZ, liftDistance);
                        } else {
                          transformHook.snapToPlatform(lowestWorldZ);
                        }
                      }
                    }
                  }, 0);
                }}
                scale={transform.scale}
                onScaleChange={transformHook.setScale}
                onResetScale={transformHook.resetScale}
                modelBBox={geom.bbox}
                autoLift={autoLift}
                onAutoLiftChange={setAutoLift}
                liftDistance={liftDistance}
                onLiftDistanceChange={setLiftDistance}
                onLift={() => {
                  const lowestWorldZ = getLowestWorldZ();
                  if (lowestWorldZ !== null) transformHook.snapToLift(lowestWorldZ, liftDistance);
                }}
                onDrop={() => {
                  const lowestWorldZ = getLowestWorldZ();
                  if (lowestWorldZ !== null) transformHook.snapToPlatform(lowestWorldZ);
                }}
              />
            )}
          </>
        )}
        {/* Model Info Overlay Card */}
        <div className="absolute bottom-4 left-4 bg-neutral-900/90 border border-neutral-700 rounded-lg px-4 py-3 shadow-lg">
          <div className="space-y-1 text-xs text-neutral-300">
            <div>Model loaded: <span className="text-neutral-100">{geom ? 'Yes' : 'No'}</span></div>
            <div>Polygons: <span className="text-neutral-100">{geom ? polygonCount.toLocaleString() : '-'}</span></div>
            <div>Height (mm): <span className="text-neutral-100">{geom ? heightMm.toFixed(3) : '-'}</span></div>
            <div>Layer count: <span className="text-neutral-100">{geom ? numLayers : '-'}</span></div>
            <div>Layer index: <span className="text-neutral-100">{geom ? layerIndex : '-'}</span> {layerIndex === 0 && <span className="text-neutral-400">(home)</span>}</div>
            <div>Visible up to (mm): <span className="text-neutral-100">{geom && layerIndex > 0 ? `${(clipUpper ?? 0).toFixed(3)}` : 'full'}</span></div>
            <div>Islands (this layer): <span className="text-neutral-100">{scanData && layerIndex > 0 && layerIndex <= (scanData?.layers.length ?? 0) ? scanData.layers[layerIndex - 1].islandCount : '-'}</span></div>
            <div>Islands (total): <span className="text-neutral-100">{scanData ? scanData.layers.reduce((a, l) => a + l.islandCount, 0) : '-'}</span></div>
          </div>
        </div>
        {geom && (
          <LayerSlider
            min={0}
            max={numLayers}
            step={1}
            value={layerIndex}
            onChange={(v) => setLayerIndex(Math.round(v))}
            showValue={true}
            onToggleMode={() => setCrossSectionMode(prev => prev === 'smooth' ? 'rasterized' : 'smooth')}
            crossSectionMode={crossSectionMode}
          />
        )}
      </div>

    </div>
  );
}
