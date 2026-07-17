import * as THREE from 'three';
import type { HollowReport } from '@/utils/meshHollowing';

export type HollowPreviewState = {
  modelId: string;
  geometry: THREE.BufferGeometry;
  infillGeometry: THREE.BufferGeometry | null;
  removedVoxelCenters: Float32Array;
  removedVoxelIndices: Uint32Array;
  blockedVoxelCenters?: Float32Array;
  /** Grid indices Rust actually accepted for the blocked centers, in lockstep
   *  with blockedVoxelCenters. Downstream positional mappings consume this
   *  instead of the committed array, so a stale/dropped index never desyncs. */
  blockedVoxelIndices?: Uint32Array;
  /** The committed blocked set this preview was computed FROM — used to gate
   *  the quiet resync so a newer in-flight request can't be clobbered. */
  requestedBlockedVoxelIndices?: readonly number[];
  report: HollowReport;
  previewKey: string;
  /** When true, the geometry is the original source mesh and the cavity
   *  should be visualized as spheres at removedVoxelCenters instead. */
  previewVoxelSpheres?: boolean;
};

export type HollowPreviewCacheEntry = {
  modelId: string;
  report: HollowReport;
  positions: Float32Array;
  infillPositions?: Float32Array;
  removedVoxelCenters?: Float32Array;
  removedVoxelIndices?: Uint32Array;
  blockedVoxelCenters?: Float32Array;
  blockedVoxelIndices?: Uint32Array;
  requestedBlockedVoxelIndices?: readonly number[];
  previewGeometry?: THREE.BufferGeometry | null;
  infillGeometry?: THREE.BufferGeometry | null;
};

export type HollowingSourceEntry = {
  geometry: THREE.BufferGeometry;
};

/** Stores the per-model interior cavity surface mesh for Interior View Mode. */
export type CavityGeometryEntry = {
  geometry: THREE.BufferGeometry;
};
