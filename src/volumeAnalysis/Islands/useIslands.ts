import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import { quaternionFromGlobalEuler } from '@/utils/rotation';
import { remapOverhangTriangleIds } from './remapOverhangTriangles';
import { detectVoxelIslands, type VoxelDetectParams } from './detect';
import { contactEndpointsFor, SUPPORT_TYPES } from '@/supports/supportTypeRegistry';
import {
  applyFilter,
  DEFAULT_FILTER_TOGGLES, isIslandEffectivelySupported,
  type IslandFilterOptions, type IslandFilterToggles,
} from './filtering';
import { annotateAndCountSupports, buildIslandContactGrid, scanNeedsCoverage } from './contactGrid';
import { clusterWalkOrder } from './ordering';
import { buildIslandPucks, markerIdFor } from './islandPuckMarkers';
import { buildIslandInstances, VOXEL_DISC_RADIUS_FACTOR, type IslandVisual } from './islandInstances';
import type { IslandMarker } from '@/volumeAnalysis/IslandScan/islandOverlayLogic';
import { scanMeshMinima } from './meshMinima';
import { type DetectedIsland, type TipInfo, type OverhangRegion, type OverhangScan, type PoseStabilityWire, type Vec3Loop, SUPPORTED_RADIUS_MM } from './types';
import { classifyIntersection, type ClassifiedIslands, type IntersectionStats } from './intersection';
import { getSnapshot } from '@/supports/state';
import { getSettings } from '@/supports/Settings/state';
import { cellKey } from './spatialHashGrid2D';
import {
  type VoxelFootprint,
  VoxelFootprintBuilder,
  footprintX,
  footprintY,
  footprintZ,
  isEmptyFootprint,
} from './voxelFootprint';

export { scanNeedsCoverage };

/** Self-support angle for mesh-normal overhang detection (surfaces flatter
 *  than this from horizontal get supports). Tunable per resin later. */
const OVERHANG_SELF_SUPPORT_ANGLE_DEG = 45;
/** Resolution of the projected-footprint masks emitted by the classifier. */
const OVERHANG_FOOTPRINT_PX_MM = 0.25;

export interface OverhangMergeOptions {
  voxelPxMm?: number;
  layerHeightMm?: number;
  overhangPxMm?: number;
}

function gridBucketKey(bx: number, by: number): number | string {
  if (Math.abs(bx) <= 30000 && Math.abs(by) <= 30000) {
    return cellKey(bx, by);
  }
  return `${bx},${by}`;
}

interface RegionCoverIndex {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  bucketSize: number;
  head: Map<number | string, number> | null;
  next: Int32Array | null;
}

function createRegionCoverIndex(region: DetectedIsland, bucketSize: number): RegionCoverIndex | null {
  const vox = region.contactVoxels;
  if (!vox || isEmptyFootprint(vox)) return null;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < vox.count; i++) {
    const px = footprintX(vox, i);
    const py = footprintY(vox, i);
    const pz = footprintZ(vox, i) ?? region.baseZ;
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (pz < minZ) minZ = pz;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
    if (pz > maxZ) maxZ = pz;
  }
  return {
    minX,
    maxX,
    minY,
    maxY,
    minZ,
    maxZ,
    bucketSize: bucketSize > 1e-9 ? bucketSize : 1e-9,
    head: null,
    next: null,
  };
}

function ensureRegionSpatialHash(region: DetectedIsland, idx: RegionCoverIndex): void {
  if (idx.head !== null) return;
  const vox = region.contactVoxels!;
  const head = new Map<number | string, number>();
  const next = new Int32Array(vox.count);
  next.fill(-1);
  const bs = idx.bucketSize;
  for (let i = 0; i < vox.count; i++) {
    const rx = footprintX(vox, i);
    const ry = footprintY(vox, i);
    const key = gridBucketKey(Math.floor(rx / bs), Math.floor(ry / bs));
    const prev = head.get(key);
    if (prev !== undefined) next[i] = prev;
    head.set(key, i);
  }
  idx.head = head;
  idx.next = next;
}

function pointCoveredByRegion(
  region: DetectedIsland,
  idx: RegionCoverIndex,
  qx: number,
  qy: number,
  qz: number,
  xyMargin2: number,
  zMargin: number,
): boolean {
  if (!Number.isFinite(qx) || !Number.isFinite(qy) || !Number.isFinite(qz)) return false;
  ensureRegionSpatialHash(region, idx);
  const vox = region.contactVoxels!;
  const head = idx.head!;
  const next = idx.next!;
  const bs = idx.bucketSize;
  const bx = Math.floor(qx / bs);
  const by = Math.floor(qy / bs);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      let i = head.get(gridBucketKey(bx + dx, by + dy));
      while (i !== undefined && i !== -1) {
        const rx = footprintX(vox, i);
        const ry = footprintY(vox, i);
        const ddx = rx - qx;
        const ddy = ry - qy;
        if (ddx * ddx + ddy * ddy <= xyMargin2) {
          const rz = footprintZ(vox, i) ?? region.baseZ;
          if (Math.abs(qz - rz) <= zMargin) return true;
        }
        i = next[i];
      }
    }
  }
  return false;
}

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
  opts: OverhangMergeOptions = {},
): DetectedIsland[] {
  if (overhang.length === 0) return classified;
  const voxelPxMm = opts.voxelPxMm ?? 0.05;
  const layerHeightMm = opts.layerHeightMm ?? 0.05;
  const overhangPxMm = opts.overhangPxMm ?? OVERHANG_FOOTPRINT_PX_MM;
  const normalizedOpts: Required<OverhangMergeOptions> = {
    voxelPxMm,
    layerHeightMm,
    overhangPxMm,
  };
  const xyMargin = overhangPxMm + voxelPxMm;
  const regionIndices = overhang.map((o) => createRegionCoverIndex(o, xyMargin));

  const remaining: DetectedIsland[] = [];
  for (const item of classified) {
    let coveringOverhangId: string | undefined;
    if (item.source === 'voxel' || item.source === 'minima') {
      for (let oi = 0; oi < overhang.length; oi++) {
        if (overhangCoversVoxel(overhang[oi], item, normalizedOpts, regionIndices[oi])) {
          coveringOverhangId = overhang[oi].id;
          break;
        }
      }
    }

    // Protect all isDetached voxel islands and all intersection islands;
    // yield only covered non-detached, non-intersection CantileverFringe voxel islands.
    if (
      coveringOverhangId !== undefined &&
      item.source === 'voxel' &&
      !item.isDetached &&
      item.class !== 'intersection'
    ) {
      continue;
    }

    if (coveringOverhangId !== undefined) {
      remaining.push({ ...item, coveredByOverhangId: coveringOverhangId });
    } else {
      remaining.push(item);
    }
  }

  return [...remaining, ...overhang];
}

