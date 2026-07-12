import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
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
import { type DetectedIsland, type TipInfo, SUPPORTED_RADIUS_MM } from './types';
import { classifyIntersection } from './intersection';
import { getSnapshot } from '@/supports/state';
import { SpatialHashGrid2D } from './spatialHashGrid2D';

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

  // Active settings states used in calculations
  const [pxMm, setPxMm] = useState(0.05);
  const [supportBufMm, setSupportBufMm] = useState(0.25);
  const [connectivity, setConnectivity] = useState<4 | 8>(4);
  const [consolidateVoxel, setConsolidateVoxel] = useState<boolean>(false);
  const [consolidationDistance, setConsolidationDistance] = useState<number>(0.2);
  const [reduceIntersection, setReduceIntersection] = useState<boolean>(false);
  const [intersectionThreshold, setIntersectionThreshold] = useState<number>(0.5);
  const [enableVolumeGlow, setEnableVolumeGlow] = useState<boolean>(false);
  const [scaleMarkersWithArea, setScaleMarkersWithArea] = useState<boolean>(true);
  const [enableContourRegions, setEnableContourRegions] = useState<boolean>(true);
  const [maxContourRegions, setMaxContourRegions] = useState<number>(20);
  const [removeSupportedAreaClusters, setRemoveSupportedAreaClusters] = useState<boolean>(false);
  const [areaPerSupport, setAreaPerSupport] = useState<number>(4.0);
  const [minAreaMm2, setMinAreaMm2] = useState<number>(0.02);
  const [minimaK, setMinimaK] = useState<number>(2);

  // Draft settings states bound to UI inputs
  const [draftPxMm, setDraftPxMm] = useState(0.05);
  const [draftSupportBufMm, setDraftSupportBufMm] = useState(0.25);
  const [draftConnectivity, setDraftConnectivity] = useState<4 | 8>(4);
  const [draftConsolidateVoxel, setDraftConsolidateVoxel] = useState<boolean>(false);
  const [draftConsolidationDistance, setDraftConsolidationDistance] = useState<number>(0.2);
  const [draftReduceIntersection, setDraftReduceIntersection] = useState<boolean>(false);
  const [draftIntersectionThreshold, setDraftIntersectionThreshold] = useState<number>(0.5);
  const [draftEnableVolumeGlow, setDraftEnableVolumeGlow] = useState<boolean>(false);
  const [draftScaleMarkersWithArea, setDraftScaleMarkersWithArea] = useState<boolean>(true);
  const [draftEnableContourRegions, setDraftEnableContourRegions] = useState<boolean>(true);
  const [draftMaxContourRegions, setDraftMaxContourRegions] = useState<number>(20);
  const [draftRemoveSupportedAreaClusters, setDraftRemoveSupportedAreaClusters] = useState<boolean>(false);
  const [draftAreaPerSupport, setDraftAreaPerSupport] = useState<number>(4.0);
  const [draftMinAreaMm2, setDraftMinAreaMm2] = useState<number>(0.02);
  const [draftMinimaK, setDraftMinimaK] = useState<number>(2);

  const [applyingSettings, setApplyingSettings] = useState(false);

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
    try {
      const bb = g.boundingBox ?? new THREE.Box3().setFromBufferAttribute(g.getAttribute('position') as THREE.BufferAttribute);
      const center = bb.getCenter(new THREE.Vector3());
      g.translate(-center.x, -center.y, -center.z);
      const matrix = new THREE.Matrix4().compose(
        transform.position.clone(),
        quaternionFromGlobalEuler(transform.rotation),
        transform.scale.clone(),
      );
      g.applyMatrix4(matrix);
      const soup = g.index ? g.toNonIndexed() : g;
      try {
        soup.computeBoundingBox();
        const positions = (soup.getAttribute('position').array as Float32Array).slice();
        const bbox = soup.boundingBox!.clone();
        return { positions, bbox };
      } finally {
        if (soup !== g) {
          soup.dispose();
        }
      }
    } finally {
      g.dispose();
    }
  }, [geom, transform]);

  /**
   * Run BOTH detectors on the same world-space positions (one shared transform →
   * one frame → directly comparable for Part C). Voxel uses the scanline worker
   * pool; minima is a single Rust IPC call. A minima failure (e.g. non-Tauri
   * context) is non-fatal — voxel results still stand.
   */
  const onRunScan = useCallback(async () => {
    setScanning(true);
    // Yield immediately so React can flush the "scanning" state and show
    // the progress modal before we start expensive synchronous work.
    await new Promise((resolve) => setTimeout(resolve, 0));
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

        console.log(`[Islands] Sideloading combined island scan from path: ${sourcePath}`);
        const combined = await invoke<{ voxelIslands: any[]; minimaIslands: any[] }>(
          'scan_islands_from_path',
          {
            filePath: sourcePath,
            matrix: matrixElements,
            center: centerCoords,
            layerHeightMm,
            pxMm,
            supportBufferMm: supportBufMm,
            connectivity,
            k: minimaK,
          },
        );

        const voxelMapped: DetectedIsland[] = combined.voxelIslands
          .filter((v) => (v.areaMm2 ?? 0) >= minAreaMm2)
          .map((v) => ({
            id: v.id,
            source: 'voxel',
            contact: new THREE.Vector3(v.contact.x, v.contact.y, v.contact.z),
            baseZ: v.baseZ,
            areaMm2: v.areaMm2,
            layerSpan: v.layerSpan,
          }));
        setVoxelIslands(voxelMapped);

        const minimaMapped: DetectedIsland[] = combined.minimaIslands.map((m, i) => ({
          id: `m${i}`,
          source: 'minima',
          contact: new THREE.Vector3(m.position.x, m.position.y, m.position.z),
          baseZ: m.position.z,
          vertexIndex: m.vertexIndex,
          seedTriangleId: m.seedTriangleId,
        }));
        setMinimaIslands(minimaMapped);

        // Cache the scan results for this model
        if (sourcePath) {
          scanCacheRef.current.set(sourcePath, { voxel: voxelMapped, minima: minimaMapped });
        }

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
          minAreaMm2,
        };
        const voxel = await detectVoxelIslands(world, layerHeightMm, params, (done, total) =>
          setScanProgress({ done, total }),
        );
        setVoxelIslands(voxel);

        try {
          const minima = await scanMeshMinima(world.positions, minimaK);
          setMinimaIslands(minima);
          // Cache the scan results for this model
          if (sourcePath) {
            scanCacheRef.current.set(sourcePath, { voxel, minima });
          }
        } catch (err) {
          console.error('[Islands] mesh-minima scan failed', err);
          setMinimaIslands([]);
          if (sourcePath) {
            scanCacheRef.current.set(sourcePath, { voxel, minima: [] });
          }
        }
      } finally {
        setScanning(false);
      }
    } else {
      setScanning(false);
    }
  }, [geom, transform, sourcePath, prepareWorldGeom, layerHeightMm, pxMm, supportBufMm, connectivity, minAreaMm2, minimaK]);

  // Pass 1: Proposed consolidation & classification
  const proposedConsolidated = useMemo(() => {
    if (!consolidateVoxel) return voxelIslands;
    return consolidateVoxelIslands(voxelIslands, consolidationDistance, pxMm);
  }, [voxelIslands, consolidateVoxel, consolidationDistance, pxMm]);

  const proposedClassified = useMemo(() => {
    return classifyIntersection(proposedConsolidated, minimaIslands, {
      xyToleranceMm: 0.5,
      zBandMm: layerHeightMm,
    });
  }, [proposedConsolidated, minimaIslands, layerHeightMm]);

  // Determine contoured IDs based on proposed list
  const contouredIds = useMemo(() => {
    return enableContourRegions
      ? determineContourThreshold(proposedClassified.islands, pxMm, maxContourRegions)
      : new Set<string>();
  }, [proposedClassified.islands, enableContourRegions, pxMm, maxContourRegions]);

  // Pass 2: Revert non-contoured consolidated islands back to single voxel islands
  const finalVoxelIslands = useMemo(() => {
    const list: DetectedIsland[] = [];
    for (const island of proposedConsolidated) {
      const isContoured = contouredIds.has(island.id);
      if (island.members && island.members.length > 1 && !isContoured) {
        list.push(...island.members);
      } else {
        list.push(island);
      }
    }
    return list;
  }, [proposedConsolidated, contouredIds]);

  const classifiedResult = useMemo(() => {
    return classifyIntersection(finalVoxelIslands, minimaIslands, {
      xyToleranceMm: 0.5,
      zBandMm: layerHeightMm,
    });
  }, [finalVoxelIslands, minimaIslands, layerHeightMm]);

  const allIslands = classifiedResult.islands;
  const stats = classifiedResult.stats;

  const mappedSupportTips = useMemo<TipInfo[]>(() => {
    const state = getSnapshot();
    const coordMap = new Map<string, number>();

    const processCone = (cone: any) => {
      if (cone?.pos) {
        const { x, y, z } = cone.pos;
        const dia = cone.profile?.contactDiameterMm ?? 0.4;
        coordMap.set(`${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`, dia);
      }
    };

    const processDisk = (disk: any) => {
      if (disk?.pos) {
        const { x, y, z } = disk.pos;
        const dia = disk.contactDiameterMm ?? 0.4;
        coordMap.set(`${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`, dia);
      }
    };

    if (state.trunks) {
      Object.values(state.trunks).forEach((trunk: any) => {
        processCone(trunk.contactCone);
      });
    }
    if (state.branches) {
      Object.values(state.branches).forEach((branch: any) => {
        processCone(branch.contactCone);
      });
    }
    if (state.leaves) {
      Object.values(state.leaves).forEach((leaf: any) => {
        processCone(leaf.contactCone);
      });
    }
    if (state.anchors) {
      Object.values(state.anchors).forEach((anchor: any) => {
        processCone(anchor.contactCone);
      });
    }
    if (state.twigs) {
      Object.values(state.twigs).forEach((twig: any) => {
        processDisk(twig.contactDiskA);
        processDisk(twig.contactDiskB);
      });
    }
    if (state.sticks) {
      Object.values(state.sticks).forEach((stick: any) => {
        processCone(stick.contactConeA);
        processCone(stick.contactConeB);
      });
    }

    return supportTips.map((tip) => {
      const key = `${tip.x.toFixed(3)},${tip.y.toFixed(3)},${tip.z.toFixed(3)}`;
      const diameterMm = coordMap.get(key) ?? 0.4;
      return { pos: tip, diameterMm };
    });
  }, [supportTips]);

  const annotatedIslands = useMemo(() => {
    return annotateAndCountSupports(allIslands, mappedSupportTips, plateZ, areaPerSupport, layerHeightMm);
  }, [allIslands, mappedSupportTips, plateZ, areaPerSupport, layerHeightMm]);

  const tableStats = useMemo(() => {
    const voxelTotal = annotatedIslands.filter(i => i.class === 'voxelOnly' && i.source === 'voxel').length;
    const voxelUnsupported = annotatedIslands.filter(i => i.class === 'voxelOnly' && i.source === 'voxel' && !i.supported && !i.grounded).length;
    
    const geomTotal = annotatedIslands.filter(i => i.class === 'minimaOnly' && i.source === 'minima').length;
    const geomUnsupported = annotatedIslands.filter(i => i.class === 'minimaOnly' && i.source === 'minima' && !i.supported && !i.grounded).length;
    
    const coincidentTotal = annotatedIslands.filter(i => i.class === 'intersection' && i.source === 'voxel').length;
    const coincidentUnsupported = annotatedIslands.filter(i => i.class === 'intersection' && i.source === 'voxel' && !i.supported && !i.grounded).length;
    
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
  }, [annotatedIslands]);

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

  // Sort by numeric ID for predictable prev/next navigation.
  const baseOrderedIslands = useMemo(() => {
    return [...allIslands].sort((a, b) => {
      const aNum = parseInt(a.id.replace(/^\D+/, ''), 10) || 0;
      const bNum = parseInt(b.id.replace(/^\D+/, ''), 10) || 0;
      return aNum - bNum;
    });
  }, [allIslands]);

  const orderedIslands = useMemo(() => {
    const displayedSet = new Set(displayedIslands.map((i) => i.id));
    return baseOrderedIslands.filter((i) => displayedSet.has(i.id));
  }, [baseOrderedIslands, displayedIslands]);

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
      annotatedIslands.filter((i) => {
        if (i.class !== 'intersection' || i.source !== 'voxel') return false;
        if (i.grounded && !filterToggles.showPlateContact) return false;
        
        const isContoured = contouredIds.has(i.id);
        if (isContoured) {
          return !removeSupportedAreaClusters || !i.fullySupported;
        } else {
          return !i.supported;
        }
      })
    ),
    [annotatedIslands, filterToggles.showPlateContact, contouredIds, removeSupportedAreaClusters],
  );

  const byMarkerId = useMemo(() => {
    const merged = new Map<number, DetectedIsland>();
    for (const [id, island] of voxelOnlyPucks.byMarkerId) {
      merged.set(id, island);
    }
    for (const [id, island] of minimaOnlyPucks.byMarkerId) {
      merged.set(id, island);
    }
    if (showIntersection || showVoxelOnly) {
      for (const [id, island] of intersectionPucks.byMarkerId) {
        merged.set(id, island);
      }
    }
    return merged;
  }, [voxelOnlyPucks, minimaOnlyPucks, intersectionPucks, showIntersection, showVoxelOnly]);

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

      // 2. Coincident red dot — only when showIntersection is enabled
      if (showIntersection && island && (!island.supported || filterToggles.showAlreadySupported)) {
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
    showIntersection,
  ]);

  const clear = useCallback(() => {
    setVoxelIslands([]);
    setMinimaIslands([]);
    setSelectedMarkerId(null);
  }, []);

  // Per-model scan cache: sourcePath → { voxel, minima }
  const scanCacheRef = useRef<Map<string, { voxel: DetectedIsland[]; minima: DetectedIsland[] }>>(new Map());
  const prevSourcePathRef = useRef<string | null | undefined>(undefined);

  // On sourcePath change: restore from cache instead of clearing
  useEffect(() => {
    const prev = prevSourcePathRef.current;
    prevSourcePathRef.current = sourcePath;
    if (!sourcePath || prev === sourcePath) return;

    const cached = scanCacheRef.current.get(sourcePath);
    if (cached) {
      setVoxelIslands(cached.voxel);
      setMinimaIslands(cached.minima);
      setSelectedMarkerId(null);
      return;
    }

    // No cache entry — clear for new model
    clear();
  }, [sourcePath, clear]);

  // On transform/geom change: always clear (scan is invalidated)
  useEffect(() => {
    clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
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
    const handleKeyDown = (e: CustomEvent) => {
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

      const key = e.detail.key;
      if (key === 'n' || key === 'N') {
        selectNext();
      } else if (key === 'b' || key === 'B') {
        selectPrev();
      }
    };

    window.addEventListener('app-hotkey-keydown', handleKeyDown as EventListener);
    return () => {
      window.removeEventListener('app-hotkey-keydown', handleKeyDown as EventListener);
    };
  }, [selectNext, selectPrev]);

  const applySettings = useCallback(() => {
    setApplyingSettings(true);
    setTimeout(() => {
      setPxMm(draftPxMm);
      setSupportBufMm(draftSupportBufMm);
      setConnectivity(draftConnectivity);
      setConsolidateVoxel(draftConsolidateVoxel);
      setConsolidationDistance(draftConsolidationDistance);
      setReduceIntersection(draftReduceIntersection);
      setIntersectionThreshold(draftIntersectionThreshold);
      setEnableVolumeGlow(draftEnableVolumeGlow);
      setScaleMarkersWithArea(draftScaleMarkersWithArea);
      setEnableContourRegions(draftEnableContourRegions);
      setMaxContourRegions(draftMaxContourRegions);
      setRemoveSupportedAreaClusters(draftRemoveSupportedAreaClusters);
      setAreaPerSupport(draftAreaPerSupport);
      setMinAreaMm2(draftMinAreaMm2);
      setMinimaK(draftMinimaK);
      setApplyingSettings(false);
    }, 50);
  }, [
    draftPxMm,
    draftSupportBufMm,
    draftConnectivity,
    draftConsolidateVoxel,
    draftConsolidationDistance,
    draftReduceIntersection,
    draftIntersectionThreshold,
    draftEnableVolumeGlow,
    draftScaleMarkersWithArea,
    draftEnableContourRegions,
    draftMaxContourRegions,
    draftRemoveSupportedAreaClusters,
    draftAreaPerSupport,
    draftMinAreaMm2,
    draftMinimaK,
  ]);

  const resetSettings = useCallback(() => {
    setDraftPxMm(0.05);
    setDraftSupportBufMm(0.25);
    setDraftConnectivity(4);
    setDraftConsolidateVoxel(false);
    setDraftConsolidationDistance(0.2);
    setDraftReduceIntersection(false);
    setDraftIntersectionThreshold(0.5);
    setDraftEnableVolumeGlow(true);
    setDraftScaleMarkersWithArea(true);
    setDraftEnableContourRegions(true);
    setDraftMaxContourRegions(20);
    setDraftRemoveSupportedAreaClusters(false);
    setDraftAreaPerSupport(4.0);
    setDraftMinAreaMm2(0.02);
    setDraftMinimaK(2);
  }, []);

  const hasPendingChanges = useMemo(() => {
    return (
      pxMm !== draftPxMm ||
      supportBufMm !== draftSupportBufMm ||
      connectivity !== draftConnectivity ||
      consolidateVoxel !== draftConsolidateVoxel ||
      consolidationDistance !== draftConsolidationDistance ||
      reduceIntersection !== draftReduceIntersection ||
      intersectionThreshold !== draftIntersectionThreshold ||
      enableVolumeGlow !== draftEnableVolumeGlow ||
      scaleMarkersWithArea !== draftScaleMarkersWithArea ||
      enableContourRegions !== draftEnableContourRegions ||
      maxContourRegions !== draftMaxContourRegions ||
      removeSupportedAreaClusters !== draftRemoveSupportedAreaClusters ||
      areaPerSupport !== draftAreaPerSupport ||
      minAreaMm2 !== draftMinAreaMm2 ||
      minimaK !== draftMinimaK
    );
  }, [
    pxMm, draftPxMm,
    supportBufMm, draftSupportBufMm,
    connectivity, draftConnectivity,
    consolidateVoxel, draftConsolidateVoxel,
    consolidationDistance, draftConsolidationDistance,
    reduceIntersection, draftReduceIntersection,
    intersectionThreshold, draftIntersectionThreshold,
    enableVolumeGlow, draftEnableVolumeGlow,
    scaleMarkersWithArea, draftScaleMarkersWithArea,
    enableContourRegions, draftEnableContourRegions,
    maxContourRegions, draftMaxContourRegions,
    removeSupportedAreaClusters, draftRemoveSupportedAreaClusters,
    areaPerSupport, draftAreaPerSupport,
    minAreaMm2, draftMinAreaMm2,
    minimaK, draftMinimaK,
  ]);

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
    minAreaMm2,
    setMinAreaMm2,
    minimaK,
    setMinimaK,
    tableStats,

    // Draft states
    draftPxMm,
    setDraftPxMm,
    draftSupportBufMm,
    setDraftSupportBufMm,
    draftConnectivity,
    setDraftConnectivity,
    draftConsolidateVoxel,
    setDraftConsolidateVoxel,
    draftConsolidationDistance,
    setDraftConsolidationDistance,
    draftReduceIntersection,
    setDraftReduceIntersection,
    draftIntersectionThreshold,
    setDraftIntersectionThreshold,
    draftEnableVolumeGlow,
    setDraftEnableVolumeGlow,
    draftScaleMarkersWithArea,
    setDraftScaleMarkersWithArea,
    draftEnableContourRegions,
    setDraftEnableContourRegions,
    draftMaxContourRegions,
    setDraftMaxContourRegions,
    draftRemoveSupportedAreaClusters,
    setDraftRemoveSupportedAreaClusters,
    draftAreaPerSupport,
    setDraftAreaPerSupport,
    draftMinAreaMm2,
    setDraftMinAreaMm2,
    draftMinimaK,
    setDraftMinimaK,
    applySettings,
    resetSettings,
    applyingSettings,
    hasPendingChanges,
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
    single.members = [{ ...islands[0] }];
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
        members: members.map((m) => ({ ...m })),
      });
    } else {
      // Keep them separate
      for (const m of members) {
        consolidated.push({ ...m, members: [{ ...m }] });
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
  const voxelSet = new Set(voxels.map((v) => `${Math.round(v.x / pxMm)},${Math.round(v.y / pxMm)}`));

  // Classify into interior vs boundary
  const classified = voxels.map((v) => {
    const gx = Math.round(v.x / pxMm);
    const gy = Math.round(v.y / pxMm);
    let isInterior = true;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        if (!voxelSet.has(`${gx + dx},${gy + dy}`)) {
          isInterior = false;
          break;
        }
      }
      if (!isInterior) break;
    }
    return { x: v.x, y: v.y, isInterior, covered: false };
  });

  // Build spatial grid with cell size = R_small for O(1) coverage marking
  const cellSize = R_small;
  const grid = new Map<string, typeof classified[number][]>();
  for (const v of classified) {
    const cx = Math.floor(v.x / cellSize);
    const cy = Math.floor(v.y / cellSize);
    const key = `${cx},${cy}`;
    let list = grid.get(key);
    if (!list) {
      list = [];
      grid.set(key, list);
    }
    list.push(v);
  }

  // Helper to mark voxels as covered within a radius in O(1) time
  function markCovered(centerX: number, centerY: number, radius: number): number {
    const r2 = radius * radius;
    const cxStart = Math.floor((centerX - radius) / cellSize);
    const cxEnd = Math.floor((centerX + radius) / cellSize);
    const cyStart = Math.floor((centerY - radius) / cellSize);
    const cyEnd = Math.floor((centerY + radius) / cellSize);

    let newlyCovered = 0;
    for (let cx = cxStart; cx <= cxEnd; cx++) {
      for (let cy = cyStart; cy <= cyEnd; cy++) {
        const key = `${cx},${cy}`;
        const list = grid.get(key);
        if (!list) continue;
        for (const v of list) {
          if (v.covered) continue;
          const dx = v.x - centerX;
          const dy = v.y - centerY;
          if (dx * dx + dy * dy <= r2) {
            v.covered = true;
            newlyCovered++;
          }
        }
      }
    }
    return newlyCovered;
  }

  let uncoveredCount = classified.length;
  let subId = 0;
  const maxTotalMarkers = 30;
  const maxLargeMarkers = 15;

  // Pass 1: Place large circles centered on uncovered interior voxels using large cells
  const largeGrid = new Map<string, typeof classified[number][]>();
  for (const v of classified) {
    if (!v.isInterior) continue;
    const cx = Math.floor(v.x / R_large);
    const cy = Math.floor(v.y / R_large);
    const key = `${cx},${cy}`;
    let list = largeGrid.get(key);
    if (!list) {
      list = [];
      largeGrid.set(key, list);
    }
    list.push(v);
  }

  for (let step = 0; step < maxLargeMarkers; step++) {
    let bestKey = '';
    let bestCount = 0;

    for (const [key, list] of largeGrid.entries()) {
      let count = 0;
      for (const v of list) {
        if (!v.covered) count++;
      }
      if (count > bestCount) {
        bestCount = count;
        bestKey = key;
      }
    }

    if (bestCount === 0 || bestKey === '') {
      break;
    }

    const list = largeGrid.get(bestKey)!;
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    for (const v of list) {
      if (!v.covered) {
        sumX += v.x;
        sumY += v.y;
        count++;
      }
    }

    const centerX = sumX / count;
    const centerY = sumY / count;

    markers.push({
      id: islandId + subId / 10000.0,
      centerX,
      centerY,
      baseZ,
      pixelCount: 1,
      radius: R_large,
      type,
      islandId,
    });
    subId++;

    const coveredNum = markCovered(centerX, centerY, R_large);
    uncoveredCount -= coveredNum;
    if (uncoveredCount <= 0) break;
  }

  // Pass 2: Place small circles centered on uncovered voxels using small cells
  const smallGrid = new Map<string, typeof classified[number][]>();
  for (const v of classified) {
    const cx = Math.floor(v.x / R_small);
    const cy = Math.floor(v.y / R_small);
    const key = `${cx},${cy}`;
    let list = smallGrid.get(key);
    if (!list) {
      list = [];
      smallGrid.set(key, list);
    }
    list.push(v);
  }

  const maxSmallSteps = maxTotalMarkers - markers.length;
  for (let step = 0; step < maxSmallSteps; step++) {
    let bestKey = '';
    let bestCount = 0;

    for (const [key, list] of smallGrid.entries()) {
      let count = 0;
      for (const v of list) {
        if (!v.covered) count++;
      }
      if (count > bestCount) {
        bestCount = count;
        bestKey = key;
      }
    }

    if (bestCount === 0 || bestKey === '') {
      break;
    }

    const list = smallGrid.get(bestKey)!;
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    for (const v of list) {
      if (!v.covered) {
        sumX += v.x;
        sumY += v.y;
        count++;
      }
    }

    const centerX = sumX / count;
    const centerY = sumY / count;

    markers.push({
      id: islandId + subId / 10000.0,
      centerX,
      centerY,
      baseZ,
      pixelCount: 1,
      radius: R_small,
      type,
      islandId,
    });
    subId++;

    const coveredNum = markCovered(centerX, centerY, R_small);
    uncoveredCount -= coveredNum;
    if (uncoveredCount <= 0) break;
  }

  return markers;
}

