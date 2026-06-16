import { useState, useCallback, useMemo, useEffect } from 'react';
import * as THREE from 'three';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import { quaternionFromGlobalEuler } from '@/utils/rotation';
import { detectVoxelIslands, type VoxelDetectParams } from './detect';
import {
  annotateFilterFlags,
  applyFilter,
  DEFAULT_FILTER_TOGGLES,
  type IslandFilterToggles,
} from './filtering';
import { clusterWalkOrder } from './ordering';
import { buildIslandPucks, markerIdFor } from './islandPuckMarkers';
import { scanMeshMinima } from './meshMinima';
import { type DetectedIsland, SUPPORTED_RADIUS_MM } from './types';
import { classifyIntersection } from './intersection';

/**
 * Page-scope state hook for the unified Islands panel (PoC). Tab-agnostic and
 * free of any `src/supports/*` coupling — support-tip positions are injected.
 *
 * SWITCH-BACK NOTE (Analysis-tab reintegration): this is a fresh, mm-space,
 * true-world replacement for `IslandScan/useIslandManager`. If the Analysis tab
 * returns and you reunify, the field map is:
 *   scanning / scanProgress  ↔ useIslandManager.scanning / scanProgress
 *   onRunVoxelScan()         ↔ useIslandManager.onRunIslandScan / onRunNativeIslandScan
 *   pxMm / supportBufMm      ↔ useIslandManager.pxMm / supportBufMm
 *   voxelIslands             ↔ useIslandManager.scanData.islands
 *                              (here: *contact-region* islands in world mm, not the flooded body)
 * KEY DIFFERENCE: the legacy hook scans in a centred frame and offsets the
 * visual via getScanVisualPosition(); THIS hook emits true world-space markers,
 * so its IslandOverlay layers are mounted with NO transform (identity group).
 */

export interface UseIslandsInput {
  geom: GeometryWithBounds | null;
  transform: { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 };
  layerHeightMm: number;
  /** Injected existing support-tip world positions (no src/supports coupling here). */
  supportTips: THREE.Vector3[];
  /** Build-plate plane Z (world mm). */
  plateZ?: number;
  /** File path of the loaded model. */
  sourcePath?: string | null;
  /** Active mode / tab. */
  activeTab?: string;
}

export type UseIslandsReturn = ReturnType<typeof useIslands>;

