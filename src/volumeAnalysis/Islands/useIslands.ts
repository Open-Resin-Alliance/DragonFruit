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
import type { DetectedIsland } from './types';
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
}

export type UseIslandsReturn = ReturnType<typeof useIslands>;

export function useIslands({ geom, transform, layerHeightMm, supportTips, plateZ = 0, sourcePath }: UseIslandsInput) {
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

  // Voxel + mesh-minima, unified. (Part C) adds intersection classification here.
  const classifiedResult = useMemo(() => {
    return classifyIntersection(voxelIslands, minimaIslands, {
      xyToleranceMm: 0.5,
      zBandMm: layerHeightMm,
    });
  }, [voxelIslands, minimaIslands, layerHeightMm]);

  const allIslands = classifiedResult.islands;
  const stats = classifiedResult.stats;

  // Annotate supported/grounded flags, then apply the visibility toggles. Work on
  // shallow copies so React state objects aren't mutated (contact Vector3 is shared, never mutated).
  const filteredIslands = useMemo(() => {
    const annotated = annotateFilterFlags(allIslands.map((i) => ({ ...i })), { supportTips, plateZ });
    return applyFilter(annotated, filterToggles);
  }, [allIslands, supportTips, plateZ, filterToggles]);

  // Cluster-walk ordering for the list / ←/→ navigation (Euclidean only).
  const orderedIslands = useMemo(() => {
    return clusterWalkOrder(filteredIslands.map((i) => ({ ...i })), {
      epsilonMm: Math.max(8, pxMm * 40),
    });
  }, [filteredIslands, pxMm]);

  // Per-source pucks for the IslandOverlay layers (blue voxel-only / green minima-only / red intersection).
  const voxelOnlyPucks = useMemo(
    () => buildIslandPucks(filteredIslands.filter((i) => i.source === 'voxel' && i.class === 'voxelOnly')),
    [filteredIslands],
  );
  const minimaOnlyPucks = useMemo(
    () => buildIslandPucks(filteredIslands.filter((i) => i.source === 'minima' && i.class === 'minimaOnly')),
    [filteredIslands],
  );
  const intersectionPucks = useMemo(
    () => buildIslandPucks(filteredIslands.filter((i) => i.class === 'intersection' && i.source === 'voxel')),
    [filteredIslands],
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

  const clear = useCallback(() => {
    setVoxelIslands([]);
    setMinimaIslands([]);
    setSelectedMarkerId(null);
  }, []);

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
  };
}
