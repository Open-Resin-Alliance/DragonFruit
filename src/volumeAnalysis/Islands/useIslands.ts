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
import { type DetectedIsland, type TipInfo, type OverhangRegion, type Vec3Loop, SUPPORTED_RADIUS_MM } from './types';
import { classifyIntersection } from './intersection';
import { getSnapshot } from '@/supports/state';
import { getSettings } from '@/supports/Settings/state';
import { SpatialHashGrid2D, cellKey } from './spatialHashGrid2D';
import {
  type VoxelFootprint,
  VoxelFootprintBuilder,
  concatFootprints,
  footprintX,
  footprintY,
  isEmptyFootprint,
} from './voxelFootprint';

/** Self-support angle for mesh-normal overhang detection (surfaces flatter
 *  than this from horizontal get supports). Tunable per resin later. */
const OVERHANG_SELF_SUPPORT_ANGLE_DEG = 45;
/** Resolution of the projected-footprint masks emitted by the classifier. */
const OVERHANG_FOOTPRINT_PX_MM = 0.25;

/**
 * Merge overhang regions into the classified island set. The slice-growth
 * detector and the mesh-normal classifier flag the same underside surface (a
 * floating model's whole bottom layer is "unsupported" per the growth rule),
 * so voxel islands substantially covered by an overhang region are dropped in
 * favor of the surface-accurate region. Overhang regions without a voxel
 * counterpart (e.g. lettering ledges below the growth buffer) are appended.
 */
export function mergeOverhangRegions(
  classified: DetectedIsland[],
  overhang: DetectedIsland[],
): DetectedIsland[] {
  if (overhang.length === 0) return classified;
  const covered = new Set<string>();
  for (const v of classified) {
    if (v.source !== 'voxel') continue;
    for (const o of overhang) {
      if (overhangCoversVoxel(o, v)) {
        covered.add(v.id);
        break;
      }
    }
  }
  const remaining = covered.size === 0
    ? classified
    : classified.filter((v) => !covered.has(v.id));
  return [...remaining, ...overhang];
}

/**
 * Map a Rust overhang region to a unified DetectedIsland (source 'overhang').
 * Contact = the footprint pixel with the lowest real surface Z, so the
 * coordinate lies ON the mesh even for sloped/concave regions (a bbox-centre
 * XY paired with region.minZ floats mid-air there). contactVoxels come from
 * the footprint mask so the density grid stage can do containment tests
 * against the exact region shape.
 */
export function overhangRegionToIsland(region: OverhangRegion, i: number): DetectedIsland {
  const { width, height, originX, originY, pxMm, data, surfaceZ } = region.footprint;
  const contactVoxels = new VoxelFootprintBuilder(Math.min(width * height, 4096), true);
  let bestIdx = -1;
  let bestZ = Infinity;
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const idx = row * width + col;
      if (data[idx]) {
        const x = originX + (col + 0.5) * pxMm;
        const y = originY + (row + 0.5) * pxMm;
        const z = surfaceZ[idx];
        contactVoxels.push(x, y, z);
        if (Number.isFinite(z) && z < bestZ) {
          bestZ = z;
          bestIdx = idx;
        }
      }
    }
  }
  // Lowest sampled surface pixel; falls back to the mask centre at
  // region.minZ if the mask or its surface samples are unusable.
  const contactX = bestIdx >= 0 ? originX + ((bestIdx % width) + 0.5) * pxMm : originX + (width * pxMm) / 2;
  const contactY = bestIdx >= 0 ? originY + (Math.floor(bestIdx / width) + 0.5) * pxMm : originY + (height * pxMm) / 2;
  const contactZ = bestIdx >= 0 ? bestZ : region.minZ;
  return {
    id: `o${i}`,
    source: 'overhang' as const,
    contact: new THREE.Vector3(contactX, contactY, contactZ),
    baseZ: contactZ,
    areaMm2: region.projectedAreaMm2,
    overhangAngleDeg: region.angleDeg,
    triangleIds: region.triangleIds,
    surfaceNormal: { x: region.normal[0], y: region.normal[1], z: region.normal[2] },
    contactVoxels: contactVoxels.build(),
    perimeterLoops: region.perimeterLoops,
  };
}