export function useIslands({ geom, transform, layerHeightMm, supportTips, plateZ = 0, sourcePath, activeTab }: UseIslandsInput) {
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number } | null>(null);
  const [voxelIslands, setVoxelIslands] = useState<DetectedIsland[]>([]);
  const [minimaIslands, setMinimaIslands] = useState<DetectedIsland[]>([]);
  
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    if (!scanning) {
      setElapsedSec(0);
      return;
    }
    const startedAt = Date.now();
    const id = window.setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 250);
    return () => window.clearInterval(id);
  }, [scanning]);

  const elapsedLabel = useMemo(() => {
    const total = Math.max(0, elapsedSec);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }, [elapsedSec]);

  // (Part C) intersection classification across voxel + minima.

  // Scan params (surfaced in the advanced modal).
  const [pxMm, setPxMm] = useState(0.05);
  const [supportBufMm, setSupportBufMm] = useState(0.25);
  const [connectivity, setConnectivity] = useState<4 | 8>(4);

  // Voxel consolidation & smart intersection states
  const [consolidateVoxel, setConsolidateVoxel] = useState<boolean>(true);
  const [consolidationDistance, setConsolidationDistance] = useState<number>(0.2);
  const [reduceIntersection, setReduceIntersection] = useState<boolean>(false);
  const [intersectionThreshold, setIntersectionThreshold] = useState<number>(0.5);
  const [enableVolumeGlow, setEnableVolumeGlow] = useState<boolean>(true);
  const [scaleMarkersWithArea, setScaleMarkersWithArea] = useState<boolean>(true);
  const [enableContourRegions, setEnableContourRegions] = useState<boolean>(true);
  const [maxContourRegions, setMaxContourRegions] = useState<number>(20);
  const [removeSupportedAreaClusters, setRemoveSupportedAreaClusters] = useState<boolean>(false);
  const [areaPerSupport, setAreaPerSupport] = useState<number>(4.0);

  // Filter toggles — default ON ⇒ supported/grounded islands hidden (and skipped by ←/→).
  const [filterToggles, setFilterToggles] = useState<IslandFilterToggles>(DEFAULT_FILTER_TOGGLES);

  // Overlay visibility (blue voxel + green minima; Part C adds red intersection / exclusions).
  const [showVoxelOnly, setShowVoxelOnly] = useState(true);
  const [showMinimaOnly, setShowMinimaOnly] = useState(true);
  const [showIntersection, setShowIntersection] = useState(true);

  const [selectedMarkerId, setSelectedMarkerId] = useState<number | null>(null);

  /**
   * Build TRUE world-space (build-plate Z-up) triangle-soup positions + bbox.
   * Replicates StlMesh's placement — group(transform) ∘ translate(-bboxCenter) —
   * so islands land exactly where the model renders. Inlined (not imported from
   * useIslandManager) to keep this hook self-contained / portable.
   */
  const prepareWorldGeom = useCallback((): { positions: Float32Array; bbox: THREE.Box3 } | null => {
    if (!geom) return null;
    const g = geom.geometry.clone();
    const bb =
      g.boundingBox ??
      new THREE.Box3().setFromBufferAttribute(g.getAttribute('position') as THREE.BufferAttribute);
    const center = bb.getCenter(new THREE.Vector3());
    g.translate(-center.x, -center.y, -center.z);
    const matrix = new THREE.Matrix4().compose(
      transform.position.clone(),
      quaternionFromGlobalEuler(transform.rotation),
      transform.scale.clone(),
    );
    g.applyMatrix4(matrix);
    const soup = g.index ? g.toNonIndexed() : g;
    soup.computeBoundingBox();
    const positions = soup.getAttribute('position').array as Float32Array;
    return { positions, bbox: soup.boundingBox! };
  }, [geom, transform]);

  /**
   * Run BOTH detectors on the same world-space positions (one shared transform →
   * one frame → directly comparable for Part C). Voxel uses the scanline worker
   * pool; minima is a single Rust IPC call. A minima failure (e.g. non-Tauri
   * context) is non-fatal — voxel results still stand.
   */
  const onRunScan = useCallback(async () => {
    setScanning(true);
    let usedSideload = false;

    if (sourcePath && geom) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');

        if (!geom.geometry.boundingBox) {
          geom.geometry.computeBoundingBox();
        }
        const bb = geom.geometry.boundingBox!;
        const center = bb.getCenter(new THREE.Vector3());

        const matrix = new THREE.Matrix4().compose(
          transform.position.clone(),
          quaternionFromGlobalEuler(transform.rotation),
          transform.scale.clone(),
        );

        const matrixElements = Array.from(matrix.elements);
        const centerCoords = [center.x, center.y, center.z];

        setScanProgress({ done: 0, total: 100 });

        console.log(`[Islands] Sideloading voxel scan from path: ${sourcePath}`);
        const voxelRaw = await invoke<any[]>('scan_voxel_islands_from_path', {
          filePath: sourcePath,
          matrix: matrixElements,
          center: centerCoords,
          layerHeightMm,
          pxMm,
          supportBufferMm: supportBufMm,
          connectivity,
        });

        const voxelMapped: DetectedIsland[] = voxelRaw.map((v) => ({
          id: v.id,
          source: 'voxel',
          contact: new THREE.Vector3(v.contact.x, v.contact.y, v.contact.z),
          baseZ: v.baseZ,
          areaMm2: v.areaMm2,
          layerSpan: v.layerSpan,
        }));
        setVoxelIslands(voxelMapped);

        console.log(`[Islands] Sideloading minima scan from path: ${sourcePath}`);
        const minimaRaw = await invoke<any[]>('scan_mesh_minima_from_path', {
          filePath: sourcePath,
          matrix: matrixElements,
          center: centerCoords,
        });

        const minimaMapped: DetectedIsland[] = minimaRaw.map((m, i) => ({
          id: `m${i}`,
          source: 'minima',
          contact: new THREE.Vector3(m.position.x, m.position.y, m.position.z),
          baseZ: m.position.z,
          vertexIndex: m.vertexIndex,
          seedTriangleId: m.seedTriangleId,
        }));
        setMinimaIslands(minimaMapped);

        usedSideload = true;
      } catch (err) {
        console.warn('[Islands] Sideloaded Rust scan failed, falling back to client-side...', err);
      }
    }

    if (!usedSideload) {
      const world = prepareWorldGeom();
      if (!world) {
        setScanning(false);
        return;
      }
      setScanProgress({
        done: 0,
        total: Math.max(1, Math.ceil((world.bbox.max.z - world.bbox.min.z) / layerHeightMm)),
      });
      try {
        const params: VoxelDetectParams = {
          pxMm,
          supportBufferMm: supportBufMm,
          connectivity,
        };
        const voxel = await detectVoxelIslands(world, layerHeightMm, params, (done, total) =>
          setScanProgress({ done, total }),
        );
        setVoxelIslands(voxel);

        try {
          const minima = await scanMeshMinima(world.positions);
          setMinimaIslands(minima);
        } catch (err) {
          console.error('[Islands] mesh-minima scan failed', err);
          setMinimaIslands([]);
        }
      } finally {
        setScanning(false);
      }
    } else {
      setScanning(false);
    }
  }, [geom, transform, sourcePath, prepareWorldGeom, layerHeightMm, pxMm, supportBufMm, connectivity]);

  // Helper to group adjacent voxel islands into consolidated "suspended areas"
  const consolidatedVoxels = useMemo(() => {
    if (!consolidateVoxel) return voxelIslands;
    return consolidateVoxelIslands(voxelIslands, consolidationDistance, pxMm);
  }, [voxelIslands, consolidateVoxel, consolidationDistance, pxMm]);

  // Voxel + mesh-minima, unified. (Part C) adds intersection classification here.
  const classifiedResult = useMemo(() => {
    return classifyIntersection(consolidatedVoxels, minimaIslands, {
      xyToleranceMm: 0.5,
      zBandMm: layerHeightMm,
    });
  }, [consolidatedVoxels, minimaIslands, layerHeightMm]);

  const allIslands = classifiedResult.islands;
  const stats = classifiedResult.stats;

  const tableStats = useMemo(() => {
    const annotated = annotateFilterFlags(allIslands.map((i) => ({ ...i })), { supportTips, plateZ });
    
    const voxelTotal = annotated.filter(i => i.class === 'voxelOnly' && i.source === 'voxel').length;
    const voxelUnsupported = annotated.filter(i => i.class === 'voxelOnly' && i.source === 'voxel' && !i.supported && !i.grounded).length;
    
    const geomTotal = annotated.filter(i => i.class === 'minimaOnly' && i.source === 'minima').length;
    const geomUnsupported = annotated.filter(i => i.class === 'minimaOnly' && i.source === 'minima' && !i.supported && !i.grounded).length;
    
    const coincidentTotal = annotated.filter(i => i.class === 'intersection' && i.source === 'voxel').length;
    const coincidentUnsupported = annotated.filter(i => i.class === 'intersection' && i.source === 'voxel' && !i.supported && !i.grounded).length;
    
    const allTotal = voxelTotal + geomTotal + coincidentTotal;
    const allUnsupported = voxelUnsupported + geomUnsupported + coincidentUnsupported;
    
    return {
      voxelTotal,
      voxelUnsupported,
      geomTotal,
      geomUnsupported,
      coincidentTotal,
      coincidentUnsupported,
      allTotal,
      allUnsupported,
    };
  }, [allIslands, supportTips, plateZ]);

  // Annotate supported/grounded flags, then apply the visibility toggles. Work on
  // shallow copies so React state objects aren't mutated (contact Vector3 is shared, never mutated).
  const annotatedIslands = useMemo(() => {
    const annotated = annotateFilterFlags(allIslands.map((i) => ({ ...i })), { supportTips, plateZ });

    // Count actual support tips within the island's contact region to check if it's fully supported
    const radiusSq = SUPPORTED_RADIUS_MM * SUPPORTED_RADIUS_MM;
    for (const island of annotated) {
      const area = island.areaMm2 ?? 0;

      let supportCount = 0;
      for (const tip of supportTips) {
        const dz = Math.abs(tip.z - island.contact.z);
        if (dz > 0.5) continue; // limit vertical check to 0.5 mm

        let isNear = false;
        if (island.contactVoxels && island.contactVoxels.length > 0) {
          for (const vox of island.contactVoxels) {
            const dx = tip.x - vox.x;
            const dy = tip.y - vox.y;
            if (dx * dx + dy * dy <= radiusSq) {
              isNear = true;
              break;
            }
          }
        } else {
          const dx = tip.x - island.contact.x;
          const dy = tip.y - island.contact.y;
          if (dx * dx + dy * dy <= radiusSq) {
            isNear = true;
          }
        }

        if (isNear) {
          supportCount++;
        }
      }

      island.supportCount = supportCount;
      const requiredSupports = Math.max(1, Math.ceil(area / areaPerSupport));
      island.fullySupported = supportCount >= requiredSupports;
    }

    return annotated;
  }, [allIslands, supportTips, plateZ, areaPerSupport]);

  const contouredIds = useMemo(() => {
    return enableContourRegions
      ? determineContourThreshold(annotatedIslands, pxMm, maxContourRegions)
      : new Set<string>();
  }, [annotatedIslands, enableContourRegions, pxMm, maxContourRegions]);

  const filteredIslands = useMemo(() => {
    return applyFilter(annotatedIslands.map((i) => ({ ...i })), filterToggles);
  }, [annotatedIslands, filterToggles]);

  const displayedIslands = useMemo(() => {
    return filteredIslands.filter((island) => {
      if (island.class === 'voxelOnly' && island.source === 'voxel') {
        return showVoxelOnly;
      }
      if (island.class === 'minimaOnly' && island.source === 'minima') {
        return showMinimaOnly;
      }
      if (island.class === 'intersection') {
        // Only include the voxel version of the intersection to avoid duplicate navigation items
        return showIntersection && island.source === 'voxel';
      }
      return true;
    });
  }, [filteredIslands, showVoxelOnly, showMinimaOnly, showIntersection]);

  // Cluster-walk ordering for the list / ←/→ navigation (Euclidean only).
  const orderedIslands = useMemo(() => {
    return clusterWalkOrder(displayedIslands.map((i) => ({ ...i })), {
      epsilonMm: Math.max(8, pxMm * 40),
    });
  }, [displayedIslands, pxMm]);

  // Per-source pucks for the IslandOverlay layers (blue voxel-only / green minima-only / red intersection).
  // Retain supported voxel area blobs: keep them in the puck list so they remain visible in 3D,
  // but still hide grounded ones if filterToggles.showPlateContact is false.
  const voxelOnlyPucks = useMemo(
    () => buildIslandPucks(
      showVoxelOnly 
        ? annotatedIslands.filter((i) => {
            if (i.source !== 'voxel' || i.class !== 'voxelOnly') return false;
            if (i.grounded && !filterToggles.showPlateContact) return false;
            
            const isContoured = contouredIds.has(i.id);
            if (isContoured) {
              return !removeSupportedAreaClusters || !i.fullySupported;
            } else {
              return !i.supported;
            }
          })
        : []
    ),
    [annotatedIslands, showVoxelOnly, filterToggles.showPlateContact, contouredIds, removeSupportedAreaClusters],
  );
  const minimaOnlyPucks = useMemo(
    () => buildIslandPucks(showMinimaOnly ? filteredIslands.filter((i) => i.source === 'minima' && i.class === 'minimaOnly') : []),
    [filteredIslands, showMinimaOnly],
  );
  const intersectionPucks = useMemo(
    () => buildIslandPucks(
      showIntersection 
        ? annotatedIslands.filter((i) => {
            if (i.class !== 'intersection' || i.source !== 'voxel') return false;
            if (i.grounded && !filterToggles.showPlateContact) return false;
            
            const isContoured = contouredIds.has(i.id);
            if (isContoured) {
              return !removeSupportedAreaClusters || !i.fullySupported;
            } else {
              return !i.supported;
            }
          })
        : []
    ),
    [annotatedIslands, showIntersection, filterToggles.showPlateContact, contouredIds, removeSupportedAreaClusters],
  );

  const byMarkerId = useMemo(() => {
    const merged = new Map<number, DetectedIsland>();
    for (const [id, island] of voxelOnlyPucks.byMarkerId) {
      merged.set(id, island);
    }
    for (const [id, island] of minimaOnlyPucks.byMarkerId) {
      merged.set(id, island);
    }
    for (const [id, island] of intersectionPucks.byMarkerId) {
      merged.set(id, island);
    }
    return merged;
  }, [voxelOnlyPucks, minimaOnlyPucks, intersectionPucks]);

  const islandMarkers = useMemo(() => {
    const markers: any[] = [];

    voxelOnlyPucks.markers.forEach(m => {
      const island = voxelOnlyPucks.byMarkerId.get(m.id);
      const area = island?.areaMm2 ?? 0;
      const radius = scaleMarkersWithArea && area > 0 ? Math.max(0.1, Math.sqrt(area / Math.PI)) : 0.1;

      if (island && contouredIds.has(island.id) && island.contactVoxels && island.contactVoxels.length > 0) {
        const contour = generateContourMarkers(island.contactVoxels, pxMm, m.id, m.baseZ, consolidateVoxel ? 3 : 0);
        markers.push(...contour);
      } else {
        markers.push({ ...m, radius, type: consolidateVoxel ? 3 : 0, islandId: m.id });
      }
    });

    minimaOnlyPucks.markers.forEach(m => {
      markers.push({ ...m, radius: 0.1, type: 1, islandId: m.id });
    });

    intersectionPucks.markers.forEach(m => {
      const island = intersectionPucks.byMarkerId.get(m.id);
      const area = island?.areaMm2 ?? 0;
      const radius = scaleMarkersWithArea && area > 0 ? Math.max(0.1, Math.sqrt(area / Math.PI)) : 0.1;

      // 1. Generate and push the blue voxel blob (either contoured if binned or a single dot if not) as type 3 if showVoxelOnly is enabled
      if (showVoxelOnly) {
        if (island && contouredIds.has(island.id) && island.contactVoxels && island.contactVoxels.length > 0) {
          const contourBlue = generateContourMarkers(island.contactVoxels, pxMm, m.id, m.baseZ, 3);
          markers.push(...contourBlue);
        } else {
          markers.push({ ...m, radius, type: 3, islandId: m.id });
        }
      }

      // 2. If the island is NOT supported (or if filterToggles.showAlreadySupported is checked), push the red dot marker of type 2
      if (island && (!island.supported || filterToggles.showAlreadySupported)) {
        markers.push({ ...m, radius: 0.1, type: 2, islandId: m.id });
      }
    });

    return markers;
  }, [
    voxelOnlyPucks,
    minimaOnlyPucks,
    intersectionPucks,
    consolidateVoxel,
    scaleMarkersWithArea,
    contouredIds,
    filterToggles,
    pxMm,
    showVoxelOnly,
  ]);

  const clear = useCallback(() => {
    setVoxelIslands([]);
    setMinimaIslands([]);
    setSelectedMarkerId(null);
  }, []);

  // Clear islands selection/cached data on activeTab, sourcePath, geom or transform changes
  useEffect(() => {
    clear();
  }, [
    activeTab,
    sourcePath,
    geom,
    transform.position.x,
    transform.position.y,
    transform.position.z,
    transform.rotation.x,
    transform.rotation.y,
    transform.rotation.z,
    transform.scale.x,
    transform.scale.y,
    transform.scale.z,
    clear,
  ]);

  const selectNext = useCallback(() => {
    if (orderedIslands.length === 0) return;
    const currentIndex = orderedIslands.findIndex((i) => markerIdFor(i) === selectedMarkerId);
    if (currentIndex === -1) {
      setSelectedMarkerId(markerIdFor(orderedIslands[0]));
    } else {
      const nextIndex = (currentIndex + 1) % orderedIslands.length;
      setSelectedMarkerId(markerIdFor(orderedIslands[nextIndex]));
    }
  }, [orderedIslands, selectedMarkerId]);

  const selectPrev = useCallback(() => {
    if (orderedIslands.length === 0) return;
    const currentIndex = orderedIslands.findIndex((i) => markerIdFor(i) === selectedMarkerId);
    if (currentIndex === -1) {
      setSelectedMarkerId(markerIdFor(orderedIslands[orderedIslands.length - 1]));
    } else {
      const prevIndex = (currentIndex - 1 + orderedIslands.length) % orderedIslands.length;
      setSelectedMarkerId(markerIdFor(orderedIslands[prevIndex]));
    }
  }, [orderedIslands, selectedMarkerId]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeElement = document.activeElement;
      if (activeElement) {
        const tagName = activeElement.tagName.toLowerCase();
        if (
          tagName === 'input' ||
          tagName === 'textarea' ||
          activeElement.hasAttribute('contenteditable') ||
          activeElement.getAttribute('contenteditable') === 'true'
        ) {
          return;
        }
      }

      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        selectNext();
      } else if (e.key === 'b' || e.key === 'B') {
        e.preventDefault();
        selectPrev();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [selectNext, selectPrev]);

  return {
    scanning,
    scanProgress,
    elapsedLabel,
    voxelIslands,
    minimaIslands,
    filteredIslands,
    orderedIslands,
    voxelOnlyPucks,
    minimaOnlyPucks,
    intersectionPucks,
    islandMarkers,
    byMarkerId,
    stats,
    pxMm,
    setPxMm,
    supportBufMm,
    setSupportBufMm,
    connectivity,
    setConnectivity,
    filterToggles,
    setFilterToggles,
    showVoxelOnly,
    setShowVoxelOnly,
    showMinimaOnly,
    setShowMinimaOnly,
    showIntersection,
    setShowIntersection,
    selectedMarkerId,
    setSelectedMarkerId,
    onRunScan,
    clear,
    layerHeightMm,
    selectNext,
    selectPrev,
    consolidateVoxel,
    setConsolidateVoxel,
    consolidationDistance,
    setConsolidationDistance,
    reduceIntersection,
    setReduceIntersection,
    intersectionThreshold,
    setIntersectionThreshold,
    enableVolumeGlow,
    setEnableVolumeGlow,
    scaleMarkersWithArea,
    setScaleMarkersWithArea,
    enableContourRegions,
    setEnableContourRegions,
    maxContourRegions,
    setMaxContourRegions,
    removeSupportedAreaClusters,
    setRemoveSupportedAreaClusters,
    areaPerSupport,
    setAreaPerSupport,
    tableStats,
  };
}