function annotateAndCountSupports(
  islands: DetectedIsland[],
  supportTips: TipInfo[],
  plateZ: number,
  areaPerSupport: number,
  layerHeightMm?: number,
): DetectedIsland[] {
  const annotated = annotateFilterFlags(islands.map((i) => ({ ...i })), { supportTips, plateZ, layerHeightMm });

  for (const island of annotated) {
    island.supportCount = 0;
  }

  interface IslandGridEntry {
    islandIndex: number;
    x: number;
    y: number;
    z: number;
  }

  // Build spatial grid over islands
  const grid = new SpatialHashGrid2D<IslandGridEntry>(1.0);
  annotated.forEach((island, islandIndex) => {
    const z = island.contact.z;
    if (island.contactVoxels && island.contactVoxels.length > 0) {
      for (const vox of island.contactVoxels) {
        grid.insert(vox.x, vox.y, { islandIndex, x: vox.x, y: vox.y, z });
      }
    } else {
      grid.insert(island.contact.x, island.contact.y, { islandIndex, x: island.contact.x, y: island.contact.y, z });
    }
  });

  const supportedIslandsThisTip = new Set<number>();
  const zTolerance = layerHeightMm ? 2 * layerHeightMm : 0.5;

  for (const tip of supportTips) {
    supportedIslandsThisTip.clear();
    const actualRadius = tip.diameterMm / 2 + 0.15;
    const actualRadiusSq = actualRadius * actualRadius;

    const candidates = grid.query(tip.pos.x, tip.pos.y, actualRadius);

    for (const cand of candidates) {
      if (supportedIslandsThisTip.has(cand.islandIndex)) continue;

      const dz = Math.abs(tip.pos.z - cand.z);
      if (dz > zTolerance) continue;

      const dx = tip.pos.x - cand.x;
      const dy = tip.pos.y - cand.y;
      const distSq = dx * dx + dy * dy;
      if (distSq <= actualRadiusSq) {
        supportedIslandsThisTip.add(cand.islandIndex);
      }
    }

    for (const idx of supportedIslandsThisTip) {
      annotated[idx].supportCount = (annotated[idx].supportCount ?? 0) + 1;
    }
  }

  for (const island of annotated) {
    const area = island.areaMm2 ?? 0;
    island.supported = (island.supportCount ?? 0) > 0;
    const requiredSupports = Math.max(1, Math.ceil(area / areaPerSupport));
    island.fullySupported = (island.supportCount ?? 0) >= requiredSupports;
  }

  return annotated;
}