/**
 * True when a voxel island's contact sits inside an overhang region's
 * projected footprint and their areas are comparable — the same physical
 * surface detected by both detectors.
 */
function overhangCoversVoxel(region: DetectedIsland, voxel: DetectedIsland): boolean {
  const vox = region.contactVoxels;
  if (isEmptyFootprint(vox) || !vox) return false;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < vox.count; i++) {
    const px = footprintX(vox, i);
    const py = footprintY(vox, i);
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
  }
  const cx = voxel.contact.x;
  const cy = voxel.contact.y;
  if (cx < minX || cx > maxX || cy < minY || cy > maxY) return false;
  const regionArea = region.areaMm2 ?? 0;
  const voxelArea = voxel.areaMm2 ?? 0;
  if (regionArea <= 0) return false;
  const ratio = voxelArea / regionArea;
  return ratio >= 0.5 && ratio <= 2.0;
}

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

/**
 * Times a derived computation and reports the slow ones to the app log.
 *
 * The scan phases are instrumented in `detect.ts`, but the stretch *after* the
 * scan — the memo cascade that turns raw islands into markers — was invisible,
 * and measurement puts the peak memory and a good fifteen seconds of frozen UI
 * right there. Only slow computations are reported, so the log stays readable.
 */
function timed<T>(label: string, compute: () => T): T {
  const startedAt = performance.now();
  const result = compute();
  const elapsedMs = performance.now() - startedAt;
  if (elapsedMs >= SLOW_STEP_MS) {
    void reportSlowStep(label, elapsedMs);
  }
  return result;
}

/** Below this a step is not worth a log line. */
const SLOW_STEP_MS = 150;

async function reportSlowStep(label: string, elapsedMs: number): Promise<void> {
  const message = `[Islands] step=${label} ms=${Math.round(elapsedMs)}`;
  console.log(message);
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
  try {
    const { info } = await import('@tauri-apps/plugin-log');
    await info(message);
  } catch {
    // Console line stands.
  }
}