function dilateVoxelGrid(voxels: { x: number; y: number }[], pxMm: number, consolidationDistance: number): { x: number; y: number }[] {
  if (voxels.length === 0) return [];

  const gridSet = new Set<string>();
  const originalCoords: { ix: number; iy: number }[] = [];

  for (const v of voxels) {
    const ix = Math.round(v.x / pxMm);
    const iy = Math.round(v.y / pxMm);
    const key = `${ix},${iy}`;
    if (!gridSet.has(key)) {
      gridSet.add(key);
      originalCoords.push({ ix, iy });
    }
  }

  const rPix = Math.max(1, Math.round(consolidationDistance / (2 * pxMm)));
  const dilatedSet = new Set<string>();
  const dilatedVoxels: { x: number; y: number }[] = [];

  const offsets: { dx: number; dy: number }[] = [];
  for (let dx = -rPix; dx <= rPix; dx++) {
    for (let dy = -rPix; dy <= rPix; dy++) {
      if (dx * dx + dy * dy <= rPix * rPix) {
        offsets.push({ dx, dy });
      }
    }
  }

  for (const coord of originalCoords) {
    for (const offset of offsets) {
      const nix = coord.ix + offset.dx;
      const niy = coord.iy + offset.dy;
      const nkey = `${nix},${niy}`;
      if (!dilatedSet.has(nkey)) {
        dilatedSet.add(nkey);
        dilatedVoxels.push({ x: nix * pxMm, y: niy * pxMm });
      }
    }
  }

  return dilatedVoxels;
}

