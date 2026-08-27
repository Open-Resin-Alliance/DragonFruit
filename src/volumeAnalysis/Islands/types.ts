import type { VoxelFootprint } from './voxelFootprint';
import type * as THREE from 'three';

/**
 * Unified island model for the Support-tab "Islands" panel (PoC).
 *
 * Two detectors feed this shape — the rebuilt voxel/slice scanner (`detect.ts`)
 * and the mesh-minima scanner (`useMeshMinima.ts`). All coordinates are in
 * world / build-plate space (Z-up, millimetres) so both detectors, the
 * intersection step, and the camera math share a single frame.
 */

/** Which detector produced an island. */
export type IslandSource = 'voxel' | 'minima' | 'overhang';

/**
 * Wire shape of the `scan_overhangs` Tauri command (mesh-normal overhang
 * classification — catches shallow slopes the slice-growth detector cannot).
 */
export interface FootprintMask {
  width: number;
  height: number;
  /** World XY of the mask's top-left pixel center (mm). */
  originX: number;
  originY: number;
  pxMm: number;
  /** Row-major pixels (1 = inside the projected region). */
  data: number[];
  /** Row-major surface Z (mm) on the region's own triangles (parallel to data). */
  surfaceZ: number[];
}

export interface OverhangRegion {
  triangleIds: number[];
  areaMm2: number;
  projectedAreaMm2: number;
  angleDeg: number;
  /** Area-weighted mean face normal (world space, points away from the model). */
  normal: [number, number, number];
  xyMin: [number, number];
  xyMax: [number, number];
  minZ: number;
  maxZ: number;
  footprint: FootprintMask;
}

/** Classification once the voxel and minima sets are intersected (Part C). */
export type IslandClass = 'intersection' | 'voxelOnly' | 'minimaOnly';

export interface DetectedIsland {
  /** Stable unique id across sources, e.g. "v12" (voxel) or "m7" (minima). */
  id: string;
  source: IslandSource;
  /**
   * Representative contact point — the lowest-Z point of the unsupported
   * region (voxel) or the minimum vertex (minima), in world mm.
   */
  contact: THREE.Vector3;
  /** Z-ordering sort key, equal to `contact.z` (world mm). */
  baseZ: number;

  // --- voxel-detector extras (undefined for minima) ---
  /** Contact footprint area at the island's base layer (mm^2). */
  areaMm2?: number;
  // --- overhang-detector extras (undefined for others) ---
  /** Mean surface angle from horizontal (degrees) — set by the overhang detector. */
  overhangAngleDeg?: number;
  /** Model-triangle indices of the overhang region (for surface highlighting). */
  triangleIds?: number[];
  /** Region mean surface normal (world space, away from the model) — lets the
   *  placement pipeline skip whole-mesh raycasts that hit the wrong face on
   *  sloped geometry. */
  surfaceNormal?: { x: number; y: number; z: number };
  /** Inclusive [firstLayer, lastLayer] of the unsupported contact region. */
  layerSpan?: readonly [number, number];
  /** Contact voxel 2D positions (x, y coordinates in world mm) at the base layer.
   *  Overhang regions also carry the surface Z at each voxel. */
  contactVoxels?: VoxelFootprint;

  // --- minima-detector extras (undefined for voxel) ---
  /** Source mesh vertex index. */
  vertexIndex?: number;
  /** Seed triangle id. */
  seedTriangleId?: number;

  // --- filtering flags (set by `filtering.ts`, default-ON filter) ---
  /** Contact is within `SUPPORTED_RADIUS_MM` of an existing support tip. */
  supported?: boolean;
  /** Contact sits on the build-plate plane. */
  grounded?: boolean;

  // --- classification + grouping (set by `intersection.ts` / `ordering.ts`) ---
  /** Id of the matched island from the other detector, or null if none. */
  matchedWith?: string | null;
  class?: IslandClass;
  /** Cluster-walk grouping index. */
  clusterId?: number;

  // --- support analysis (set by hook for area retention logic) ---
  supportCount?: number;
  fullySupported?: boolean;
  members?: DetectedIsland[];
}

export interface TipInfo {
  pos: THREE.Vector3;
  diameterMm: number;
}

/**
 * Default proximity (mm) for the "already supported" dedupe. Applies to both
 * detectors; mirrors the alt-branch Support Painter minima filter. Tunable in
 * the advanced modal.
 */
export const SUPPORTED_RADIUS_MM = 0.3;
