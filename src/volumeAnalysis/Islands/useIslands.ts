import { useState, useCallback, useMemo } from 'react';
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
import { buildIslandPucks } from './islandPuckMarkers';
import type { DetectedIsland } from './types';

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
}

export type UseIslandsReturn = ReturnType<typeof useIslands>;

export function useIslands({ geom, transform, layerHeightMm, supportTips, plateZ = 0 }: UseIslandsInput) {
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number } | null>(null);
  const [voxelIslands, setVoxelIslands] = useState<DetectedIsland[]>([]);
  // (Part B) minimaIslands; (Part C) intersection classification.

  // Scan params (surfaced in the advanced modal).
  const [pxMm, setPxMm] = useState(0.05);
  const [supportBufMm, setSupportBufMm] = useState(0.25);
  const [connectivity, setConnectivity] = useState<4 | 8>(4);

  // Filter toggles — default ON ⇒ supported/grounded islands hidden (and skipped by ←/→).
  const [filterToggles, setFilterToggles] = useState<IslandFilterToggles>(DEFAULT_FILTER_TOGGLES);

  // Overlay visibility (Part A: voxel blue only; B/C add green minima / red intersection / exclusions).
  const [showVoxel, setShowVoxel] = useState(true);

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

  const onRunVoxelScan = useCallback(async () => {
    const world = prepareWorldGeom();
    if (!world) return;
    setScanning(true);
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
      const result = await detectVoxelIslands(world, layerHeightMm, params, (done, total) =>
        setScanProgress({ done, total }),
      );
      setVoxelIslands(result);
    } finally {
      setScanning(false);
    }
  }, [prepareWorldGeom, layerHeightMm, pxMm, supportBufMm, connectivity]);

  // Part A: voxel only. (Part C) const allIslands = [...voxelIslands, ...minimaIslands] + classify.
  const allIslands = voxelIslands;

  // Annotate supported/grounded flags, then apply the visibility toggles. Work on
  // shallow copies so React state objects aren't mutated (contact Vector3 is shared, never mutated).
  const filteredIslands = useMemo(() => {
    const annotated = annotateFilterFlags(allIslands.map((i) => ({ ...i })), { supportTips, plateZ });
    return applyFilter(annotated, filterToggles);
  }, [allIslands, supportTips, plateZ, filterToggles]);

  // Cluster-walk ordering for the list / ←/→ navigation (Euclidean; co-visibility added in Part C).
  const orderedIslands = useMemo(
    () => clusterWalkOrder(filteredIslands.map((i) => ({ ...i })), { epsilonMm: Math.max(2, pxMm * 20) }),
    [filteredIslands, pxMm],
  );

  // Blue voxel pucks for the IslandOverlay layer.
  const voxelPucks = useMemo(
    () => buildIslandPucks(filteredIslands.filter((i) => i.source === 'voxel')),
    [filteredIslands],
  );

  const clear = useCallback(() => {
    setVoxelIslands([]);
    setSelectedMarkerId(null);
  }, []);

  return {
    scanning,
    scanProgress,
    voxelIslands,
    filteredIslands,
    orderedIslands,
    voxelPucks,
    pxMm,
    setPxMm,
    supportBufMm,
    setSupportBufMm,
    connectivity,
    setConnectivity,
    filterToggles,
    setFilterToggles,
    showVoxel,
    setShowVoxel,
    selectedMarkerId,
    setSelectedMarkerId,
    onRunVoxelScan,
    clear,
  };
}