export function consolidateVoxelIslands(islands: DetectedIsland[], epsilonMm: number, pxMm: number): DetectedIsland[] {
  const n = islands.length;
  if (n === 0) return [];
  
  const minAreaForContour = 0.06; // mm² (resolution-invariant)

  if (n === 1) {
    const single = { ...islands[0] };
    if ((single.areaMm2 ?? 0) >= minAreaForContour && single.contactVoxels && single.contactVoxels.length > 0) {
      const dilated = dilateVoxelGrid(single.contactVoxels, pxMm, epsilonMm);
      single.contactVoxels = dilated;
      single.areaMm2 = dilated.length * pxMm * pxMm;
    }
    return [single];
  }

  const eps2 = epsilonMm * epsilonMm;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    parent[find(a)] = find(b);
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (islands[i].contact.distanceToSquared(islands[j].contact) <= eps2) {
        union(i, j);
      }
    }
  }

  const byRoot = new Map<number, DetectedIsland[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    let bucket = byRoot.get(root);
    if (!bucket) {
      bucket = [];
      byRoot.set(root, bucket);
    }
    bucket.push(islands[i]);
  }

  const consolidated: DetectedIsland[] = [];
  for (const members of byRoot.values()) {
    const hasCluster = members.some((m) => (m.areaMm2 ?? 0) >= minAreaForContour);

    if (hasCluster) {
      members.sort((a, b) => a.baseZ - b.baseZ);
      const lowest = members[0];

      let sumX = 0, sumY = 0, totalArea = 0;
      let minFirstLayer = Infinity, maxLastLayer = -Infinity;
      const contactVoxels: { x: number; y: number }[] = [];
      for (const m of members) {
        sumX += m.contact.x;
        sumY += m.contact.y;
        totalArea += m.areaMm2 ?? 0;
        if (m.layerSpan) {
          minFirstLayer = Math.min(minFirstLayer, m.layerSpan[0]);
          maxLastLayer = Math.max(maxLastLayer, m.layerSpan[1]);
        }
        if (m.contactVoxels) {
          contactVoxels.push(...m.contactVoxels);
        }
      }

      const dilatedVoxels = contactVoxels.length > 0
        ? dilateVoxelGrid(contactVoxels, pxMm, epsilonMm)
        : undefined;

      const finalArea = (dilatedVoxels && dilatedVoxels.length > 0)
        ? dilatedVoxels.length * pxMm * pxMm
        : totalArea;

      const contact = lowest.contact.clone();

      consolidated.push({
        ...lowest,
        contact,
        baseZ: lowest.baseZ,
        areaMm2: finalArea,
        layerSpan: minFirstLayer !== Infinity ? [minFirstLayer, maxLastLayer] : undefined,
        contactVoxels: dilatedVoxels,
      });
    } else {
      // Keep them separate
      for (const m of members) {
        consolidated.push({ ...m });
      }
    }
  }

  return consolidated;
}