export function mergeOverhangResults(
  classifiedResult: ClassifiedIslands,
  overhang: DetectedIsland[],
  opts: OverhangMergeOptions = {},
): ClassifiedIslands {
  if (overhang.length === 0) return classifiedResult;
  const islands = mergeOverhangRegions(classifiedResult.islands, overhang, opts);
  let voxelTotal = 0;
  let minimaTotal = 0;
  let matched = 0;
  let voxelOnly = 0;
  let minimaOnly = 0;
  for (const item of islands) {
    if (item.source === 'voxel') {
      voxelTotal++;
      if (item.class === 'intersection') {
        matched++;
      } else if (item.class === 'voxelOnly') {
        voxelOnly++;
      }
    } else if (item.source === 'minima') {
      minimaTotal++;
      if (item.class === 'minimaOnly') minimaOnly++;
    }
  }
  const meanMatchOffsetMm =
    matched === 0 ? 0 : classifiedResult.stats.meanMatchOffsetMm;
  const stats: IntersectionStats = {
    voxelTotal,
    minimaTotal,
    matched,
    voxelOnly,
    minimaOnly,
    minimaSupersetOfVoxel: voxelTotal > 0 && voxelOnly === 0,
    voxelSupersetOfMinima: minimaTotal > 0 && minimaOnly === 0,
    meanMatchOffsetMm,
  };
  return { islands, stats };
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
    surfaceAreaMm2: region.areaMm2,
    maxZ: region.maxZ,
    dragMomentMm3: region.dragMomentMm3,
    dragDirDeg: region.dragDirDeg,
    steepFlat: region.steepFlat,
    triangleIds: region.triangleIds,
    surfaceNormal: { x: region.normal[0], y: region.normal[1], z: region.normal[2] },
    contactVoxels: contactVoxels.build(),
    perimeterLoops: region.perimeterLoops,
  };
}

/**
 * True when a voxel island's contact or >= 50% of its footprint sits inside
 * an overhang region's projected footprint within XY/Z grid margins and without
 * exceeding the region area upper bound — the same physical surface detected
 * by both detectors.
 */
function overhangCoversVoxel(
  region: DetectedIsland,
  voxel: DetectedIsland,
  opts: OverhangMergeOptions = {},
  regionIndex?: RegionCoverIndex | null,
): boolean {
  const vox = region.contactVoxels;
  if (!vox || isEmptyFootprint(vox)) return false;

  const regionArea = region.areaMm2 ?? 0;
  const voxelArea = voxel.areaMm2 ?? 0;
  if (regionArea <= 0 || voxelArea > 2.0 * regionArea) return false;

  const voxelPxMm = opts.voxelPxMm ?? 0.05;
  const layerHeightMm = opts.layerHeightMm ?? 0.05;
  const ohPxMm = opts.overhangPxMm ?? OVERHANG_FOOTPRINT_PX_MM;
  const xyMargin = ohPxMm + voxelPxMm;
  const xyMargin2 = xyMargin * xyMargin;
  const zMargin = 2 * layerHeightMm + ohPxMm;

  const idx = regionIndex !== undefined ? regionIndex : createRegionCoverIndex(region, xyMargin);
  if (!idx) return false;

  const { minX, maxX, minY, maxY, minZ, maxZ } = idx;
  const cx = voxel.contact.x;
  const cy = voxel.contact.y;
  const cz = voxel.baseZ;
  const clampedContactZ = Math.min(maxZ, Math.max(minZ, cz));
  const contactInExpandedAabb =
    cx >= minX - xyMargin &&
    cx <= maxX + xyMargin &&
    cy >= minY - xyMargin &&
    cy <= maxY + xyMargin &&
    Math.abs(cz - clampedContactZ) <= zMargin;

  const voxFootprint = voxel.contactVoxels;
  if (!voxFootprint || voxFootprint.count === 0) {
    if (!contactInExpandedAabb) return false;
    return pointCoveredByRegion(region, idx, cx, cy, cz, xyMargin2, zMargin);
  }

  if (!contactInExpandedAabb) {
    if (voxFootprint.z === null && Math.abs(cz - clampedContactZ) > zMargin) {
      return false;
    }
    const vCount = voxFootprint.count;
    const needed = Math.ceil(vCount / 2);
    let inAabbCount = 0;
    for (let k = 0; k < vCount; k++) {
      const fx = footprintX(voxFootprint, k);
      const fy = footprintY(voxFootprint, k);
      const fz = footprintZ(voxFootprint, k) ?? cz;
      const clampedFz = Math.min(maxZ, Math.max(minZ, fz));
      if (
        fx >= minX - xyMargin &&
        fx <= maxX + xyMargin &&
        fy >= minY - xyMargin &&
        fy <= maxY + xyMargin &&
        Math.abs(fz - clampedFz) <= zMargin
      ) {
        inAabbCount++;
        if (inAabbCount >= needed) break;
      } else if (inAabbCount + (vCount - k - 1) < needed) {
        return false;
      }
    }
    if (inAabbCount < needed) return false;
  }

  if (contactInExpandedAabb && pointCoveredByRegion(region, idx, cx, cy, cz, xyMargin2, zMargin)) {
    return true;
  }

  const vCount = voxFootprint.count;
  const needed = Math.ceil(vCount / 2);
  let coveredCount = 0;
  for (let k = 0; k < vCount; k++) {
    const fx = footprintX(voxFootprint, k);
    const fy = footprintY(voxFootprint, k);
    const fz = footprintZ(voxFootprint, k) ?? cz;
    if (pointCoveredByRegion(region, idx, fx, fy, fz, xyMargin2, zMargin)) {
      coveredCount++;
      if (coveredCount >= needed) return true;
    } else if (coveredCount + (vCount - k - 1) < needed) {
      return false;
    }
  }
  return coveredCount * 2 >= vCount;
}