export function useIslands({ geom, transform, layerHeightMm, supportTips, plateZ = 0, sourcePath, activeTab }: UseIslandsInput) {
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number; phase?: string; phaseNumber?: number; phaseCount?: number } | null>(null);
  const [voxelIslands, setVoxelIslands] = useState<DetectedIsland[]>([]);
  const [minimaIslands, setMinimaIslands] = useState<DetectedIsland[]>([]);
  const [overhangIslands, setOverhangIslands] = useState<DetectedIsland[]>([]);
  
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
  const [showOverhangs, setShowOverhangs] = useState<boolean>(true);
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
  const [draftShowOverhangs, setDraftShowOverhangs] = useState<boolean>(true);
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

  // World-space transform signature for the scan cache. Island coordinates are
  // world-space, so a cached scan is only valid for the transform it was made
  // under; rotating/repositioning the model must invalidate it.
  const transformKey = [
    transform.position.x, transform.position.y, transform.position.z,
    transform.rotation.x, transform.rotation.y, transform.rotation.z,
    transform.scale.x, transform.scale.y, transform.scale.z,
  ].map((v) => v.toFixed(3)).join(',');
  const cacheKey = sourcePath ? `${sourcePath}|${transformKey}` : null;



  /**
   * Run BOTH detectors on the same world-space positions (one shared transform →
   * one frame → directly comparable for Part C). Voxel uses the scanline worker
   * pool; minima is a single Rust IPC call. A minima failure (e.g. non-Tauri
   * context) is non-fatal — voxel results still stand.
   */
  const onRunScan = useCallback(async () => {
    setScanning(true);
    // Clear any progress left by a previous model's scan — the modal must
    // not show the old "layer X of Y" until this scan reports its own.
    setScanProgress(null);
    const epoch = scanEpochRef.current;
    // Yield immediately so React can flush the "scanning" state and show
    // the progress modal before we start expensive synchronous work.
    await new Promise((resolve) => setTimeout(resolve, 0));
    let usedSideload = false;
    let mappedOverhangs: DetectedIsland[] = [];

    // Overhang classification (mesh-normal) — independent of the slice path.
    // Catches shallow slopes the growth detector can't see (rotated-cube
    // undersides, 11°–45° surfaces). Non-fatal if the command is unavailable
    // (plain-browser context).
    if (sourcePath && geom) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const { listen } = await import('@tauri-apps/api/event');

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

        // The combined Rust scan emits phase progress — wire it into the
        // progress modal so the bar moves immediately (the overhang pass runs
        // inside the same command; no TS geometry round trip up front).
        const unlisten = await listen<{ done: number; total: number }>(
          'island-scan-progress',
          (e) => {
            if (scanEpochRef.current !== epoch) return;
            setScanProgress({ done: e.payload.done, total: e.payload.total });
          },
        );

        if (scanEpochRef.current !== epoch) return;
        setScanProgress({ done: 0, total: 100 });

        console.log(`[Islands] Sideloading combined island scan from path: ${sourcePath}`);
        const combined = await invoke<{ voxelIslands: any[]; minimaIslands: any[]; overhangIslands: any[] }>(
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
            // Overhang classification runs inside the combined command on the
            // already-loaded mesh (the self-support angle is a user knob).
            overhangSelfSupportAngleDeg: getSettings().autoSupport?.overhangSelfSupportAngleDeg
              ?? OVERHANG_SELF_SUPPORT_ANGLE_DEG,
            overhangPxMm: OVERHANG_FOOTPRINT_PX_MM,
          },
        ).finally(() => unlisten());

        // The model may have been deleted/replaced while the command ran —
        // discard results that belong to a superseded scan.
        if (scanEpochRef.current !== epoch) return;

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

        // Overhang triangleIds must index into `geom.geometry` as rendered.
        // The sideload path loads the file separately in Rust and welds with
        // a different epsilon/order than `prepareWorldGeom`/`processGeometry`,
        // so its `triangleIds` point at the wrong geometric triangles
        // (disconnected speckles). Always classify overhang on the frontend
        // world soup where IDs are guaranteed to match the overlay geometry.
        try {
          const world = prepareWorldGeom();
          if (world) {
            // Tauri invoke not available in plain browser, so dynamic import is required.
            const { invoke } = await import('@tauri-apps/api/core');
            const regions = await invoke<OverhangRegion[]>('scan_overhangs', {
              positions: Array.from(world.positions),
              selfSupportAngleDeg:
                getSettings().autoSupport?.overhangSelfSupportAngleDeg ??
                OVERHANG_SELF_SUPPORT_ANGLE_DEG,
              pxMm: OVERHANG_FOOTPRINT_PX_MM,
            });
            if (scanEpochRef.current !== epoch) return;
            mappedOverhangs = regions.map(overhangRegionToIsland);
          } else {
            mappedOverhangs = (combined.overhangIslands ?? []).map(overhangRegionToIsland);
          }
        } catch (err) {
          console.warn('[Islands] frontend overhang scan failed, falling back to sideload overhang', err);
          mappedOverhangs = (combined.overhangIslands ?? []).map(overhangRegionToIsland);
        }
        setOverhangIslands(mappedOverhangs);

        // Cache the scan results for this model + transform
        if (cacheKey) {
          scanCacheRef.current.set(cacheKey, { voxel: voxelMapped, minima: minimaMapped, overhang: mappedOverhangs });
        }

        usedSideload = true;
      } catch (err) {
        console.warn('[Islands] Sideloaded Rust scan failed, falling back to client-side...', err);
      }
    }

    if (!usedSideload) {
      // Mesh prep can throw on a stale/disposed geometry (model deleted or
      // replaced mid-scan). It sits outside the scan's try/finally, so an
      // uncaught throw would strand `scanning` true and freeze the
      // auto-support busy chain. Guard it and cancel cleanly.
      let world: { positions: Float32Array; bbox: THREE.Box3 } | null = null;
      try {
        world = prepareWorldGeom();
      } catch (err) {
        console.warn('[Islands] mesh prep failed; cancelling scan', err);
      }
      if (!world) {
        setScanning(false);
        return;
      }

      // Overhang classification (Rust, positions-based) — the file sideload
      // failed but this command may still be available. Reuses the same world
      // geometry, so no double mesh prep.
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const regions = await invoke<OverhangRegion[]>('scan_overhangs', {
          positions: Array.from(world.positions),
          selfSupportAngleDeg: getSettings().autoSupport?.overhangSelfSupportAngleDeg
            ?? OVERHANG_SELF_SUPPORT_ANGLE_DEG,
          pxMm: OVERHANG_FOOTPRINT_PX_MM,
        });
        if (scanEpochRef.current !== epoch) return;
        mappedOverhangs = regions.map(overhangRegionToIsland);
        setOverhangIslands(mappedOverhangs);
      } catch (err) {
        console.warn('[Islands] overhang scan failed (non-fatal)', err);
        setOverhangIslands([]);
      }

      if (scanEpochRef.current !== epoch) return;
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
        const voxel = await detectVoxelIslands(
          world,
          layerHeightMm,
          params,
          (done, total, phase, phaseNumber, phaseCount) => {
            if (scanEpochRef.current !== epoch) return;
            setScanProgress({ done, total, phase, phaseNumber, phaseCount });
          },
        );
        if (scanEpochRef.current !== epoch) return;
        setVoxelIslands(voxel);

        try {
          const minima = await scanMeshMinima(world.positions, minimaK);
          setMinimaIslands(minima);
          // Cache the scan results for this model + transform
          if (cacheKey) {
            scanCacheRef.current.set(cacheKey, { voxel, minima, overhang: mappedOverhangs });
          }
        } catch (err) {
          console.error('[Islands] mesh-minima scan failed', err);
          setMinimaIslands([]);
          if (cacheKey) {
            scanCacheRef.current.set(cacheKey, { voxel, minima: [], overhang: mappedOverhangs });
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
  const proposedConsolidated = useMemo(() => timed('proposedConsolidated', () => {
    if (!consolidateVoxel) return voxelIslands;
    return consolidateVoxelIslands(voxelIslands, consolidationDistance, pxMm);
  }), [voxelIslands, consolidateVoxel, consolidationDistance, pxMm]);

  const proposedClassified = useMemo(() => {
    return classifyIntersection(proposedConsolidated, minimaIslands, {
      xyToleranceMm: 0.5,
      zBandMm: layerHeightMm,
    });
  }, [proposedConsolidated, minimaIslands, layerHeightMm]);

  // Determine contoured IDs based on proposed list
  const contouredIds = useMemo(() => timed('contouredIds', () => {
    return enableContourRegions
      ? determineContourThreshold(proposedClassified.islands, pxMm, maxContourRegions)
      : new Set<string>();
  }), [proposedClassified.islands, enableContourRegions, pxMm, maxContourRegions]);

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

  const classifiedResult = useMemo(() => timed('classifiedResult', () => {
    return classifyIntersection(finalVoxelIslands, minimaIslands, {
      xyToleranceMm: 0.5,
      zBandMm: layerHeightMm,
    });
  }), [finalVoxelIslands, minimaIslands, layerHeightMm]);

  // Merge overhang regions into the classified set (dedupe + inclusion):
  // the mesh-normal classifier and the slice-growth detector flag the same
  // underside surface, so a voxel island substantially covered by an overhang
  // region is dropped in favor of the surface-accurate region. Overhang
  // islands then flow through annotation, filtering, the list, and
  // auto-support candidate generation.
  const mergedIslands = useMemo(
    () => mergeOverhangRegions(classifiedResult.islands, overhangIslands),
    [classifiedResult, overhangIslands],
  );

  const allIslands = mergedIslands;
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

  // Depends on the islands alone, so it survives every support placement.
  const islandContactGrid = useMemo(() => buildIslandContactGrid(allIslands), [allIslands]);

  const annotatedIslands = useMemo(() => timed('annotatedIslands', () => {
    return annotateAndCountSupports(allIslands, islandContactGrid, mappedSupportTips, plateZ, areaPerSupport, layerHeightMm);
  }), [allIslands, islandContactGrid, mappedSupportTips, plateZ, areaPerSupport, layerHeightMm]);

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
            // Overhang regions render as voxel-style pucks (class stays
            // undefined; only genuine voxel islands must be voxelOnly).
            if (i.source === 'overhang') {
              if (i.grounded && !filterToggles.showPlateContact) return false;
              return !i.supported;
            }
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

  const islandMarkers = useMemo(() => timed('islandMarkers', () => {
    const markers: any[] = [];

    voxelOnlyPucks.markers.forEach(m => {
      const island = voxelOnlyPucks.byMarkerId.get(m.id);
      const area = island?.areaMm2 ?? 0;
      const isOverhang = island?.source === 'overhang';
      // Overhang regions are highlighted as surface meshes (see
      // IslandOverhangOverlay); here they get a small centroid dot so
      // selection/fly-to still works without a huge flat disc.
      const radius = isOverhang
        ? 0.1
        : (scaleMarkersWithArea && area > 0 ? Math.max(0.1, Math.sqrt(area / Math.PI)) : 0.1);

      if (island && !isOverhang && contouredIds.has(island.id) && !isEmptyFootprint(island.contactVoxels)) {
        const contour = generateContourMarkers(island.contactVoxels!, pxMm, m.id, m.baseZ, consolidateVoxel ? 3 : 0);
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
        if (island && contouredIds.has(island.id) && !isEmptyFootprint(island.contactVoxels)) {
          const contourBlue = generateContourMarkers(island.contactVoxels!, pxMm, m.id, m.baseZ, 3);
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
  }), [
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
    setOverhangIslands([]);
    setSelectedMarkerId(null);
  }, []);

  // Per-model scan cache: (sourcePath + transform signature) → { voxel, minima, overhang }.
  const scanCacheRef = useRef<Map<string, { voxel: DetectedIsland[]; minima: DetectedIsland[]; overhang: DetectedIsland[] }>>(new Map());
  const prevSourcePathRef = useRef<string | null | undefined>(undefined);
  // Bumped on every geom/transform change; an in-flight scan captures the
  // epoch and discards its results if the model changed while it ran — a
  // superseded scan must not commit the old model's islands.
  const scanEpochRef = useRef(0);

  // On sourcePath change: restore from cache instead of clearing
  useEffect(() => {
    const prev = prevSourcePathRef.current;
    prevSourcePathRef.current = sourcePath;
    if (!sourcePath || prev === sourcePath) return;

    const cached = cacheKey ? scanCacheRef.current.get(cacheKey) : undefined;
    if (cached) {
      setVoxelIslands(cached.voxel);
      setMinimaIslands(cached.minima);
      setOverhangIslands(cached.overhang ?? []);
      setSelectedMarkerId(null);
      return;
    }

    // No cache entry — clear for new model
    clear();
  }, [sourcePath, cacheKey, clear]);

  // On transform/geom change: always clear (scan is invalidated) and release
  // the scanning flag — an in-flight scan belongs to the old model. If the
  // old scan's async work throws on the stale geometry, its own cleanup never
  // runs, and a stuck `scanning` freezes the auto-support busy chain (the
  // deferred effect waits forever, `autoSupportDrivingScan` stays set, and
  // the Generating/scanning modals stop appearing for the new model).
  useEffect(() => {
    scanEpochRef.current += 1;
    clear();
    setScanning(false);
    setScanProgress(null);
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
      setShowOverhangs(draftShowOverhangs);
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
    draftShowOverhangs,
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
    setDraftShowOverhangs(true);
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
      showOverhangs !== draftShowOverhangs ||
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
    showOverhangs, draftShowOverhangs,
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
    overhangIslands,
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
    showOverhangs,
    setShowOverhangs,
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
    draftShowOverhangs,
    setDraftShowOverhangs,
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

function dilateVoxelGrid(voxels: VoxelFootprint, pxMm: number, consolidationDistance: number): VoxelFootprint {
  if (voxels.count === 0) return voxels;

  const gridSet = new Set<number>();
  const originalCoords: { ix: number; iy: number }[] = [];

  for (let i = 0; i < voxels.count; i++) {
    const ix = Math.round(footprintX(voxels, i) / pxMm);
    const iy = Math.round(footprintY(voxels, i) / pxMm);
    const key = cellKey(ix, iy);
    if (!gridSet.has(key)) {
      gridSet.add(key);
      originalCoords.push({ ix, iy });
    }
  }

  const rPix = Math.max(1, Math.round(consolidationDistance / (2 * pxMm)));
  const dilatedSet = new Set<number>();
  const dilatedVoxels = new VoxelFootprintBuilder(originalCoords.length);

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
      const nkey = cellKey(nix, niy);
      if (!dilatedSet.has(nkey)) {
        dilatedSet.add(nkey);
        dilatedVoxels.push(nix * pxMm, niy * pxMm);
      }
    }
  }

  return dilatedVoxels.build();
}

export function consolidateVoxelIslands(islands: DetectedIsland[], epsilonMm: number, pxMm: number): DetectedIsland[] {
  const n = islands.length;
  if (n === 0) return [];
  
  const minAreaForContour = 0.06; // mm² (resolution-invariant)

  if (n === 1) {
    const single = { ...islands[0] };
    if ((single.areaMm2 ?? 0) >= minAreaForContour && !isEmptyFootprint(single.contactVoxels)) {
      const dilated = dilateVoxelGrid(single.contactVoxels!, pxMm, epsilonMm);
      single.contactVoxels = dilated;
      single.areaMm2 = dilated.count * pxMm * pxMm;
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
      const memberFootprints: VoxelFootprint[] = [];
      for (const m of members) {
        sumX += m.contact.x;
        sumY += m.contact.y;
        totalArea += m.areaMm2 ?? 0;
        if (m.layerSpan) {
          minFirstLayer = Math.min(minFirstLayer, m.layerSpan[0]);
          maxLastLayer = Math.max(maxLastLayer, m.layerSpan[1]);
        }
        if (m.contactVoxels) {
          memberFootprints.push(m.contactVoxels);
        }
      }

      const mergedFootprint = concatFootprints(memberFootprints);
      const dilatedVoxels = mergedFootprint.count > 0
        ? dilateVoxelGrid(mergedFootprint, pxMm, epsilonMm)
        : undefined;

      const finalArea = (dilatedVoxels && dilatedVoxels.count > 0)
        ? dilatedVoxels.count * pxMm * pxMm
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
      !isEmptyFootprint(i.contactVoxels)
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

/**
 * Contours are a pure function of an island's own voxels and the four scalars
 * below — never of the support tips, the visibility toggles or the other
 * islands. But they were being regenerated inside the marker memo, so flipping
 * any island checkbox re-contoured every island from scratch.
 *
 * Keyed by the voxel array's identity so a rescan invalidates naturally: a new
 * scan produces new arrays, and the old entries die with them. Island ids alone
 * would be unsafe, since a rescan reuses them for different geometry.
 */
const contourCache = new WeakMap<VoxelFootprint, Map<string, ContourMarker[]>>();

export function generateContourMarkers(
  voxels: VoxelFootprint,
  pxMm: number,
  islandId: number,
  baseZ: number,
  type: number
): ContourMarker[] {
  if (voxels.count === 0) return [];

  const variantKey = `${pxMm}|${islandId}|${baseZ}|${type}`;
  let variants = contourCache.get(voxels);
  const cached = variants?.get(variantKey);
  // Copied out: at most 30 markers, and callers are free to mutate what they
  // get without corrupting the cache.
  if (cached) return cached.map((marker) => ({ ...marker }));

  const markers = computeContourMarkers(voxels, pxMm, islandId, baseZ, type);

  if (!variants) {
    variants = new Map();
    contourCache.set(voxels, variants);
  }
  variants.set(variantKey, markers);

  return markers.map((marker) => ({ ...marker }));
}

function computeContourMarkers(
  voxels: VoxelFootprint,
  pxMm: number,
  islandId: number,
  baseZ: number,
  type: number
): ContourMarker[] {
  const markers: ContourMarker[] = [];

  const R_small = Math.max(0.12, pxMm * 1.5);
  const R_large = pxMm * 3.5;
  const R_small2 = R_small * R_small;
  const R_large2 = R_large * R_large;

  // Map voxels to a coordinate lookup Set for classification. Numeric keys, not
  // `"gx,gy"` strings: this Set is probed nine times per voxel just below, and
  // each template literal would allocate a rope string destined straight for the
  // garbage collector.
  const voxelSet = new Set<number>();
  for (let i = 0; i < voxels.count; i++) {
    voxelSet.add(cellKey(Math.round(footprintX(voxels, i) / pxMm), Math.round(footprintY(voxels, i) / pxMm)));
  }

  // Classify into interior vs boundary
  const classified = Array.from({ length: voxels.count }, (_, i) => {
    const vx = footprintX(voxels, i);
    const vy = footprintY(voxels, i);
    const gx = Math.round(vx / pxMm);
    const gy = Math.round(vy / pxMm);
    let isInterior = true;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        if (!voxelSet.has(cellKey(gx + dx, gy + dy))) {
          isInterior = false;
          break;
        }
      }
      if (!isInterior) break;
    }
    return {
      x: vx,
      y: vy,
      isInterior,
      covered: false,
      // Filled in with the bucket keys below, so marking a voxel covered can
      // decrement the per-bucket tallies instead of forcing a rescan.
      largeKey: 0,
      smallKey: 0,
    };
  });

  // Build spatial grid with cell size = R_small for O(1) coverage marking
  const cellSize = R_small;
  const grid = new Map<number, typeof classified[number][]>();
  for (const v of classified) {
    const cx = Math.floor(v.x / cellSize);
    const cy = Math.floor(v.y / cellSize);
    const key = cellKey(cx, cy);
    let list = grid.get(key);
    if (!list) {
      list = [];
      grid.set(key, list);
    }
    list.push(v);
  }

  /**
   * Uncovered voxels per placement bucket, kept current as coverage spreads.
   *
   * Choosing where to put the next marker means finding the bucket with the
   * most uncovered voxels. Recomputing that by walking every voxel on every
   * step cost up to forty-five full passes over the island — 11 seconds of
   * frozen UI across a model's islands. Maintaining the tallies turns each
   * step into a walk over buckets, of which there are orders of magnitude
   * fewer.
   */
  const largeUncovered = new Map<number, number>();
  const smallUncovered = new Map<number, number>();

  function decrementBucket(tally: Map<number, number>, key: number): void {
    const count = tally.get(key);
    if (count === undefined) return;
    if (count <= 1) tally.delete(key);
    else tally.set(key, count - 1);
  }

  /** Bucket key with the highest tally, or null when everything is covered. */
  function bestBucket(tally: Map<number, number>): { key: number; count: number } | null {
    let bestKey: number | null = null;
    let bestCount = 0;
    for (const [key, count] of tally) {
      if (count > bestCount) {
        bestCount = count;
        bestKey = key;
      }
    }
    return bestKey === null ? null : { key: bestKey, count: bestCount };
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
        const list = grid.get(cellKey(cx, cy));
        if (!list) continue;
        for (const v of list) {
          if (v.covered) continue;
          const dx = v.x - centerX;
          const dy = v.y - centerY;
          if (dx * dx + dy * dy <= r2) {
            v.covered = true;
            newlyCovered++;
            decrementBucket(largeUncovered, v.largeKey);
            decrementBucket(smallUncovered, v.smallKey);
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
  const largeGrid = new Map<number, typeof classified[number][]>();
  for (const v of classified) {
    if (!v.isInterior) continue;
    const cx = Math.floor(v.x / R_large);
    const cy = Math.floor(v.y / R_large);
    const key = cellKey(cx, cy);
    let list = largeGrid.get(key);
    if (!list) {
      list = [];
      largeGrid.set(key, list);
    }
    list.push(v);
    v.largeKey = key;
    largeUncovered.set(key, (largeUncovered.get(key) ?? 0) + 1);
  }

  for (let step = 0; step < maxLargeMarkers; step++) {
    const best = bestBucket(largeUncovered);
    if (best === null) {
      break;
    }

    const list = largeGrid.get(best.key)!;
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
  const smallGrid = new Map<number, typeof classified[number][]>();
  for (const v of classified) {
    const cx = Math.floor(v.x / R_small);
    const cy = Math.floor(v.y / R_small);
    const key = cellKey(cx, cy);
    let list = smallGrid.get(key);
    if (!list) {
      list = [];
      smallGrid.set(key, list);
    }
    list.push(v);
    v.smallKey = key;
    // Built after the large pass has already covered part of the island, so
    // only voxels still uncovered may count towards the tally.
    if (!v.covered) {
      smallUncovered.set(key, (smallUncovered.get(key) ?? 0) + 1);
    }
  }

  const maxSmallSteps = maxTotalMarkers - markers.length;
  for (let step = 0; step < maxSmallSteps; step++) {
    const best = bestBucket(smallUncovered);
    if (best === null) {
      break;
    }

    const list = smallGrid.get(best.key)!;
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

interface IslandGridEntry {
  islandIndex: number;
  x: number;
  y: number;
  z: number;
}

/**
 * Indexes every contact voxel of every island for tip proximity queries.
 *
 * Kept separate from {@link annotateAndCountSupports} because it depends only on
 * the islands: placing a single support changes the tips, not the geometry, and
 * rebuilding this grid over hundreds of thousands of voxels on every placement
 * was the bulk of the freeze after each click. Entry indices refer to positions
 * in `islands`, which `annotateAndCountSupports` preserves.
 */
function buildIslandContactGrid(islands: DetectedIsland[]): SpatialHashGrid2D<IslandGridEntry> {
  const grid = new SpatialHashGrid2D<IslandGridEntry>(1.0);
  islands.forEach((island, islandIndex) => {
    const z = island.contact.z;
    const footprint = island.contactVoxels;
    if (footprint && footprint.count > 0) {
      for (let i = 0; i < footprint.count; i++) {
        const vx = footprintX(footprint, i);
        const vy = footprintY(footprint, i);
        grid.insert(vx, vy, { islandIndex, x: vx, y: vy, z });
      }
    } else {
      grid.insert(island.contact.x, island.contact.y, { islandIndex, x: island.contact.x, y: island.contact.y, z });
    }
  });
  return grid;
}

function annotateAndCountSupports(
  islands: DetectedIsland[],
  grid: SpatialHashGrid2D<IslandGridEntry>,
  supportTips: TipInfo[],
  plateZ: number,
  areaPerSupport: number,
  layerHeightMm?: number,
): DetectedIsland[] {
  const annotated = annotateFilterFlags(islands.map((i) => ({ ...i })), { supportTips, plateZ, layerHeightMm });

  for (const island of annotated) {
    island.supportCount = 0;
  }

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