export function determineContourThreshold(
  islands: DetectedIsland[],
  pxMm: number,
  maxContourRegions: number
): Set<string> {
  const contouredIds = new Set<string>();

  // Candidates for contouring must have voxel data (contactVoxels) and be voxelOnly or intersection class
  const candidates = islands.filter(
    (i) =>
      (i.class === 'voxelOnly' || i.class === 'intersection') &&
      i.contactVoxels &&
      i.contactVoxels.length > 0
  );

  if (candidates.length === 0) return contouredIds;

  // Minimum area to qualify for contouring (0.06 mm², resolution-invariant)
  const minAreaForContour = 0.06;
  const qualified = candidates.filter((i) => (i.areaMm2 ?? 0) >= minAreaForContour);

  // Sort qualified candidates descending by area
  const sorted = [...qualified].sort((a, b) => (b.areaMm2 ?? 0) - (a.areaMm2 ?? 0));

  if (sorted.length === 0) return contouredIds;

  // If we have fewer than or equal to maxContourRegions, we can contour all qualified ones
  if (sorted.length <= maxContourRegions) {
    for (const i of sorted) {
      contouredIds.add(i.id);
    }
    return contouredIds;
  }

  // Otherwise, we perform a statistical breakdown to find breakpoints
  const areas = sorted.map((i) => i.areaMm2 ?? 0);
  const totalArea = areas.reduce((sum, a) => sum + a, 0);

  // Find the index K where cumulative area hits 90%
  let cumulative = 0;
  let cumIndex = 0;
  for (let i = 0; i < areas.length; i++) {
    cumulative += areas[i];
    if (cumulative >= totalArea * 0.90) {
      cumIndex = i;
      break;
    }
  }

  // Scan candidate K limits: we want K to be between 5 and maxContourRegions
  const minK = Math.min(5, sorted.length);
  const maxK = Math.min(maxContourRegions, sorted.length);

  // Find the index K in [minK, maxK] that maximizes relative drop-off (breakpoint)
  // dropOff_i = (areas[i-1] - areas[i]) / areas[i-1]
  let bestK = Math.min(maxK, Math.max(minK, cumIndex + 1));
  let maxDrop = -1;

  for (let k = minK; k <= maxK; k++) {
    if (k < areas.length) {
      const prevArea = areas[k - 1];
      const currArea = areas[k];
      if (prevArea > 0) {
        const drop = (prevArea - currArea) / prevArea;
        if (drop > maxDrop) {
          maxDrop = drop;
          bestK = k;
        }
      }
    }
  }

  // Contour the top bestK islands
  for (let i = 0; i < bestK; i++) {
    contouredIds.add(sorted[i].id);
  }

  return contouredIds;
}