export function resolveVoxelVisualType(
  island: DetectedIsland | undefined,
  consolidateVoxel: boolean,
  contouredIds: ReadonlySet<string>,
): number {
  if (island?.source === 'overhang') return 0;
  return consolidateVoxel && island && ((island.members?.length ?? 0) > 1 || contouredIds.has(island.id))
    ? 3
    : 0;
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
  /** Unique scene model id so duplicated models with matching sourcePath do not share cache entries. */
  modelId?: string | null;
  /** File path of the loaded model. */
  sourcePath?: string | null;
  /** True when the print gets a raft under it. The stability report then
   *  measures the contact as the model's XY shadow rather than its own contact
   *  band: the raft is what actually holds the part, and a band on a domed
   *  bottom is a cap whose centre wanders with the tilt. */
  hasRaft?: boolean;
  /** Active mode / tab. */
  activeTab?: string;
}

export type UseIslandsReturn = ReturnType<typeof useIslands>;

type CachedScan = {
  voxel: DetectedIsland[];
  minima: DetectedIsland[];
  overhang: DetectedIsland[];
  toppleCoverage: boolean;
  dragTotalMm3: number;
};

type CombinedNativeScanResult = {
  voxelIslands: Array<{
    id: string;
    contact: { x: number; y: number; z: number };
    baseZ: number;
    rawBaseZ?: number;
    areaMm2?: number;
    peakAreaMm2?: number;
    maxAreaMm2?: number;
    isDetached?: boolean;
    layerSpan: [number, number];
    contactVoxels?: number[];
  }>;
  minimaIslands: Array<{
    position: { x: number; y: number; z: number };
    vertexIndex?: number;
    seedTriangleId?: number;
  }>;
  overhangIslands: OverhangRegion[];
  stability?: PoseStabilityWire | null;
};

function hasTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ != null
  );
}

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
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[IslandsPerf] step=${label} ms=${elapsedMs.toFixed(1)}`);
    }
    void reportSlowStep(label, elapsedMs);
  }
  return result;
}

/** Below this a step is not worth a log line. */
const SLOW_STEP_MS = 150;

async function reportSlowStep(label: string, elapsedMs: number): Promise<void> {
  const message = `[Islands] step=${label} ms=${Math.round(elapsedMs)}`;
  console.log(message);
  if (!hasTauriRuntime()) return;
  try {
    const { info } = await import('@tauri-apps/plugin-log');
    await info(message);
  } catch {
    // Console line stands.
  }
}

export function useIslands({ geom, transform, layerHeightMm, supportTips, plateZ = 0, modelId, sourcePath, activeTab, hasRaft = false }: UseIslandsInput) {
  const [scanning, setScanning] = useState(false);
  const [hasScanned, setHasScanned] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number; phase?: string; phaseNumber?: number; phaseCount?: number } | null>(null);
  const [voxelIslands, setVoxelIslands] = useState<DetectedIsland[]>([]);
  const [minimaIslands, setMinimaIslands] = useState<DetectedIsland[]>([]);
  const [overhangIslands, setOverhangIslands] = useState<DetectedIsland[]>([]);
  /** Whether this scan's pose needs anti-topple contact. The overlay uses it to
   *  show what will be covered, not everything that was classified. */
  const [toppleCoverage, setToppleCoverage] = useState(true);
  /** The pose's total drag moment, so the overlay can weigh a patch's share of
   *  it exactly as the placement does. */
  const [dragTotalMm3, setDragTotalMm3] = useState(0);
  
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
  const [connectivity, setConnectivity] = useState<4 | 8>(8);
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
  const [draftConnectivity, setDraftConnectivity] = useState<4 | 8>(8);
  const [draftConsolidateVoxel, setDraftConsolidateVoxel] = useState<boolean>(false);
  const [draftConsolidationDistance, setDraftConsolidationDistance] = useState<number>(0.2);
  const [draftReduceIntersection, setDraftReduceIntersection] = useState<boolean>(false);
  const [draftIntersectionThreshold, setDraftIntersectionThreshold] = useState<number>(0.5);
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
  // Display-only: gates the expert layer toggles in the panel. Immediate,
  // like the overlay visibility above — not a draft setting, nothing to apply.
  const [advancedMode, setAdvancedMode] = useState<boolean>(false);

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
        if (matrix.determinant() < 0) {
          for (let i = 0; i + 8 < positions.length; i += 9) {
            for (let k = 0; k < 3; k++) {
              const tmp = positions[i + 3 + k];
              positions[i + 3 + k] = positions[i + 6 + k];
              positions[i + 6 + k] = tmp;
            }
          }
        }
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
   * Build pre-TRS local triangle-soup positions + TRS matrix + local center
   * so Rust welds at `1e-6` in pose-invariant local space before applying
   * `translate(-center) -> matrix` + `det3 < 0` winding flip.
   */
  const prepareLocalGeom = useCallback((): {
    positions: Float32Array;
    matrix: number[];
    center: [number, number, number];
  } | null => {
    if (!geom) return null;
    const g = geom.geometry;
    const bb = g.boundingBox ?? new THREE.Box3().setFromBufferAttribute(g.getAttribute('position') as THREE.BufferAttribute);
    const center = bb.getCenter(new THREE.Vector3());
    const matrix = new THREE.Matrix4().compose(
      transform.position.clone(),
      quaternionFromGlobalEuler(transform.rotation),
      transform.scale.clone(),
    );
    const soup = g.index ? g.toNonIndexed() : g;
    try {
      const positions = (soup.getAttribute('position').array as Float32Array).slice();
      return {
        positions,
        matrix: Array.from(matrix.elements),
        center: [center.x, center.y, center.z],
      };
    } finally {
      if (soup !== g) {
        soup.dispose();
      }
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
  const cacheKey = geom
    ? `${modelId ?? sourcePath ?? ''}|${geom.geometry?.uuid ?? ''}|${transformKey}`
    : null;



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
    const epoch = ++scanEpochRef.current;
    const perf = { start: performance.now(), prep: 0, stage: 0, scan: 0, commit: 0, path: 'none' };
    const mark = (key: 'prep' | 'stage' | 'scan' | 'commit', from: number) => {
      perf[key] += performance.now() - from;
    };

    const commitCombinedResult = (combined: CombinedNativeScanResult) => {
      const commitStart = performance.now();
      const voxelMapped: DetectedIsland[] = combined.voxelIslands
        .filter((v) => {
          const peak = v.peakAreaMm2 ?? v.maxAreaMm2 ?? v.areaMm2 ?? 0;
          return (v.isDetached && peak > 0) || peak >= minAreaMm2;
        })
        .map((v) => ({
          id: v.id,
          source: 'voxel',
          contact: new THREE.Vector3(v.contact.x, v.contact.y, v.contact.z),
          baseZ: v.baseZ,
          rawBaseZ: v.rawBaseZ,
          areaMm2: v.areaMm2,
          peakAreaMm2: v.peakAreaMm2 ?? v.maxAreaMm2,
          isDetached: v.isDetached,
          layerSpan: v.layerSpan,
          contactVoxels: v.contactVoxels && v.contactVoxels.length >= 2
            ? { xy: new Float32Array(v.contactVoxels), z: null, count: v.contactVoxels.length / 2 }
            : undefined,
        }));
      const minimaMapped: DetectedIsland[] = combined.minimaIslands.map((m, i) => ({
        id: `m${i}`,
        source: 'minima',
        contact: new THREE.Vector3(m.position.x, m.position.y, m.position.z),
        baseZ: m.position.z,
        vertexIndex: m.vertexIndex,
        seedTriangleId: m.seedTriangleId,
      }));
      const overhangMapped = remapOverhangTriangleIds(
        combined.overhangIslands ?? [],
        geom?.geometry,
        transform,
      ).map(overhangRegionToIsland);
      const topple = scanNeedsCoverage(combined.stability);
      const drag = combined.stability?.dragMomentMm3 ?? 0;

      setVoxelIslands(voxelMapped);
      setMinimaIslands(minimaMapped);
      setToppleCoverage(topple);
      setDragTotalMm3(drag);
      setOverhangIslands(overhangMapped);
      setHasScanned(true);

      if (cacheKey) {
        scanCacheRef.current.set(cacheKey, {
          voxel: voxelMapped,
          minima: minimaMapped,
          overhang: overhangMapped,
          toppleCoverage: topple,
          dragTotalMm3: drag,
        });
      }
      mark('commit', commitStart);
    };

    try {
      // Yield immediately so React can flush the "scanning" state and show
      // the progress modal before we start expensive synchronous work.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (scanEpochRef.current !== epoch) return;

      const isTauri = hasTauriRuntime();
      let local: {
        positions: Float32Array;
        matrix: number[];
        center: [number, number, number];
      } | null = null;
      if (isTauri) {
        try {
          const prepStart = performance.now();
          local = prepareLocalGeom();
          mark('prep', prepStart);
        } catch (err) {
          console.warn('[Islands] local mesh prep failed', err);
        }
      }

      let usedNative = false;
      let mappedOverhangs: DetectedIsland[] = [];
      const overhangSelfSupportAngleDeg = getSettings().autoSupport?.overhangSelfSupportAngleDeg
        ?? OVERHANG_SELF_SUPPORT_ANGLE_DEG;

      // Primary Native Path: stage pre-TRS local soup + matrix/center so Rust welds
      // in pose-invariant local space before transforming.
      if (isTauri && local !== null) {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          const { listen } = await import('@tauri-apps/api/event');
          const unlisten = await listen<{ done: number; total: number }>(
            'island-scan-progress',
            (e) => {
              if (scanEpochRef.current !== epoch) return;
              setScanProgress({ done: e.payload.done, total: e.payload.total });
            },
          );
          try {
            if (scanEpochRef.current !== epoch) return;
            setScanProgress({ done: 0, total: 100 });

            const { positions } = local;
            const stageStart = performance.now();
            await invoke(
              'stage_mesh_binary_set',
              new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength),
              { headers: { 'Content-Type': 'application/octet-stream' } },
            );
            mark('stage', stageStart);
            if (scanEpochRef.current !== epoch) return;

            const scanStart = performance.now();
            const combined = await invoke<CombinedNativeScanResult>('scan_islands_staged', {
              layerHeightMm,
              pxMm,
              supportBufferMm: supportBufMm,
              connectivity,
              k: minimaK,
              overhangSelfSupportAngleDeg,
              overhangPxMm: OVERHANG_FOOTPRINT_PX_MM,
              hasRaft,
              matrix: local.matrix,
              center: local.center,
            });
            mark('scan', scanStart);
            if (scanEpochRef.current !== epoch) return;

            perf.path = 'native';
            commitCombinedResult(combined);
            usedNative = true;
          } finally {
            await unlisten();
          }
        } catch (err) {
          console.warn('[Islands] staged native scan failed; checking fallback', err);
        }
      }

      // Sideload Fallback Path: ONLY if local soup prep returned null while sourcePath exists
      if (!usedNative && isTauri && local === null && sourcePath && geom) {
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

          const unlisten = await listen<{ done: number; total: number }>(
            'island-scan-progress',
            (e) => {
              if (scanEpochRef.current !== epoch) return;
              setScanProgress({ done: e.payload.done, total: e.payload.total });
            },
          );
          try {
            if (scanEpochRef.current !== epoch) return;
            setScanProgress({ done: 0, total: 100 });

            console.log(`[Islands] Sideloading combined island scan from path: ${sourcePath}`);
            const scanStart = performance.now();
            const combined = await invoke<CombinedNativeScanResult>(
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
                overhangSelfSupportAngleDeg,
                overhangPxMm: OVERHANG_FOOTPRINT_PX_MM,
                overhangFromStaged: false,
                hasRaft,
              },
            );
            mark('scan', scanStart);
            if (scanEpochRef.current !== epoch) return;

            perf.path = 'sideload';
            commitCombinedResult(combined);
            usedNative = true;
          } finally {
            await unlisten();
          }
        } catch (err) {
          console.warn('[Islands] Sideloaded Rust scan failed', err);
        }
      }

      // Client Fallback Path
      let world: { positions: Float32Array; bbox: THREE.Box3 } | null = null;
      if (!usedNative) {
        try {
          world = prepareWorldGeom();
        } catch (err) {
          console.warn('[Islands] mesh prep failed', err);
        }
      }
      if (!usedNative && world !== null) {
        perf.path = 'client';
        const clientStart = performance.now();
        let topple = true;
        let drag = 0;

        if (isTauri) {
          try {
            const { invoke } = await import('@tauri-apps/api/core');
            const { positions } = world;
            await invoke(
              'stage_mesh_binary_set',
              new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength),
              { headers: { 'Content-Type': 'application/octet-stream' } },
            );
            if (scanEpochRef.current !== epoch) return;
            const scan = await invoke<OverhangScan>('scan_overhangs_staged', {
              selfSupportAngleDeg: overhangSelfSupportAngleDeg,
              pxMm: OVERHANG_FOOTPRINT_PX_MM,
              label: sourcePath ?? null,
              hasRaft,
            });
            if (scanEpochRef.current !== epoch) return;
            topple = scanNeedsCoverage(scan.stability);
            drag = scan.stability?.dragMomentMm3 ?? 0;
            mappedOverhangs = remapOverhangTriangleIds(
              scan.regions,
              geom?.geometry,
              transform,
            ).map(overhangRegionToIsland);
            setToppleCoverage(topple);
            setDragTotalMm3(drag);
            setOverhangIslands(mappedOverhangs);
          } catch (err) {
            console.warn('[Islands] overhang scan failed (non-fatal)', err);
            setToppleCoverage(true);
            setDragTotalMm3(0);
            setOverhangIslands([]);
          }
        } else {
          setToppleCoverage(true);
          setDragTotalMm3(0);
          setOverhangIslands([]);
        }

        if (scanEpochRef.current !== epoch) return;
        setScanProgress({
          done: 0,
          total: Math.max(1, Math.ceil((world.bbox.max.z - world.bbox.min.z) / layerHeightMm)),
        });

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

        let minima: DetectedIsland[] = [];
        try {
          minima = await scanMeshMinima(world.positions, minimaK);
        } catch (err) {
          console.error('[Islands] mesh-minima scan failed', err);
          minima = [];
        }
        if (scanEpochRef.current !== epoch) return;
        setMinimaIslands(minima);
        setHasScanned(true);
        if (cacheKey) {
          scanCacheRef.current.set(cacheKey, {
            voxel,
            minima,
            overhang: mappedOverhangs,
            toppleCoverage: topple,
            dragTotalMm3: drag,
          });
        }
        mark('scan', clientStart);
      }
    } finally {
      if (scanEpochRef.current === epoch) {
        setScanning(false);
        if (process.env.NODE_ENV !== 'production') {
          console.warn(
            `[IslandsPerf] path=${perf.path} prep=${perf.prep.toFixed(1)}ms stage=${perf.stage.toFixed(1)}ms `
            + `scan=${perf.scan.toFixed(1)}ms commit=${perf.commit.toFixed(1)}ms total=${(performance.now() - perf.start).toFixed(1)}ms`,
          );
        }
      }
    }
  }, [geom, transform, modelId, sourcePath, cacheKey, prepareLocalGeom, prepareWorldGeom, layerHeightMm, pxMm, supportBufMm, connectivity, minAreaMm2, minimaK, hasRaft]);

  // Pass 1: Proposed consolidation & classification
  const proposedConsolidated = useMemo(() => timed('proposedConsolidated', () => {
    if (!consolidateVoxel) return voxelIslands;
    return consolidateVoxelIslands(voxelIslands, consolidationDistance, pxMm, layerHeightMm);
  }), [voxelIslands, consolidateVoxel, consolidationDistance, pxMm, layerHeightMm]);

  const zBandMm = Math.max(2 * layerHeightMm, 0.10);

  const proposedClassified = useMemo(() => {
    return classifyIntersection(proposedConsolidated, minimaIslands, {
      xyToleranceMm: 0.5,
      zBandMm,
    });
  }, [proposedConsolidated, minimaIslands, zBandMm]);

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
      zBandMm,
    });
  }), [finalVoxelIslands, minimaIslands, zBandMm]);

  // Merge overhang regions into the classified set (dedupe + inclusion):
  // the mesh-normal classifier and the slice-growth detector flag the same
  // underside surface, so a voxel island substantially covered by an overhang
  // region is dropped in favor of the surface-accurate region. Overhang
  // islands then flow through annotation, filtering, the list, and
  // auto-support candidate generation.
  const mergedResult = useMemo(
    () => mergeOverhangResults(classifiedResult, overhangIslands, {
      voxelPxMm: pxMm,
      layerHeightMm,
      overhangPxMm: OVERHANG_FOOTPRINT_PX_MM,
    }),
    [classifiedResult, overhangIslands, pxMm, layerHeightMm],
  );

  const displayResult = showOverhangs ? mergedResult : classifiedResult;
  const allIslands = displayResult.islands;
  const stats = displayResult.stats;

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

    // Every declared contact, by its kind: a cone reports its profile
    // diameter, a disk its own.
    for (const descriptor of SUPPORT_TYPES) {
      const collection = (state as unknown as Record<string, Record<string, unknown> | undefined>)[descriptor.location.key];
      if (!collection) continue;

      for (const entity of Object.values(collection)) {
        const fields = entity as Record<string, unknown>;
        for (const contact of contactEndpointsFor(descriptor.id)) {
          const primitive = fields[contact.field];
          if (contact.kind === 'disk') processDisk(primitive);
          else processCone(primitive);
        }
      }
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

  const overhangContactGrid = useMemo(
    () => (!showOverhangs && overhangIslands.length > 0 ? buildIslandContactGrid(overhangIslands) : null),
    [showOverhangs, overhangIslands],
  );

  const tableStats = useMemo(() => {
    const voxelItems = annotatedIslands.filter((i) => i.class === 'voxelOnly' && i.source === 'voxel');
    const voxelTotal = voxelItems.length;
    const voxelUnsupported = voxelItems.filter((i) => !i.grounded && !isIslandEffectivelySupported(i)).length;

    const geomItems = annotatedIslands.filter((i) => i.class === 'minimaOnly' && i.source === 'minima');
    const geomTotal = geomItems.length;
    const geomUnsupported = geomItems.filter((i) => !i.grounded && !isIslandEffectivelySupported(i)).length;

    const coincidentItems = annotatedIslands.filter((i) => i.class === 'intersection' && i.source === 'voxel');
    const coincidentTotal = coincidentItems.length;
    const coincidentUnsupported = coincidentItems.filter((i) => !i.grounded && !isIslandEffectivelySupported(i)).length;

    const overhangAnnotated = showOverhangs
      ? annotatedIslands.filter((i) => i.source === 'overhang')
      : overhangContactGrid
        ? annotateAndCountSupports(overhangIslands, overhangContactGrid, mappedSupportTips, plateZ, areaPerSupport, layerHeightMm)
        : [];
    const overhangTotal = overhangAnnotated.length;
    const overhangUnsupported = overhangAnnotated.filter((i) => !i.grounded && !isIslandEffectivelySupported(i)).length;

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
      overhangTotal,
      overhangUnsupported,
    };
  }, [annotatedIslands, showOverhangs, overhangContactGrid, overhangIslands, mappedSupportTips, plateZ, areaPerSupport, layerHeightMm]);

  const filterOptions = useMemo<IslandFilterOptions>(
    () => ({ contouredIds, consolidateVoxel, removeSupportedAreaClusters }),
    [contouredIds, consolidateVoxel, removeSupportedAreaClusters],
  );

  const filteredIslands = useMemo(() => {
    return applyFilter(annotatedIslands.map((i) => ({ ...i })), filterToggles, filterOptions);
  }, [annotatedIslands, filterToggles, filterOptions]);

  const displayedIslands = useMemo(() => {
    return filteredIslands.filter((island) => {
      if (island.source === 'overhang') return false;
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
      return false;
    });
  }, [filteredIslands, showVoxelOnly, showMinimaOnly, showIntersection]);

  // Sort by ascending baseZ (with deterministic tie-breakers) for predictable prev/next navigation.
  const orderedIslands = useMemo(() => sortIslandsByBaseZ(displayedIslands), [displayedIslands]);

  // Per-source pucks for the IslandOverlay layers (blue voxel-only / green minima-only / red intersection),
  // derived strictly from filteredIslands so navigation, byMarkerId, and 3D stay in 1:1 sync.
  const voxelOnlyPucks = useMemo(
    () => buildIslandPucks(
      showVoxelOnly
        ? filteredIslands.filter((i) => i.source === 'voxel' && i.class === 'voxelOnly')
        : [],
    ),
    [filteredIslands, showVoxelOnly],
  );
  const minimaOnlyPucks = useMemo(
    () => buildIslandPucks(
      showMinimaOnly
        ? filteredIslands.filter((i) => i.source === 'minima' && i.class === 'minimaOnly')
        : [],
    ),
    [filteredIslands, showMinimaOnly],
  );
  const intersectionPucks = useMemo(
    () => buildIslandPucks(
      showIntersection
        ? filteredIslands.filter((i) => i.source === 'voxel' && i.class === 'intersection')
        : [],
    ),
    [filteredIslands, showIntersection],
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

  // One entry per visible island, shared by the marker list (selection, camera
  // focus) and the instance buffer (rendering) so the two cannot drift apart.
  const islandVisuals = useMemo(() => timed('islandVisuals', () => {
    const footprintVisuals: IslandVisual[] = [];
    const pinVisuals: IslandVisual[] = [];

    voxelOnlyPucks.markers.forEach(m => {
      const island = voxelOnlyPucks.byMarkerId.get(m.id);
      const area = island?.areaMm2 ?? 0;
      const radius = scaleMarkersWithArea && area > 0 ? Math.max(0.1, Math.sqrt(area / Math.PI)) : 0.1;

      footprintVisuals.push({
        markerId: m.id,
        type: resolveVoxelVisualType(island, consolidateVoxel, contouredIds),
        centerX: m.centerX,
        centerY: m.centerY,
        baseZ: m.baseZ,
        radius,
        footprint: island?.contactVoxels ?? null,
      });
    });

    minimaOnlyPucks.markers.forEach(m => {
      pinVisuals.push({
        markerId: m.id,
        type: 1,
        centerX: m.centerX,
        centerY: m.centerY,
        baseZ: m.baseZ,
        radius: 0.1,
        footprint: null,
      });
    });

    intersectionPucks.markers.forEach(m => {
      const island = intersectionPucks.byMarkerId.get(m.id);
      const area = island?.areaMm2 ?? 0;
      const radius = scaleMarkersWithArea && area > 0 ? Math.max(0.1, Math.sqrt(area / Math.PI)) : 0.1;

      // 1. Voxel footprint (type 0 default, or type 3 when consolidated/contoured)
      if (showVoxelOnly) {
        footprintVisuals.push({
          markerId: m.id,
          type: resolveVoxelVisualType(island, consolidateVoxel, contouredIds),
          centerX: m.centerX,
          centerY: m.centerY,
          baseZ: m.baseZ,
          radius,
          footprint: island?.contactVoxels ?? null,
        });
      }

      // 2. Primary coincident red pin
      pinVisuals.push({
        markerId: m.id,
        type: 2,
        centerX: m.centerX,
        centerY: m.centerY,
        baseZ: m.baseZ,
        radius: 0.1,
        footprint: null,
      });

      // 3. Spaced sub-apex red pins for clustered/large intersection islands
      if (island?.subApexes?.length && (consolidateVoxel || contouredIds.has(island.id) || area >= 0.06)) {
        const spacedSubApexes = selectSpacedSubApexes(
          { x: m.centerX, y: m.centerY, z: m.baseZ },
          island.subApexes,
          0.8,
        );
        for (const ap of spacedSubApexes) {
          pinVisuals.push({
            markerId: m.id,
            type: 2,
            centerX: ap.x,
            centerY: ap.y,
            baseZ: ap.z,
            radius: 0.1,
            footprint: null,
          });
        }
      }
    });

    return [...footprintVisuals, ...pinVisuals];
  }), [
    voxelOnlyPucks,
    minimaOnlyPucks,
    intersectionPucks,
    consolidateVoxel,
    contouredIds,
    scaleMarkersWithArea,
    showVoxelOnly,
  ]);

  const islandMarkers = useMemo<IslandMarker[]>(() => timed('islandMarkers', () => {
    const seen = new Set<number>();
    const markers: IslandMarker[] = [];
    for (const v of islandVisuals) {
      if (seen.has(v.markerId)) continue;
      seen.add(v.markerId);
      markers.push({
        id: v.markerId,
        islandId: v.markerId,
        type: v.type,
        centerX: v.centerX,
        centerY: v.centerY,
        baseZ: v.baseZ,
        pixelCount: 1,
        radius: v.radius,
      });
    }
    return markers;
  }), [islandVisuals]);

  const islandInstances = useMemo(
    () => timed('islandInstances', () => buildIslandInstances(islandVisuals, pxMm * VOXEL_DISC_RADIUS_FACTOR, layerHeightMm)),
    [islandVisuals, pxMm, layerHeightMm],
  );

  // Structural auto-support contract (E.2): decoupled from display/cluster UI
  // toggles (consolidate, contour, removeSupportedAreaClusters, showOverhangs,
  // layer visibility, and filterToggles).
  const structuralMergedIslands = useMemo(() => {
    if (!consolidateVoxel && showOverhangs) return null;
    const rawClassified = consolidateVoxel
      ? classifyIntersection(voxelIslands, minimaIslands, { xyToleranceMm: 0.5, zBandMm })
      : classifiedResult;
    return mergeOverhangResults(rawClassified, overhangIslands, {
      voxelPxMm: pxMm,
      layerHeightMm,
      overhangPxMm: OVERHANG_FOOTPRINT_PX_MM,
    }).islands;
  }, [consolidateVoxel, showOverhangs, voxelIslands, minimaIslands, zBandMm, classifiedResult, overhangIslands, pxMm, layerHeightMm]);

  const structuralContactGrid = useMemo(
    () => (structuralMergedIslands ? buildIslandContactGrid(structuralMergedIslands) : null),
    [structuralMergedIslands],
  );

  const structuralIslands = useMemo(() => {
    if (!consolidateVoxel && showOverhangs) {
      return applyFilter(annotatedIslands.map((i) => ({ ...i })), DEFAULT_FILTER_TOGGLES);
    }
    const annotated = annotateAndCountSupports(
      structuralMergedIslands!,
      structuralContactGrid!,
      mappedSupportTips,
      plateZ,
      areaPerSupport,
      layerHeightMm,
    );
    return applyFilter(annotated, DEFAULT_FILTER_TOGGLES);
  }, [
    consolidateVoxel,
    showOverhangs,
    annotatedIslands,
    structuralMergedIslands,
    structuralContactGrid,
    mappedSupportTips,
    plateZ,
    areaPerSupport,
    layerHeightMm,
  ]);

  const clear = useCallback(() => {
    setVoxelIslands([]);
    setMinimaIslands([]);
    setOverhangIslands([]);
    setHasScanned(false);
    setToppleCoverage(true);
    setDragTotalMm3(0);
    setSelectedMarkerId(null);
  }, []);

  // Per-model scan cache: (modelId/sourcePath + geometry uuid + transform signature) → CachedScan.
  const scanCacheRef = useRef<Map<string, CachedScan>>(new Map());
  const prevCacheKeyRef = useRef<string | null | undefined>(undefined);
  // Bumped on every cacheKey change; an in-flight scan captures the
  // epoch and discards its results if the model or transform changed while it ran.
  const scanEpochRef = useRef(0);

  // Unified restore/invalidate effect keyed on cacheKey (modelId + geometry.uuid + transform).
  useEffect(() => {
    const prev = prevCacheKeyRef.current;
    if (prev === undefined) {
      prevCacheKeyRef.current = cacheKey;
      const cached = cacheKey ? scanCacheRef.current.get(cacheKey) : undefined;
      if (cached) {
        setVoxelIslands(cached.voxel);
        setMinimaIslands(cached.minima);
        setOverhangIslands(cached.overhang);
        setHasScanned(true);
        setToppleCoverage(cached.toppleCoverage);
        setDragTotalMm3(cached.dragTotalMm3);
        setSelectedMarkerId(null);
      }
      return;
    }

    if (prev !== cacheKey) {
      prevCacheKeyRef.current = cacheKey;
      scanEpochRef.current += 1;
      setScanning(false);
      setScanProgress(null);

      const cached = cacheKey ? scanCacheRef.current.get(cacheKey) : undefined;
      if (cached) {
        setVoxelIslands(cached.voxel);
        setMinimaIslands(cached.minima);
        setOverhangIslands(cached.overhang);
        setHasScanned(true);
        setToppleCoverage(cached.toppleCoverage);
        setDragTotalMm3(cached.dragTotalMm3);
        setSelectedMarkerId(null);
      } else {
        clear();
      }
    }
  }, [cacheKey, clear]);

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
    setDraftConnectivity(8);
    setDraftConsolidateVoxel(false);
    setDraftConsolidationDistance(0.2);
    setDraftReduceIntersection(false);
    setDraftIntersectionThreshold(0.5);
    setDraftScaleMarkersWithArea(true);
    setDraftEnableContourRegions(true);
    setDraftMaxContourRegions(20);
    setDraftRemoveSupportedAreaClusters(false);
    setDraftAreaPerSupport(4.0);
    setDraftMinAreaMm2(0.02);
    setDraftMinimaK(2);
  }, []);

  return {
    scanning,
    hasScanned,
    poseKey: cacheKey,
    scanProgress,
    elapsedLabel,
    voxelIslands,
    minimaIslands,
    overhangIslands,
    toppleCoverage,
    dragTotalMm3,
    filteredIslands,
    orderedIslands,
    structuralIslands,
    voxelOnlyPucks,
    minimaOnlyPucks,
    intersectionPucks,
    islandMarkers,
    islandInstances,
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
    advancedMode,
    setAdvancedMode,
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
  };
}

function dilateVoxelGrid(
  voxels: VoxelFootprint,
  pxMm: number,
  consolidationDistance: number,
  fallbackZ?: number,
): VoxelFootprint {
  if (voxels.count === 0 || pxMm <= 0) return voxels;

  const anchorX = footprintX(voxels, 0);
  const anchorY = footprintY(voxels, 0);
  const preserveZ = voxels.z !== null || fallbackZ !== undefined;

  const cellMinZ = new Map<number | string, number>();
  const originalCoords: { ix: number; iy: number; key: number | string }[] = [];

  for (let i = 0; i < voxels.count; i++) {
    const ix = Math.round((footprintX(voxels, i) - anchorX) / pxMm);
    const iy = Math.round((footprintY(voxels, i) - anchorY) / pxMm);
    const key = gridBucketKey(ix, iy);
    const vz = preserveZ ? (footprintZ(voxels, i) ?? fallbackZ ?? 0) : 0;
    const prevZ = cellMinZ.get(key);
    if (prevZ === undefined) {
      cellMinZ.set(key, vz);
      originalCoords.push({ ix, iy, key });
    } else if (preserveZ && vz < prevZ) {
      cellMinZ.set(key, vz);
    }
  }

  const rPix = Math.max(1, Math.round(consolidationDistance / (2 * pxMm)));
  const offsets: { dx: number; dy: number }[] = [];
  for (let dx = -rPix; dx <= rPix; dx++) {
    for (let dy = -rPix; dy <= rPix; dy++) {
      if (dx * dx + dy * dy <= rPix * rPix) {
        offsets.push({ dx, dy });
      }
    }
  }

  const dilatedMinZ = new Map<number | string, number>();
  const dilatedCells: { nix: number; niy: number; key: number | string }[] = [];

  for (const coord of originalCoords) {
    const coordZ = cellMinZ.get(coord.key)!;
    for (const offset of offsets) {
      const nix = coord.ix + offset.dx;
      const niy = coord.iy + offset.dy;
      const nkey = gridBucketKey(nix, niy);
      const prev = dilatedMinZ.get(nkey);
      if (prev === undefined) {
        dilatedMinZ.set(nkey, coordZ);
        dilatedCells.push({ nix, niy, key: nkey });
      } else if (preserveZ && coordZ < prev) {
        dilatedMinZ.set(nkey, coordZ);
      }
    }
  }

  const dilatedVoxels = new VoxelFootprintBuilder(dilatedCells.length, preserveZ);
  for (const cell of dilatedCells) {
    dilatedVoxels.push(
      anchorX + cell.nix * pxMm,
      anchorY + cell.niy * pxMm,
      preserveZ ? dilatedMinZ.get(cell.key) : undefined,
    );
  }

  return dilatedVoxels.build();
}

export function consolidateVoxelIslands(
  islands: DetectedIsland[],
  epsilonMm: number,
  pxMm: number,
  layerHeightMm = 0.05,
): DetectedIsland[] {
  const n = islands.length;
  if (n === 0) return [];

  const minAreaForContour = 0.06; // mm² (resolution-invariant)

  if (n === 1) {
    return [{ ...islands[0], members: [{ ...islands[0] }] }];
  }

  const eps2 = epsilonMm * epsilonMm;
  const zTol = 2 * layerHeightMm + 1e-6;
  const maxSpanMm = Math.max(epsilonMm, 3 * epsilonMm);

  const parent = Array.from({ length: n }, (_, i) => i);
  const minX = new Float64Array(n);
  const maxX = new Float64Array(n);
  const minY = new Float64Array(n);
  const maxY = new Float64Array(n);
  const minZ = new Float64Array(n);
  const maxZ = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const isl = islands[i];
    minX[i] = maxX[i] = isl.contact.x;
    minY[i] = maxY[i] = isl.contact.y;
    minZ[i] = maxZ[i] = isl.baseZ;
  }

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

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(islands[i].baseZ - islands[j].baseZ) > zTol) continue;
      if (islands[i].contact.distanceToSquared(islands[j].contact) > eps2) continue;
      const ri = find(i);
      const rj = find(j);
      if (ri === rj) continue;
      const mMinX = Math.min(minX[ri], minX[rj]);
      const mMaxX = Math.max(maxX[ri], maxX[rj]);
      const mMinY = Math.min(minY[ri], minY[rj]);
      const mMaxY = Math.max(maxY[ri], maxY[rj]);
      const mMinZ = Math.min(minZ[ri], minZ[rj]);
      const mMaxZ = Math.max(maxZ[ri], maxZ[rj]);
      if (
        (mMaxZ - mMinZ) <= zTol &&
        (mMaxX - mMinX) <= maxSpanMm &&
        (mMaxY - mMinY) <= maxSpanMm
      ) {
        parent[ri] = rj;
        minX[rj] = mMinX;
        maxX[rj] = mMaxX;
        minY[rj] = mMinY;
        maxY[rj] = mMaxY;
        minZ[rj] = mMinZ;
        maxZ[rj] = mMaxZ;
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

    if (members.length >= 2 && hasCluster) {
      members.sort((a, b) => a.baseZ - b.baseZ);
      const lowest = members[0];

      let totalArea = 0;
      let totalVoxels = 0;
      let minFirstLayer = Infinity;
      let maxLastLayer = -Infinity;
      for (const m of members) {
        totalArea += m.areaMm2 ?? 0;
        if (m.layerSpan) {
          minFirstLayer = Math.min(minFirstLayer, m.layerSpan[0]);
          maxLastLayer = Math.max(maxLastLayer, m.layerSpan[1]);
        }
        if (m.contactVoxels) {
          totalVoxels += m.contactVoxels.count;
        }
      }

      let dilatedVoxels: VoxelFootprint | undefined;
      if (totalVoxels > 0) {
        const mergedBuilder = new VoxelFootprintBuilder(totalVoxels, true);
        for (const m of members) {
          const fp = m.contactVoxels;
          if (!fp || fp.count === 0) continue;
          for (let k = 0; k < fp.count; k++) {
            mergedBuilder.push(
              footprintX(fp, k),
              footprintY(fp, k),
              footprintZ(fp, k) ?? m.baseZ,
            );
          }
        }
        const mergedFootprint = mergedBuilder.build();
        if (mergedFootprint.count > 0) {
          dilatedVoxels = dilateVoxelGrid(mergedFootprint, pxMm, epsilonMm, lowest.baseZ);
        }
      }

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

const ISLAND_SOURCE_RANK: Record<DetectedIsland['source'], number> = {
  voxel: 0,
  minima: 1,
  overhang: 2,
};

export function selectSpacedSubApexes(
  primary: { x: number; y: number; z: number },
  subApexes: ReadonlyArray<{ x: number; y: number; z: number }> | undefined,
  minSpacingMm = 0.8,
): Array<{ x: number; y: number; z: number }> {
  if (!subApexes || subApexes.length === 0) return [];
  const accepted: Array<{ x: number; y: number; z: number }> = [];
  if (Number.isFinite(primary.x) && Number.isFinite(primary.y) && Number.isFinite(primary.z)) {
    accepted.push(primary);
  }
  const safeSpacing = Number.isFinite(minSpacingMm) ? Math.max(0, minSpacingMm) : 0.8;
  const minD2 = safeSpacing * safeSpacing;
  const selected: Array<{ x: number; y: number; z: number }> = [];

  for (const ap of subApexes) {
    if (!Number.isFinite(ap.x) || !Number.isFinite(ap.y) || !Number.isFinite(ap.z)) continue;
    let nearestD2 = Infinity;
    for (const prev of accepted) {
      const dx = ap.x - prev.x;
      const dy = ap.y - prev.y;
      const dz = ap.z - prev.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < nearestD2) nearestD2 = d2;
    }
    if (nearestD2 >= minD2) {
      accepted.push(ap);
      selected.push(ap);
    }
  }

  return selected;
}

export function sortIslandsByBaseZ(islands: readonly DetectedIsland[]): DetectedIsland[] {
  return [...islands].sort((a, b) => {
    const aZ = Number.isFinite(a.baseZ) ? a.baseZ : a.contact.z;
    const bZ = Number.isFinite(b.baseZ) ? b.baseZ : b.contact.z;
    const aFin = Number.isFinite(aZ);
    const bFin = Number.isFinite(bZ);
    if (aFin && bFin) {
      if (aZ !== bZ) return aZ - bZ;
    } else if (aFin !== bFin) {
      return aFin ? -1 : 1;
    }

    const srcDiff = (ISLAND_SOURCE_RANK[a.source] ?? 3) - (ISLAND_SOURCE_RANK[b.source] ?? 3);
    if (srcDiff !== 0) return srcDiff;

    const aNum = parseInt(a.id.replace(/^\D+/, ''), 10) || 0;
    const bNum = parseInt(b.id.replace(/^\D+/, ''), 10) || 0;
    if (aNum !== bNum) return aNum - bNum;

    return a.id.localeCompare(b.id);
  });
}