interface ContourMarker {
  id: number;
  centerX: number;
  centerY: number;
  baseZ: number;
  pixelCount: number;
  radius: number;
  type: number;
  islandId: number;
}

export function generateContourMarkers(
  voxels: { x: number; y: number }[],
  pxMm: number,
  islandId: number,
  baseZ: number,
  type: number
): ContourMarker[] {
  const markers: ContourMarker[] = [];
  if (voxels.length === 0) return markers;

  const R_small = Math.max(0.12, pxMm * 1.5);
  const R_large = pxMm * 3.5;
  const R_small2 = R_small * R_small;
  const R_large2 = R_large * R_large;

  // Map voxels to a coordinate lookup Set for classification
  const voxelSet = new Set(voxels.map((v) => `${v.x.toFixed(3)},${v.y.toFixed(3)}`));

  // Classify into interior vs boundary
  const classified = voxels.map((v) => {
    let isInterior = true;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const nx = v.x + dx * pxMm;
        const ny = v.y + dy * pxMm;
        if (!voxelSet.has(`${nx.toFixed(3)},${ny.toFixed(3)}`)) {
          isInterior = false;
          break;
        }
      }
      if (!isInterior) break;
    }
    return { x: v.x, y: v.y, isInterior, covered: false };
  });

  let uncoveredCount = classified.length;
  let subId = 0;
  const maxTotalMarkers = 30;
  const maxLargeMarkers = 15;

  // Pass 1: Place large circles centered on uncovered interior voxels
  while (uncoveredCount > 0 && markers.length < maxLargeMarkers) {
    let bestIdx = -1;
    let bestCoveredCount = -1;

    for (let i = 0; i < classified.length; i++) {
      const vi = classified[i];
      if (!vi.isInterior || vi.covered) continue;

      let count = 0;
      for (let j = 0; j < classified.length; j++) {
        const vj = classified[j];
        if (vj.covered) continue;
        const dx = vi.x - vj.x;
        const dy = vi.y - vj.y;
        if (dx * dx + dy * dy <= R_large2) {
          count++;
        }
      }

      if (count > bestCoveredCount) {
        bestCoveredCount = count;
        bestIdx = i;
      }
    }

    if (bestIdx === -1 || bestCoveredCount === 0) {
      break;
    }

    const centerV = classified[bestIdx];

    // Mark covered
    for (let j = 0; j < classified.length; j++) {
      const vj = classified[j];
      if (vj.covered) continue;
      const dx = centerV.x - vj.x;
      const dy = centerV.y - vj.y;
      if (dx * dx + dy * dy <= R_large2) {
        classified[j].covered = true;
        uncoveredCount--;
      }
    }

    markers.push({
      id: islandId + subId / 10000.0,
      centerX: centerV.x,
      centerY: centerV.y,
      baseZ,
      pixelCount: 1,
      radius: R_large,
      type,
      islandId,
    });

    subId++;
  }

  // Pass 2: Place small circles centered on any uncovered voxels
  while (uncoveredCount > 0 && markers.length < maxTotalMarkers) {
    let bestIdx = -1;
    let bestCoveredCount = -1;

    for (let i = 0; i < classified.length; i++) {
      const vi = classified[i];
      if (vi.covered) continue;

      let count = 0;
      for (let j = 0; j < classified.length; j++) {
        const vj = classified[j];
        if (vj.covered) continue;
        const dx = vi.x - vj.x;
        const dy = vi.y - vj.y;
        if (dx * dx + dy * dy <= R_small2) {
          count++;
        }
      }

      if (count > bestCoveredCount) {
        bestCoveredCount = count;
        bestIdx = i;
      }
    }

    if (bestIdx === -1 || bestCoveredCount === 0) {
      break;
    }

    const centerV = classified[bestIdx];

    // Mark covered
    for (let j = 0; j < classified.length; j++) {
      const vj = classified[j];
      if (vj.covered) continue;
      const dx = centerV.x - vj.x;
      const dy = centerV.y - vj.y;
      if (dx * dx + dy * dy <= R_small2) {
        classified[j].covered = true;
        uncoveredCount--;
      }
    }

    markers.push({
      id: islandId + subId / 10000.0,
      centerX: centerV.x,
      centerY: centerV.y,
      baseZ,
      pixelCount: 1,
      radius: R_small,
      type,
      islandId,
    });

    subId++;
  }

  return markers;
}
